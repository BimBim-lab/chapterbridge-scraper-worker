import { createClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const env = getEnv();
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function bulkScrapeSegments() {
  // Get edition_id from command line arguments
  const args = process.argv.slice(2);
  const editionIdIndex = args.indexOf('--editionId');
  const workIdIndex = args.indexOf('--workId');
  const templateIndex = args.indexOf('--template');
  
  let editionId: string;
  let template = 'manhwaz-chapter'; // default
  
  if (templateIndex !== -1 && args[templateIndex + 1]) {
    template = args[templateIndex + 1];
  }
  
  if (editionIdIndex !== -1 && args[editionIdIndex + 1]) {
    editionId = args[editionIdIndex + 1];
  } else if (workIdIndex !== -1 && args[workIdIndex + 1]) {
    // Get edition from work
    const workId = args[workIdIndex + 1];
    console.log(`Fetching edition for work: ${workId}`);
    
    const { data: edition, error } = await supabase
      .from('editions')
      .select('id')
      .eq('work_id', workId)
      .single();
    
    if (error || !edition) {
      console.error('Error fetching edition:', error);
      console.error('Usage: npx tsx src/scripts/bulk-scrape-segments.ts --editionId <id> [--template <name>]');
      console.error('   OR: npx tsx src/scripts/bulk-scrape-segments.ts --workId <id> [--template <name>]');
      process.exit(1);
    }
    
    editionId = edition.id;
  } else {
    console.error('Missing required argument!');
    console.error('Usage: npx tsx src/scripts/bulk-scrape-segments.ts --editionId <id> [--template <name>]');
    console.error('   OR: npx tsx src/scripts/bulk-scrape-segments.ts --workId <id> [--template <name>]');
    process.exit(1);
  }
  
  console.log(`Edition ID: ${editionId}`);
  console.log(`Template: ${template}`);
  console.log('\nFetching all segments for edition...');
  
  // Get all segments ordered by number
  const { data: segments, error } = await supabase
    .from('segments')
    .select('id, number, title, canonical_url')
    .eq('edition_id', editionId)
    .order('number', { ascending: true });

  if (error) {
    console.error('Error fetching segments:', error);
    process.exit(1);
  }

  if (!segments || segments.length === 0) {
    console.log('No segments found');
    process.exit(0);
  }

  console.log(`Found ${segments.length} segments`);
  
  // Check which segments already have assets
  // Query segments that have at least 1 asset (more reliable than checking segment_assets)
  const { data: segmentsWithAssets, error: assetsError } = await supabase
    .from('segments')
    .select('id, segment_assets(segment_id)')
    .eq('edition_id', editionId);
  
  if (assetsError) {
    console.error('Error checking existing assets:', assetsError);
  }
  
  // Filter segments that have at least one asset
  const completedSegmentIds = new Set(
    segmentsWithAssets
      ?.filter(s => s.segment_assets && s.segment_assets.length > 0)
      .map(s => s.id) || []
  );
  
  const pendingSegments = segments.filter(s => !completedSegmentIds.has(s.id));

  console.log(`Already completed: ${completedSegmentIds.size}`);
  console.log(`Pending: ${pendingSegments.length}`);
  
  if (pendingSegments.length === 0) {
    console.log('All segments already scraped!');
    process.exit(0);
  }

  console.log('\nStarting bulk scrape...');
  console.log(`Will process ${pendingSegments.length} chapters\n`);

  let successCount = 0;
  let failureCount = 0;
  const failures: Array<{ segment: any, error: string }> = [];

  for (let i = 0; i < pendingSegments.length; i++) {
    const segment = pendingSegments[i];
    const progress = `[${i + 1}/${pendingSegments.length}]`;
    
    console.log(`\n${progress} Processing: ${segment.title}`);
    console.log(`  URL: ${segment.canonical_url}`);
    
    try {
      const command = `npx tsx src/cli.ts scrape:segment --url "${segment.canonical_url}" --segmentId "${segment.id}" --template "${template}" --download`;
      
      execSync(command, {
        cwd: process.cwd(),
        stdio: 'inherit',
        encoding: 'utf8'
      });
      
      successCount++;
      console.log(`  ✓ Success`);
      
      // Add delay between chapters to be respectful
      if (i < pendingSegments.length - 1) {
        const delay = 3000 + Math.random() * 2000; // 3-5 seconds
        console.log(`  Waiting ${Math.round(delay/1000)}s before next chapter...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
    } catch (error: any) {
      failureCount++;
      const errorMsg = error.message || String(error);
      failures.push({ segment, error: errorMsg });
      console.error(`  ✗ Failed: ${errorMsg}`);
      
      // Continue with next segment
      continue;
    }
  }

  console.log('\n\n=== BULK SCRAPE COMPLETED ===');
  console.log(`Total processed: ${pendingSegments.length}`);
  console.log(`Successful: ${successCount}`);
  console.log(`Failed: ${failureCount}`);

  if (failures.length > 0) {
    console.log('\n=== FAILURES ===');
    failures.forEach(({ segment, error }) => {
      console.log(`${segment.title} (${segment.canonical_url})`);
      console.log(`  Error: ${error}\n`);
    });
  }
}

bulkScrapeSegments().catch(console.error);
