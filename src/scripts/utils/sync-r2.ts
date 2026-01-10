import { createClient } from '@supabase/supabase-js';
import { getEnv } from '../../config/env.js';
import { listR2Objects, downloadFromR2 } from '../../services/r2.js';
import { insertAsset, attachAssetToSegment, upsertSegment } from '../../services/supabase.js';
import { computeSha256 } from '../../utils/hash.js';
import { logger } from '../../utils/logger.js';

const env = getEnv();
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

interface ParsedR2Key {
  media: string;
  workId: string;
  editionId: string;
  segmentType: string;
  segmentNumber: number;
  filename: string;
  fullKey: string;
}

/**
 * Parse R2 key pattern: raw/{media}/{workId}/{editionId}/chapter-{number}/{filename}
 * or: raw/{media}/{workId}/{editionId}/episode-{number}/{filename}
 */
function parseR2Key(key: string): ParsedR2Key | null {
  // Pattern for manhwa: raw/manhwa/26d092ff-0a1e-486e-bdb6-bc149c5df33d/4832e095-c52d-4774-96e0-7a071f56c2db/chapter-111/page-001.jpg
  // Pattern for anime: raw/anime/5c36ee25-e4ff-4e49-ac89-302ae715e596/9e5738e6-ad17-4439-bbc3-c68afd52cf4f/episode-1/subtitle.srt
  const pattern = /^raw\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(chapter|episode)-(\d+)\/(.+)$/;
  const match = key.match(pattern);

  if (!match) {
    return null;
  }

  return {
    media: match[1],
    workId: match[2],
    editionId: match[3],
    segmentType: match[4],
    segmentNumber: parseInt(match[5], 10),
    filename: match[6],
    fullKey: key,
  };
}

/**
 * Get asset type from filename
 */
function getAssetType(filename: string): string {
  if (filename.endsWith('.html') || filename.endsWith('.htm')) {
    return 'raw_html';
  }
  if (filename.endsWith('.jpg') || filename.endsWith('.jpeg') || filename.endsWith('.png') || filename.endsWith('.webp')) {
    return 'raw_image';
  }
  if (filename.endsWith('.srt') || filename.endsWith('.vtt')) {
    return 'raw_subtitle';
  }
  return 'other';
}

/**
 * Get content type from filename
 */
function getContentType(filename: string): string {
  if (filename.endsWith('.html') || filename.endsWith('.htm')) {
    return 'text/html';
  }
  if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (filename.endsWith('.png')) {
    return 'image/png';
  }
  if (filename.endsWith('.webp')) {
    return 'image/webp';
  }
  if (filename.endsWith('.gif')) {
    return 'image/gif';
  }
  if (filename.endsWith('.srt')) {
    return 'text/plain';
  }
  if (filename.endsWith('.vtt')) {
    return 'text/vtt';
  }
  if (filename.endsWith('.ass')) {
    return 'text/x-ssa';
  }
  if (filename.endsWith('.json')) {
    return 'application/json';
  }
  return 'application/octet-stream';
}

/**
 * Check if asset already exists in database by r2_key
 */
async function assetExists(r2Key: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('assets')
    .select('id')
    .eq('r2_key', r2Key)
    .maybeSingle();

  if (error) {
    logger.error({ error, r2Key }, 'Error checking asset existence');
    return null;
  }

  return data?.id || null;
}

/**
 * Check if segment exists, if not create it
 */
async function ensureSegmentExists(
  editionId: string,
  segmentNumber: number,
  segmentType: string
): Promise<string | null> {
  // Check if segment exists
  const { data: existing, error: fetchError } = await supabase
    .from('segments')
    .select('id')
    .eq('edition_id', editionId)
    .eq('number', segmentNumber)
    .eq('segment_type', segmentType)
    .maybeSingle();

  if (fetchError) {
    logger.error({ error: fetchError, editionId, segmentNumber }, 'Error checking segment');
    return null;
  }

  if (existing) {
    return existing.id;
  }

  // Create segment if it doesn't exist
  logger.warn({ editionId, segmentNumber, segmentType }, 'Segment not found, creating placeholder');
  
  const { data: created, error: createError } = await supabase
    .from('segments')
    .insert({
      edition_id: editionId,
      segment_type: segmentType,
      number: segmentNumber,
      title: `${segmentType.charAt(0).toUpperCase() + segmentType.slice(1)} ${segmentNumber}`,
      canonical_url: null,
    })
    .select('id')
    .single();

  if (createError) {
    logger.error({ error: createError, editionId, segmentNumber }, 'Error creating segment');
    return null;
  }

  return created.id;
}

/**
 * Sync a single R2 object to database
 */
async function syncR2Object(key: string, dryRun: boolean = false): Promise<boolean> {
  const parsed = parseR2Key(key);
  
  if (!parsed) {
    logger.debug({ key }, 'Skipping non-segment file');
    return false;
  }

  // Check if asset already exists
  const existingAssetId = await assetExists(parsed.fullKey);
  if (existingAssetId) {
    logger.debug({ key, assetId: existingAssetId }, 'Asset already in database');
    return false;
  }

  logger.info({ key }, 'Syncing R2 object');

  if (dryRun) {
    logger.info({ key }, '[DRY RUN] Would sync this file');
    return true;
  }

  try {
    // Download file to calculate hash and size
    const buffer = await downloadFromR2(parsed.fullKey);
    const sha256 = computeSha256(buffer);
    const bytes = buffer.length;

    // Ensure segment exists
    const segmentId = await ensureSegmentExists(
      parsed.editionId,
      parsed.segmentNumber,
      parsed.segmentType
    );

    if (!segmentId) {
      logger.error({ key }, 'Failed to ensure segment exists');
      return false;
    }

    // Create asset record
    const assetType = getAssetType(parsed.filename);
    const contentType = getContentType(parsed.filename);
    
    const assetId = await insertAsset(
      parsed.fullKey,
      assetType,
      bytes,
      sha256,
      'manual', // Since this is a sync operation
      contentType
    );

    if (!assetId) {
      logger.error({ key }, 'Failed to create asset - insertAsset returned null');
      return false;
    }

    // Attach asset to segment
    const role = parsed.filename.includes('page-') 
      ? 'page' 
      : (parsed.filename.endsWith('.srt') || parsed.filename.endsWith('.vtt'))
      ? 'subtitle'
      : undefined;
    const attached = await attachAssetToSegment(segmentId, assetId, role);

    if (!attached) {
      logger.error({ key, assetId, segmentId }, 'Failed to attach asset to segment');
      return false;
    }

    logger.info({ key, assetId, segmentId }, 'Successfully synced R2 object');
    
    // Verify asset was actually created in database
    const verified = await assetExists(parsed.fullKey);
    if (!verified) {
      logger.error({ key, assetId }, 'Asset not found after insert - possible transaction issue');
      return false;
    }
    
    return true;
  } catch (error) {
    logger.error({ error, key }, 'Failed to sync R2 object');
    return false;
  }
}

/**
 * Main sync function
 */
async function syncR2Assets() {
  const args = process.argv.slice(2);
  
  const workIdIndex = args.indexOf('--workId');
  const editionIdIndex = args.indexOf('--editionId');
  const dryRunIndex = args.indexOf('--dry-run');
  const prefixIndex = args.indexOf('--prefix');
  
  const dryRun = dryRunIndex !== -1;
  
  let prefix: string;
  
  if (prefixIndex !== -1 && args[prefixIndex + 1]) {
    prefix = args[prefixIndex + 1];
  } else if (workIdIndex !== -1 && args[workIdIndex + 1]) {
    const workId = args[workIdIndex + 1];
    prefix = `raw/manhwa/${workId}/`;
  } else if (editionIdIndex !== -1 && args[editionIdIndex + 1]) {
    // Get edition to find work_id
    const editionId = args[editionIdIndex + 1];
    const { data: edition, error } = await supabase
      .from('editions')
      .select('work_id, media_type')
      .eq('id', editionId)
      .single();
    
    if (error || !edition) {
      console.error('Error fetching edition:', error);
      process.exit(1);
    }
    
    prefix = `raw/${edition.media_type}/${edition.work_id}/${editionId}/`;
  } else {
    console.error('Missing required argument!');
    console.error('Usage: npx tsx src/scripts/sync-r2-assets.ts --workId <id> [--dry-run]');
    console.error('   OR: npx tsx src/scripts/sync-r2-assets.ts --editionId <id> [--dry-run]');
    console.error('   OR: npx tsx src/scripts/sync-r2-assets.ts --prefix <path> [--dry-run]');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Sync R2 Assets to Supabase`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Prefix: ${prefix}`);
  console.log(`Dry Run: ${dryRun ? 'YES' : 'NO'}`);
  console.log(`${'='.repeat(60)}\n`);

  // List all R2 objects with the prefix
  console.log('Fetching R2 objects...');
  const allKeys = await listR2Objects(prefix);
  
  // Filter out non-asset files like segments.json
  const keys = allKeys.filter(key => !key.endsWith('segments.json'));
  
  console.log(`Found ${keys.length} objects in R2\n`);

  if (keys.length === 0) {
    console.log('No objects to sync');
    process.exit(0);
  }

  // Batch check which assets already exist in database (in chunks to avoid URL length limit)
  console.log('Checking which assets already exist in database...');
  const existingKeys = new Set<string>();
  const BATCH_SIZE = 100; // Check 100 keys at a time to avoid URL length limit
  
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const { data: batchAssets, error: checkError } = await supabase
      .from('assets')
      .select('r2_key')
      .in('r2_key', batch);

    if (checkError) {
      console.error('Error checking existing assets:', checkError);
      process.exit(1);
    }

    batchAssets?.forEach(a => existingKeys.add(a.r2_key));
    process.stdout.write(`\rChecked ${Math.min(i + BATCH_SIZE, keys.length)}/${keys.length} keys...`);
  }
  console.log(); // New line after progress
  
  const keysToSync = keys.filter(key => !existingKeys.has(key));

  console.log(`Already in database: ${existingKeys.size}`);
  console.log(`Need to sync: ${keysToSync.length}\n`);

  if (keysToSync.length === 0) {
    console.log('All assets already synced!');
    process.exit(0);
  }

  // Sync each object that needs syncing
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < keysToSync.length; i++) {
    const key = keysToSync[i];
    console.log(`[${i + 1}/${keysToSync.length}] Processing: ${key}`);
    
    const result = await syncR2Object(key, dryRun);
    
    if (result) {
      synced++;
    } else {
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  skipped = existingKeys.size;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Sync Complete`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Total: ${keys.length}`);
  console.log(`Synced: ${synced}`);
  console.log(`Skipped (already exists): ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`${'='.repeat(60)}\n`);

  if (dryRun) {
    console.log('This was a dry run. No changes were made.');
    console.log('Run without --dry-run to actually sync the assets.\n');
  }
}

// Run the script
syncR2Assets().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
