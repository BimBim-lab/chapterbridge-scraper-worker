import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createClient } from '@supabase/supabase-js';
import { getEnv } from '../../config/env.js';
import { uploadToR2 } from '../../services/r2.js';
import { computeSha256 } from '../../utils/hash.js';
import * as cheerio from 'cheerio';
import { 
  createJob, 
  updateJobStatus,
  type CreateJobParams 
} from '../../services/supabase.js';

// Add stealth plugin
chromium.use(StealthPlugin());

const env = getEnv();
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Retry utility function
async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    delay?: number;
    backoff?: boolean;
    onRetry?: (error: Error, attempt: number) => void;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    delay = 2000,
    backoff = true,
    onRetry
  } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === maxRetries) {
        throw lastError;
      }

      const waitTime = backoff ? delay * attempt : delay;
      
      if (onRetry) {
        onRetry(lastError, attempt);
      }
      
      console.log(`⚠️  Attempt ${attempt} failed, retrying in ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw lastError!;
}

interface ChapterAPIResponse {
  id: number;
  index: number;
  title: string;
  novSlugChapSlug: string;
  timeAdded: string;
  content?: string;
}

async function fetchChapterContent(chapterUrl: string): Promise<{ title: string; contentHtml: string; plainText: string; wordCount: number }> {
  return retry(
    async () => {
      console.log(`🌐 Launching browser...`);
      const browser = await chromium.launch({ 
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });
      
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York'
      });
      
      const page = await context.newPage();
      
      // Anti-detection scripts
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
        });
      });

      try {
        console.log(`📖 Navigating to: ${chapterUrl}`);
        
        await page.goto(chapterUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: 60000 
        });

        // Wait longer for React to hydrate and content to load
        await page.waitForTimeout(5000);

        // Wait for content to load
        try {
          await page.waitForSelector('[id*="chapter"], [class*="chapter"], [class*="content"], main, article', { timeout: 15000 });
        } catch (e) {
          console.log('⚠️  Content selector timeout, continuing...');
        }

        // Additional wait for dynamic content
        await page.waitForTimeout(2000);

        // Get the page content
        const html = await page.content();
        const $ = cheerio.load(html);

        // Try multiple selectors for title
        let title = '';
        const titleSelectors = ['h1', 'h2', '[class*="title"]', '[class*="Title"]', '[class*="chapter"]'];
        for (const selector of titleSelectors) {
          const titleText = $(selector).first().text().trim();
          if (titleText && titleText.length > 0 && titleText.length < 200 && !titleText.includes('ReadNovelEU') && !titleText.includes('You Might Also Like')) {
            title = titleText;
            break;
          }
        }

        // Get all text content from body
        const bodyText = $('body').text();
        
        // Try multiple patterns to extract content
        let plainText = '';
        
        // Pattern 1: Content between "Part X:" and footer
        const partMatch = bodyText.match(/Part \d+:.*?(?=You Might Also Like|ReadNovelEU|Report chapter|Next Chapter|$)/s);
        if (partMatch) {
          plainText = partMatch[0].trim();
        }
        
        // Pattern 2: Content between chapter number and footer
        if (!plainText || plainText.length < 100) {
          const chapterMatch = bodyText.match(/(?:Chapter|CH)\s+\d+[:\s]*(.*?)(?=You Might Also Like|ReadNovelEU|Report chapter|Next Chapter|$)/s);
          if (chapterMatch && chapterMatch[1]) {
            plainText = chapterMatch[1].trim();
          }
        }
        
        // Pattern 3: Get main/article content directly
        if (!plainText || plainText.length < 100) {
          const mainContent = $('main, article, [role="main"], [id*="content"], [class*="content"]')
            .first()
            .clone()
            .find('script, style, nav, header, footer, [class*="comment"], [class*="related"]')
            .remove()
            .end()
            .text()
            .trim();
          
          if (mainContent.length > 200) {
            plainText = mainContent;
          }
        }
        
        // Pattern 4: Fallback - extract large text blocks from page
        if (!plainText || plainText.length < 100) {
          const textBlocks: string[] = [];
          $('p, div').each((_, elem) => {
            const text = $(elem).text().trim();
            if (text.length > 50 && !text.includes('ReadNovelEU') && !text.includes('You Might Also Like')) {
              textBlocks.push(text);
            }
          });
          
          if (textBlocks.length > 0) {
            plainText = textBlocks.join('\n\n');
          }
        }

        if (!plainText || plainText.length < 100) {
          console.log('⚠️  Content found:', plainText.substring(0, 200));
          throw new Error('Could not find content on page (extracted: ' + plainText.length + ' chars)');
        }

        // Convert plain text to HTML with paragraphs
        const contentHtml = plainText
          .split(/\n\n+/) // Split by double newlines
          .filter(para => para.trim().length > 0)
          .map(para => `<p>${para.trim().replace(/\n/g, '<br>')}</p>`)
          .join('\n');

        // Count words
        const wordCount = plainText.split(/\s+/).filter(w => w.length > 0).length;

        console.log(`✅ Scraped ${wordCount} words`);

        return {
          title: title || 'Untitled',
          contentHtml,
          plainText,
          wordCount
        };

      } finally {
        await context.close();
        await browser.close();
      }
    },
    {
      maxRetries: 3,
      delay: 3000,
      backoff: true,
      onRetry: (error, attempt) => {
        console.log(`   ⚠️  Browser scraping failed (attempt ${attempt}): ${error.message}`);
      }
    }
  );
}

function convertToHTML(title: string, contentHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: serif; line-height: 1.67; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { font-size: 1.3em; color: #111; margin-bottom: 1.5em; }
    p { margin-bottom: 1em; text-align: justify; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <main id="content">
    ${contentHtml}
  </main>
</body>
</html>`;
}

async function uploadChapterToR2(htmlContent: string, filename: string) {
  return retry(
    async () => {
      const buffer = Buffer.from(htmlContent, 'utf-8');
      const sha256 = computeSha256(buffer);
      const contentType = 'text/html; charset=utf-8';

      console.log(`☁️  Uploading to R2: ${filename}`);
      const r2Key = await uploadToR2(filename, buffer, contentType);

      return { r2Key, sha256, bytes: buffer.length };
    },
    {
      maxRetries: 3,
      delay: 2000,
      backoff: true,
      onRetry: (error, attempt) => {
        console.log(`   ⚠️  R2 upload failed (attempt ${attempt}): ${error.message}`);
      }
    }
  );
}

async function createAsset(r2Key: string, sha256: string, bytes: number) {
  return retry(
    async () => {
      // Check if asset with same SHA256 already exists
      const { data: existingAsset } = await supabase
        .from('assets')
        .select('id')
        .eq('sha256', sha256)
        .single();

      if (existingAsset) {
        console.log(`♻️  Asset with same content already exists: ${existingAsset.id}`);
        return existingAsset;
      }

      const { data: asset, error } = await supabase
        .from('assets')
        .insert({
          provider: 'cloudflare_r2',
          bucket: env.CLOUDFLARE_R2_BUCKET,
          r2_key: r2Key,
          asset_type: 'cleaned_text',
          content_type: 'text/html',
          bytes: bytes,
          sha256: sha256,
          upload_source: 'pipeline'
        })
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to create asset: ${error.message}`);
      }

      return asset;
    },
    {
      maxRetries: 3,
      delay: 1500,
      backoff: true,
      onRetry: (error, attempt) => {
        console.log(`   ⚠️  Database insert failed (attempt ${attempt}): ${error.message}`);
      }
    }
  );
}

async function linkAssetToSegment(segmentId: string, assetId: string) {
  return retry(
    async () => {
      const { error } = await supabase
        .from('segment_assets')
        .insert({
          segment_id: segmentId,
          asset_id: assetId,
          role: 'content'
        });

      if (error && !error.message.includes('duplicate')) {
        throw new Error(`Failed to link asset to segment: ${error.message}`);
      }
    },
    {
      maxRetries: 3,
      delay: 1500,
      backoff: true,
      onRetry: (error, attempt) => {
        console.log(`   ⚠️  Asset linking failed (attempt ${attempt}): ${error.message}`);
      }
    }
  );
}

async function processSegment(
  segmentId: string, 
  segmentNumber: number, 
  segmentTitle: string,
  chapterUrl: string,
  workId: string,
  editionId: string
) {
  console.log(`\n📄 Processing Chapter ${segmentNumber}...`);
  console.log(`   Segment ID: ${segmentId}`);
  console.log(`   URL: ${chapterUrl}`);

  try {
    // Check if segment already has assets
    const { data: existingAssets } = await supabase
      .from('segment_assets')
      .select('asset_id')
      .eq('segment_id', segmentId);

    if (existingAssets && existingAssets.length > 0) {
      console.log(`⏭️  Chapter ${segmentNumber} already has assets, skipping`);
      return { success: true, skipped: true };
    }

    // Fetch chapter content via browser
    const content = await fetchChapterContent(chapterUrl);

    if (!content.plainText || content.plainText.length < 100) {
      throw new Error('Content too short or empty');
    }

    console.log(`✅ Scraped ${content.wordCount} words`);
    console.log(`   Title: ${content.title}`);

    // Convert to HTML
    const htmlContent = convertToHTML(content.title || segmentTitle, content.contentHtml || '');

    // Sanitize title for filename (remove special chars, replace spaces with dashes)
    const sanitizedTitle = segmentTitle
      .replace(/[<>:"/\\|?*]/g, '') // Remove invalid chars
      .replace(/\s+/g, '-') // Replace spaces with dashes
      .replace(/--+/g, '-') // Replace multiple dashes with single
      .replace(/^-|-$/g, '') // Remove leading/trailing dashes
      .toLowerCase();

    // Generate R2 key following the pattern: raw/novel/{work_id}/{edition_id}/number-{0001}/{title}.html
    const numberPadded = segmentNumber.toString().padStart(4, '0');
    const r2Key = `raw/novel/${workId}/${editionId}/number-${numberPadded}/${sanitizedTitle}.html`;

    // Upload to R2
    const { r2Key: uploadedKey, sha256, bytes } = await uploadChapterToR2(htmlContent, r2Key);

    // Create asset
    const asset = await createAsset(uploadedKey, sha256, bytes);
    console.log(`✅ Asset created: ${asset.id}`);

    // Link asset to segment
    await linkAssetToSegment(segmentId, asset.id);
    console.log(`✅ Asset linked to segment`);

    return { success: true, assetId: asset.id };

  } catch (error) {
    console.error(`❌ Error processing chapter ${segmentNumber}:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function main() {
  let jobId: string | null = null;
  
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: node dist/scripts/scrape-readnovel-segment.js <segment_id> [<segment_id> ...]');
    console.error('');
    console.error('Examples:');
    console.error('  # Single segment');
    console.error('  node dist/scripts/scrape-readnovel-segment.js "uuid-here"');
    console.error('');
    console.error('  # Multiple segments');
    console.error('  node dist/scripts/scrape-readnovel-segment.js "uuid-1" "uuid-2" "uuid-3"');
    console.error('');
    console.error('  # All segments from edition');
    console.error('  node dist/scripts/scrape-readnovel-segment.js --edition "edition-uuid"');
    process.exit(1);
  }

  let segmentIds: string[] = [];

  // Check if --edition flag is used
  if (args[0] === '--edition') {
    if (args.length < 2) {
      console.error('Error: --edition requires an edition UUID');
      process.exit(1);
    }

    const editionId = args[1];
    console.log(`🔍 Fetching all segments for edition: ${editionId}`);

    const { data: segments, error } = await supabase
      .from('segments')
      .select('id')
      .eq('edition_id', editionId)
      .order('number', { ascending: true });

    if (error) {
      console.error(`❌ Error fetching segments: ${error.message}`);
      process.exit(1);
    }

    if (!segments || segments.length === 0) {
      console.error('❌ No segments found for this edition');
      process.exit(1);
    }

    console.log(`📊 Total segments: ${segments.length}`);

    // Check which segments already have assets
    console.log(`🔍 Checking for already completed segments...`);
    const { data: segmentsWithAssets, error: assetsError } = await supabase
      .from('segments')
      .select('id, segment_assets(segment_id)')
      .eq('edition_id', editionId);
    
    if (assetsError) {
      console.warn('⚠️  Error checking existing assets:', assetsError.message);
    }
    
    // Filter segments that have at least one asset
    const completedSegmentIds = new Set(
      segmentsWithAssets
        ?.filter(s => s.segment_assets && s.segment_assets.length > 0)
        .map(s => s.id) || []
    );
    
    const pendingSegments = segments.filter(s => !completedSegmentIds.has(s.id));

    console.log(`✅ Already completed: ${completedSegmentIds.size}`);
    console.log(`⏳ Pending: ${pendingSegments.length}`);

    segmentIds = pendingSegments.map(s => s.id);
    
    if (segmentIds.length === 0) {
      console.log('🎉 All segments already completed!');
      process.exit(0);
    }

    console.log(`✅ Will process ${segmentIds.length} pending segments`);
  } else {
    segmentIds = args;
  }

  console.log('🚀 Starting ReadNovel segment scraper...');
  console.log(`📚 Processing ${segmentIds.length} segment(s)\n`);

  try {
    // Create pipeline job
    jobId = await createJob({
      jobType: 'scrape',
      input: {
        segmentIds,
        scriptType: 'scrape-readnovel-segment',
        totalSegments: segmentIds.length,
      }
    });
    console.log(`📋 Created pipeline job: ${jobId}`);
    await updateJobStatus(jobId, 'running');
  } catch (error) {
    console.error('⚠️  Failed to create job, continuing without tracking:', error);
  }

  const results = {
    success: 0,
    skipped: 0,
    failed: 0,
    errors: [] as Array<{ segmentId: string; error: string }>
  };

  for (const segmentId of segmentIds) {
    try {
      // Fetch segment details
      const { data: segment, error: segmentError } = await supabase
        .from('segments')
        .select(`
          id,
          number,
          title,
          canonical_url,
          edition:editions!inner(
            id,
            work_id
          )
        `)
        .eq('id', segmentId)
        .single();

      if (segmentError || !segment) {
        throw new Error(`Segment not found: ${segmentId}`);
      }

      const edition = segment.edition as any;
      const workId = edition.work_id;
      const editionId = edition.id;

      // Update job with work_id and edition_id on first segment
      if (jobId && results.success === 0 && results.failed === 0 && results.skipped === 0) {
        try {
          await supabase
            .from('pipeline_jobs')
            .update({ 
              work_id: workId,
              edition_id: editionId 
            })
            .eq('id', jobId);
        } catch (error) {
          console.error('⚠️  Failed to update job with IDs:', error);
        }
      }

      // Extract chapter slug from URL
      // URL format: https://readnovel.eu/chapter/solo-leveling-1
      const url = segment.canonical_url;
      if (!url) {
        throw new Error('Segment has no canonical_url');
      }

      const result = await processSegment(
        segment.id,
        Number(segment.number),
        segment.title || `Chapter ${segment.number}`,
        url, // Pass full URL instead of slug
        workId,
        editionId
      );

      if (result.skipped) {
        results.skipped++;
      } else if (result.success) {
        results.success++;
      } else {
        results.failed++;
        results.errors.push({
          segmentId,
          error: result.error || 'Unknown error'
        });
      }

      // Add delay between requests to be nice to the API
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      console.error(`❌ Error processing segment ${segmentId}:`, error);
      results.failed++;
      results.errors.push({
        segmentId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 Scraping Summary');
  console.log('='.repeat(60));
  console.log(`✅ Successfully processed: ${results.success}`);
  console.log(`⏭️  Skipped (already exists): ${results.skipped}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`📝 Total segments: ${segmentIds.length}`);

  if (results.errors.length > 0) {
    console.log('\n❌ Errors:');
    results.errors.forEach(({ segmentId, error }) => {
      console.log(`   - ${segmentId}: ${error}`);
    });
  }

  // Update job status
  if (jobId) {
    try {
      if (results.failed > 0) {
        await updateJobStatus(jobId, 'failed', {
          totalSegments: segmentIds.length,
          success: results.success,
          skipped: results.skipped,
          failed: results.failed,
        }, results.errors.length > 0 ? results.errors[0].error : 'Some segments failed');
      } else {
        await updateJobStatus(jobId, 'success', {
          totalSegments: segmentIds.length,
          success: results.success,
          skipped: results.skipped,
          failed: results.failed,
        });
      }
    } catch (error) {
      console.error('⚠️  Failed to update job status:', error);
    }
  }

  console.log('\n✅ Done!');
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
