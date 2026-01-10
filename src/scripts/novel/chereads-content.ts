import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { getEnv } from '../../config/env.js';
import { ChereadsExtractor } from '../../extractors/chereads.js';
import { uploadToR2 } from '../../services/r2.js';
import { computeSha256 } from '../../utils/hash.js';
import fs from 'fs/promises';
import path from 'path';
import { 
  createJob, 
  updateJobStatus,
  type CreateJobParams 
} from '../../services/supabase.js';

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

async function loadTemplate() {
  const templatePath = path.join(process.cwd(), 'templates', 'chereads.json');
  const templateContent = await fs.readFile(templatePath, 'utf-8');
  return JSON.parse(templateContent);
}

async function scrapeChapterContent(url: string, extractor: ChereadsExtractor) {
  return retry(
    async () => {
      console.log('🌐 Launching browser...');
      const browser = await chromium.launch({ 
        headless: true,
        args: ['--disable-blink-features=AutomationControlled']
      });
      
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
      });
      
      const page = await context.newPage();

      try {
        console.log(`📖 Navigating to: ${url}`);
        
        // Retry navigation with timeout
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // Add delay to let page settle
        await page.waitForTimeout(2000);

        const result = await extractor.scrapeChapterContentPage(page);

        if (!result.success) {
          throw new Error(result.error || 'Failed to extract content');
        }

        return result.data!;

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
        console.log(`   ⚠️  Navigation failed (attempt ${attempt}): ${error.message}`);
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
  url: string, 
  extractor: ChereadsExtractor,
  workId: string,
  editionId: string
) {
  console.log(`\n📄 Processing Chapter ${segmentNumber}...`);
  console.log(`   Segment ID: ${segmentId}`);
  console.log(`   URL: ${url}`);

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

    // Scrape chapter content
    const content = await scrapeChapterContent(url, extractor);

    if (!content.plainText || content.plainText.length < 100) {
      throw new Error('Content too short or empty');
    }

    console.log(`✅ Scraped ${content.wordCount} words`);
    console.log(`   Title: ${content.title}`);

    // Convert to HTML
    const htmlContent = convertToHTML(content.title || 'Untitled', content.contentHtml || '');

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
  
  // Parse arguments
  const editionIdArg = args.find(arg => arg.startsWith('--editionId='));
  const startArg = args.find(arg => arg.startsWith('--start='));
  const endArg = args.find(arg => arg.startsWith('--end='));
  const delayArg = args.find(arg => arg.startsWith('--delay='));

  if (!editionIdArg) {
    console.error('❌ Usage: npx tsx src/scripts/scrape-chereads-segment.ts --editionId=<uuid> [--start=1] [--end=10] [--delay=2000]');
    console.error('Example: npx tsx src/scripts/scrape-chereads-segment.ts --editionId="abc-123" --start=1 --end=50 --delay=3000');
    process.exit(1);
  }

  const editionId = editionIdArg.split('=')[1];
  const startChapter = startArg ? parseInt(startArg.split('=')[1]) : 1;
  const endChapter = endArg ? parseInt(endArg.split('=')[1]) : 999999;
  const delay = delayArg ? parseInt(delayArg.split('=')[1]) : 2000;

  console.log('🚀 Starting Chereads segment scraping...');
  console.log(`   Edition ID: ${editionId}`);
  console.log(`   Chapter range: ${startChapter} - ${endChapter}`);
  console.log(`   Delay: ${delay}ms`);

  try {
    // Load template
    console.log('\n📋 Loading template...');
    const template = await loadTemplate();
    const extractor = new ChereadsExtractor(template);
    console.log('✅ Template loaded');

    // Fetch edition to get work_id
    console.log('\n🔍 Fetching edition info...');
    const { data: edition, error: editionError } = await supabase
      .from('editions')
      .select('id, work_id')
      .eq('id', editionId)
      .single();

    if (editionError || !edition) {
      throw new Error(`Failed to fetch edition: ${editionError?.message || 'Edition not found'}`);
    }

    const workId = edition.work_id;
    console.log(`✅ Work ID: ${workId}`);

    // Create pipeline job
    jobId = await createJob({
      jobType: 'scrape',
      workId: workId,
      editionId: editionId,
      input: {
        startChapter,
        endChapter,
        delay,
        scriptType: 'scrape-chereads-segment',
      }
    });
    console.log(`📋 Created pipeline job: ${jobId}`);
    await updateJobStatus(jobId, 'running');

    // Fetch segments
    console.log('\n🔍 Fetching segments from database...');
    const { data: segments, error } = await supabase
      .from('segments')
      .select('id, number, title, canonical_url')
      .eq('edition_id', editionId)
      .gte('number', startChapter)
      .lte('number', endChapter)
      .order('number', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch segments: ${error.message}`);
    }

    if (!segments || segments.length === 0) {
      console.log('⚠️  No segments found in the specified range');
      return;
    }

    console.log(`✅ Found ${segments.length} segments to process`);

    // Process segments
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];

      if (!segment.canonical_url) {
        console.log(`⏭️  Chapter ${segment.number} has no URL, skipping`);
        skipCount++;
        continue;
      }

      // Add delay before processing each segment
      if (i > 0) {
        console.log(`⏳ Waiting ${delay}ms before next chapter...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const result = await processSegment(
        segment.id,
        segment.number,
        segment.title,
        segment.canonical_url,
        extractor,
        workId,
        editionId
      );

      if (result.skipped) {
        skipCount++;
      } else if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    }

    console.log('\n📊 Summary:');
    console.log(`   ✅ Successfully processed: ${successCount}`);
    console.log(`   ⏭️  Skipped: ${skipCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);
    console.log('\n✨ Scraping completed!');

    // Update job status to success
    if (jobId) {
      await updateJobStatus(jobId, 'success', {
        totalSegments: segments.length,
        success: successCount,
        skipped: skipCount,
        errors: errorCount,
      });
    }

  } catch (error) {
    console.error('\n❌ Error during scraping process:', error);
    
    // Update job status to failed
    if (jobId) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await updateJobStatus(jobId, 'failed', undefined, errorMsg);
    }
    
    process.exit(1);
  }
}

main();
