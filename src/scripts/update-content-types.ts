import { createClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

const env = getEnv();
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

interface Asset {
  id: string;
  r2_key: string;
  content_type: string | null;
}

/**
 * Detect content type from filename/r2_key
 */
function detectContentTypeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  
  // Check file extension
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return 'text/html';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lower.endsWith('.srt')) {
    return 'text/plain';
  }
  if (lower.endsWith('.vtt')) {
    return 'text/vtt';
  }
  if (lower.endsWith('.ass') || lower.endsWith('.ssa')) {
    return 'text/x-ssa';
  }
  if (lower.endsWith('.sub')) {
    return 'text/plain';
  }
  if (lower.endsWith('.json')) {
    return 'application/json';
  }
  
  return 'application/octet-stream';
}

async function updateContentTypes(dryRun: boolean = false) {
  logger.info({ dryRun }, 'Starting content type update');

  // Get all assets with NULL or empty content_type (with pagination)
  let allAssets: Asset[] = [];
  let page = 0;
  const pageSize = 1000;
  
  console.log('📥 Fetching assets from database...');
  
  while (true) {
    const { data: assets, error } = await supabase
      .from('assets')
      .select('id, r2_key, content_type')
      .or('content_type.is.null,content_type.eq.')
      .order('created_at', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      logger.error({ error }, 'Failed to fetch assets');
      throw new Error(`Failed to fetch assets: ${error.message}`);
    }

    if (!assets || assets.length === 0) {
      break;
    }

    allAssets = allAssets.concat(assets);
    page++;
    
    console.log(`   Fetched ${allAssets.length} assets...`);
    
    if (assets.length < pageSize) {
      break; // Last page
    }
  }

  if (allAssets.length === 0) {
    logger.info('No assets found with missing content_type');
    console.log('✅ All assets already have content_type set');
    return;
  }

  logger.info({ count: allAssets.length }, 'Found assets with missing content_type');
  console.log(`📊 Found ${allAssets.length} assets with missing content_type\n`);

  const updates: { id: string; r2_key: string; oldType: string | null; newType: string }[] = [];
  const contentTypeCounts: Record<string, number> = {};

  // Process each asset
  for (const asset of allAssets) {
    const newContentType = detectContentTypeFromFilename(asset.r2_key);
    
    updates.push({
      id: asset.id,
      r2_key: asset.r2_key,
      oldType: asset.content_type,
      newType: newContentType,
    });

    contentTypeCounts[newContentType] = (contentTypeCounts[newContentType] || 0) + 1;
  }

  // Show summary
  console.log('📋 Content Type Distribution:');
  for (const [contentType, count] of Object.entries(contentTypeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${contentType.padEnd(30)} : ${count}`);
  }
  console.log('');

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
    console.log('Sample updates (first 10):');
    for (const update of updates.slice(0, 10)) {
      console.log(`   ${update.id.substring(0, 8)}... : ${update.newType}`);
      console.log(`      ${update.r2_key}`);
    }
    console.log('');
    logger.info({ totalUpdates: updates.length }, 'Dry run completed');
    return;
  }

  // Perform updates in batches
  console.log('🔄 Updating content types...\n');
  const batchSize = 100;
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    
    // Update each asset in the batch
    for (const update of batch) {
      const { error: updateError } = await supabase
        .from('assets')
        .update({ content_type: update.newType })
        .eq('id', update.id);

      if (updateError) {
        logger.error({ 
          assetId: update.id, 
          r2Key: update.r2_key, 
          error: updateError 
        }, 'Failed to update asset');
        errorCount++;
      } else {
        successCount++;
      }
    }

    const progress = Math.min(i + batchSize, updates.length);
    console.log(`   Progress: ${progress}/${updates.length} (${Math.round(progress / updates.length * 100)}%)`);
  }

  console.log('');
  logger.info({ successCount, errorCount }, 'Content type update completed');
  console.log(`✅ Successfully updated ${successCount} assets`);
  if (errorCount > 0) {
    console.log(`⚠️  Failed to update ${errorCount} assets`);
  }
}

// Main execution
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-d');

updateContentTypes(dryRun)
  .then(() => {
    console.log('\n✨ Done!');
    process.exit(0);
  })
  .catch((error) => {
    logger.error({ error }, 'Fatal error');
    console.error('❌ Fatal error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
