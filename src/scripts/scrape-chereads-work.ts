import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';
import { ChereadsExtractor } from '../extractors/chereads.js';
import type { ChapterInfo } from '../extractors/types.js';
import fs from 'fs/promises';
import path from 'path';

const env = getEnv();
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Retry utility function
async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    delay?: number;
    backoff?: boolean;
  } = {}
): Promise<T> {
  const { maxRetries = 3, delay = 3000, backoff = true } = options;
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
      console.log(`⚠️  Attempt ${attempt} failed, retrying in ${waitTime}ms...`);
      console.log(`   Error: ${lastError.message}`);
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

async function scrapeChapters(url: string, extractor: ChereadsExtractor): Promise<ChapterInfo[]> {
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
        extraHTTPHeaders: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0'
        }
      });
      
      const page = await context.newPage();

      try {
        console.log(`📖 Navigating to: ${url}`);
        
        // Set longer timeout and use domcontentloaded
        await page.goto(url, { 
          waitUntil: 'domcontentloaded',
          timeout: 60000 
        });
        
        // Wait a bit for dynamic content
        await page.waitForTimeout(3000);
        
        // Try to wait for chapter list, but don't fail if not found
        try {
          await page.waitForSelector('ul.ChapterItems_list__kW9Em', { timeout: 10000 });
          console.log('✅ Chapter list found');
        } catch (e) {
          console.log('⚠️  Chapter list selector not found, trying to extract anyway...');
        }

        const chapters = await extractor.scrapeChapterListPage(page);
        
        if (chapters.length === 0) {
          throw new Error('No chapters found on page');
        }
        
        console.log(`✅ Found ${chapters.length} chapters`);
        return chapters;

      } finally {
        await context.close();
        await browser.close();
      }
    },
    {
      maxRetries: 3,
      delay: 5000,
      backoff: true
    }
  );
}

async function getOrCreateWork(workId: string, title: string) {
  console.log(`\n📚 Checking work: ${workId}`);
  
  const { data: existingWork } = await supabase
    .from('works')
    .select('id, title')
    .eq('id', workId)
    .single();

  if (existingWork) {
    console.log(`✅ Work already exists: ${existingWork.title}`);
    return existingWork;
  }

  console.log(`📝 Creating new work: ${title}`);
  const { data: newWork, error } = await supabase
    .from('works')
    .insert({ id: workId, title })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create work: ${error.message}`);
  }

  console.log(`✅ Work created: ${newWork.title}`);
  return newWork;
}

async function getOrCreateEdition(workId: string, provider: string, canonicalUrl: string) {
  console.log(`\n📖 Checking edition for work: ${workId}`);
  
  const { data: existingEdition } = await supabase
    .from('editions')
    .select('id')
    .eq('work_id', workId)
    .eq('media_type', 'novel')
    .eq('provider', provider)
    .single();

  if (existingEdition) {
    console.log(`✅ Edition already exists: ${existingEdition.id}`);
    return existingEdition;
  }

  console.log(`📝 Creating new edition for ${provider}`);
  const { data: newEdition, error } = await supabase
    .from('editions')
    .insert({
      work_id: workId,
      media_type: 'novel',
      provider: provider,
      canonical_url: canonicalUrl,
      is_official: false
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create edition: ${error.message}`);
  }

  console.log(`✅ Edition created: ${newEdition.id}`);
  return newEdition;
}

async function createSegments(editionId: string, chapters: ChapterInfo[]) {
  console.log(`\n📑 Creating/Updating segments for edition: ${editionId}`);
  console.log(`Total chapters to process: ${chapters.length}`);

  let successCount = 0;
  let updateCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const chapter of chapters) {
    try {
      // Check if segment already exists
      const { data: existingSegment } = await supabase
        .from('segments')
        .select('id, canonical_url')
        .eq('edition_id', editionId)
        .eq('segment_type', 'chapter')
        .eq('number', chapter.number)
        .single();

      if (existingSegment) {
        // Update existing segment if URL is different
        if (existingSegment.canonical_url !== chapter.url) {
          const { error: updateError } = await supabase
            .from('segments')
            .update({
              title: chapter.title,
              canonical_url: chapter.url
            })
            .eq('id', existingSegment.id);

          if (updateError) {
            console.error(`❌ Error updating chapter ${chapter.number}: ${updateError.message}`);
            errorCount++;
          } else {
            console.log(`🔄 Chapter ${chapter.number}: ${chapter.title} (updated URL)`);
            updateCount++;
          }
        } else {
          console.log(`⏭️  Chapter ${chapter.number}: Already correct, skipping`);
          skipCount++;
        }
        continue;
      }

      // Insert new segment
      const { error } = await supabase
        .from('segments')
        .insert({
          edition_id: editionId,
          segment_type: 'chapter',
          number: chapter.number,
          title: chapter.title,
          canonical_url: chapter.url
        });

      if (error) {
        console.error(`❌ Error inserting chapter ${chapter.number}: ${error.message}`);
        errorCount++;
      } else {
        console.log(`✅ Chapter ${chapter.number}: ${chapter.title}`);
        successCount++;
      }
    } catch (err) {
      console.error(`❌ Exception processing chapter ${chapter.number}:`, err);
      errorCount++;
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   ✅ Successfully inserted: ${successCount}`);
  console.log(`   🔄 Updated: ${updateCount}`);
  console.log(`   ⏭️  Skipped (already correct): ${skipCount}`);
  console.log(`   ❌ Errors: ${errorCount}`);
}

async function main() {
  const args = process.argv.slice(2);
  
  // Parse arguments
  const urlArg = args.find(arg => arg.startsWith('--url='));
  const workIdArg = args.find(arg => arg.startsWith('--workId='));
  const titleArg = args.find(arg => arg.startsWith('--title='));

  if (!urlArg || !workIdArg) {
    console.error('❌ Usage: npx tsx src/scripts/scrape-chereads-work.ts --url=<chapter-list-url> --workId=<uuid> [--title=<work-title>]');
    console.error('Example: npx tsx src/scripts/scrape-chereads-work.ts --url="https://www.chereads.com/chapterlist/34048845808168505/" --workId="5c36ee25-e4ff-4e49-ac89-302ae715e596" --title="The Beginning After The End"');
    process.exit(1);
  }

  const url = urlArg.split('=')[1];
  const workId = workIdArg.split('=')[1];
  const title = titleArg ? titleArg.split('=')[1] : 'Unknown Title';

  console.log('🚀 Starting Chereads scraping process...');
  console.log(`   URL: ${url}`);
  console.log(`   Work ID: ${workId}`);
  console.log(`   Title: ${title}`);

  try {
    // Load template
    console.log('📋 Loading template...');
    const template = await loadTemplate();
    const extractor = new ChereadsExtractor(template);
    console.log('✅ Template loaded successfully');

    // Validate URL
    if (!ChereadsExtractor.isValidUrl(url)) {
      throw new Error('Invalid chereads.com URL');
    }

    // Step 1: Scrape chapter list
    const chapters = await scrapeChapters(url, extractor);

    if (chapters.length === 0) {
      console.log('⚠️  No chapters found. Exiting.');
      return;
    }

    // Step 2: Get or create work
    const work = await getOrCreateWork(workId, title);

    // Step 3: Get or create edition
    const edition = await getOrCreateEdition(work.id, 'chereads', url);

    // Step 4: Create segments
    await createSegments(edition.id, chapters);

    console.log('\n✨ Scraping completed successfully!');

  } catch (error) {
    console.error('\n❌ Error during scraping process:', error);
    process.exit(1);
  }
}

main();
