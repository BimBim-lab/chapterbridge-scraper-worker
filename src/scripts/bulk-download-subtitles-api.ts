import { parseArgs } from 'util';
import { getOpenSubtitlesApi } from '../services/opensubtitles-api.js';
import { 
  getSegmentById,
  getSupabase,
  insertAsset, 
  attachAssetToSegment,
  createJob,
  updateJobStatus,
} from '../services/supabase.js';
import { uploadToR2, buildR2Key } from '../services/r2.js';
import { computeFileHash } from '../utils/hash.js';
import { logger } from '../utils/logger.js';
import { getEnv } from '../config/env.js';
import dns from 'dns';

// Force DNS to use IPv4 first (helps with WARP compatibility)
dns.setDefaultResultOrder('ipv4first');

/**
 * Extract season and episode number from segment title
 * Expected format: "S01E01", "S02E13", etc.
 */
function extractSeasonEpisode(title: string): { seasonNumber: number; episodeNumber: number } | null {
  // Match patterns like S01E01, S02E13, etc.
  const match = title.match(/S(\d+)E(\d+)/i);
  
  if (!match) {
    return null;
  }
  
  return {
    seasonNumber: parseInt(match[1], 10),
    episodeNumber: parseInt(match[2], 10),
  };
}

interface Args {
  workId?: string;
  editionId?: string;
  seriesName: string;
  languages?: string;
  delay?: number;
  limit?: number;
}

interface SegmentRow {
  id: string;
  edition_id: string;
  segment_type: string;
  number: number;
  title: string;
  canonical_url: string;
  edition: {
    id: string;
    work_id: string;
    media_type: string;
    provider: string;
  };
}

function parseArguments(): Args {
  const { values } = parseArgs({
    options: {
      workId: {
        type: 'string',
        short: 'w',
      },
      editionId: {
        type: 'string',
        short: 'e',
      },
      seriesName: {
        type: 'string',
        short: 's',
      },
      languages: {
        type: 'string',
        short: 'l',
        default: 'en',
      },
      delay: {
        type: 'string',
        short: 'd',
        default: '1000',
      },
      limit: {
        type: 'string',
        default: undefined,
      },
    },
  });

  if (!values.workId && !values.editionId) {
    throw new Error('Either --workId or --editionId is required');
  }

  if (!values.seriesName || typeof values.seriesName !== 'string') {
    throw new Error('--seriesName is required (e.g., "Solo Leveling")');
  }

  return {
    workId: values.workId,
    editionId: values.editionId,
    seriesName: values.seriesName,
    languages: values.languages,
    delay: parseInt(values.delay!, 10),
    limit: values.limit ? parseInt(values.limit, 10) : undefined,
  };
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Atomic function: Upload to R2 + Register in DB with retry logic
 * Prevents orphaned files by ensuring both operations succeed or cleanup
 */
async function uploadAndRegisterAsset(
  buffer: Buffer,
  r2Key: string,
  assetType: 'raw_subtitle',
  segmentId: string,
  role: 'subtitle',
  retries: number = 5,
  sourceUrl?: string,
  originalFilename?: string
): Promise<boolean> {
  const { sha256, bytes } = computeFileHash(buffer);
  let uploadedToR2 = false;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Step 1: Upload to R2 (only once)
      if (!uploadedToR2) {
        logger.info({ r2Key, attempt: attempt + 1, retries }, 'Uploading to R2');
        const contentType = r2Key.endsWith('.vtt') 
          ? 'text/vtt' 
          : r2Key.endsWith('.srt')
          ? 'text/srt'
          : 'application/octet-stream';
        await uploadToR2(r2Key, buffer, contentType);
        uploadedToR2 = true;
        logger.info({ r2Key }, 'Successfully uploaded to R2');
      }
      
      // Step 2: Register in Database (with retry)
      logger.info({ r2Key, attempt: attempt + 1, retries }, 'Registering asset in database');
      const contentType = r2Key.endsWith('.vtt') 
        ? 'text/vtt' 
        : r2Key.endsWith('.srt')
        ? 'text/plain'
        : r2Key.endsWith('.ass')
        ? 'text/x-ssa'
        : 'text/plain';
      const assetId = await insertAsset(r2Key, assetType, bytes, sha256, 'pipeline', contentType, sourceUrl, originalFilename);
      
      logger.info({ r2Key, attempt: attempt + 1, retries }, 'Attaching asset to segment');
      await attachAssetToSegment(segmentId, assetId, role);
      
      logger.info({ r2Key, assetId, bytes, sha256 }, 'Successfully uploaded and registered asset');
      return true;
      
    } catch (error) {
      const isLastAttempt = attempt === retries - 1;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      logger.warn({ 
        r2Key, 
        attempt: attempt + 1, 
        retries,
        error: errorMessage,
        errorStack,
        uploadedToR2,
        phase: uploadedToR2 ? 'database_registration' : 'r2_upload'
      }, 'Failed to upload/register asset');
      
      if (isLastAttempt) {
        logger.error({ 
          r2Key, 
          error: errorMessage, 
          errorStack,
          attempts: retries,
          uploadedToR2 
        }, 'Failed after all retries');
        return false;
      }
      
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s
      const backoffDelay = Math.min(2000 * Math.pow(2, attempt), 32000);
      logger.info({ r2Key, delay: backoffDelay, nextAttempt: attempt + 2 }, 'Waiting before retry');
      await delay(backoffDelay);
    }
  }
  
  return false;
}

async function getSegments(workId?: string, editionId?: string, limit?: number): Promise<SegmentRow[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('segments')
    .select(`
      id,
      edition_id,
      segment_type,
      number,
      title,
      canonical_url,
      edition:editions!inner(
        id,
        work_id,
        media_type,
        provider
      )
    `);

  if (editionId) {
    query = query.eq('edition_id', editionId);
  } else if (workId) {
    query = query.eq('edition.work_id', workId);
  } else {
    throw new Error('Either workId or editionId must be provided');
  }

  query = query
    .order('edition_id', { ascending: true })
    .order('number', { ascending: true });

  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to get segments: ${error.message}`);
  }

  return data as unknown as SegmentRow[];
}

async function downloadSubtitleForSegment(
  segment: SegmentRow,
  seriesName: string,
  languages: string
): Promise<void> {
  try {
    // Extract season and episode from title (e.g., "S01E01" -> season 1, episode 1)
    const seasonEpisode = extractSeasonEpisode(segment.title || '');
    
    if (!seasonEpisode) {
      logger.warn({
        segmentId: segment.id,
        title: segment.title,
      }, 'Could not extract season/episode from title, skipping');
      return;
    }

    const { seasonNumber, episodeNumber } = seasonEpisode;

    logger.info({
      segmentId: segment.id,
      seasonNumber,
      episodeNumber,
      title: segment.title,
      sequenceNumber: segment.number,
    }, 'Processing segment');

    // Check if subtitle already exists
    const supabase = getSupabase();
    const { data: existingAssets } = await supabase
      .from('segment_assets')
      .select('asset_id')
      .eq('segment_id', segment.id)
      .eq('role', 'subtitle')
      .limit(1);

    if (existingAssets && existingAssets.length > 0) {
      logger.info({ segmentId: segment.id }, 'Subtitle already exists, skipping');
      return;
    }

    // Get OpenSubtitles API service
    const api = getOpenSubtitlesApi();

    // Search and download best subtitle with retry and fallback
    let result;
    let downloadAttempt = 0;
    const maxDownloadRetries = 3;
    let triedFallback = false;

    while (downloadAttempt < maxDownloadRetries) {
      try {
        logger.info({ 
          segmentId: segment.id,
          attempt: downloadAttempt + 1,
          maxRetries: maxDownloadRetries,
        }, 'Attempting to download subtitle');

        // Use fallback episode number if primary search failed
        const episodeToSearch = triedFallback ? segment.number : episodeNumber;

        result = await api.searchAndDownloadBest({
          query: seriesName,
          seasonNumber,
          episodeNumber: episodeToSearch,
          languages,
        });

        logger.info({
          segmentId: segment.id,
          fileId: result.fileId,
          attempt: downloadAttempt + 1,
          usedFallback: triedFallback,
        }, 'Successfully downloaded subtitle');

        break; // Success, exit retry loop
      } catch (error) {
        downloadAttempt++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        
        // If "No subtitles found" and haven't tried fallback yet, try with sequence number
        if (errorMessage.includes('No subtitles found') && !triedFallback) {
          logger.info({ 
            segmentId: segment.id,
            originalEpisode: episodeNumber,
            fallbackEpisode: segment.number,
          }, 'No subtitles found, trying fallback with sequence number');
          triedFallback = true;
          downloadAttempt = 0; // Reset attempt counter for fallback
          continue;
        }
        
        if (downloadAttempt >= maxDownloadRetries) {
          logger.error({ 
            segmentId: segment.id,
            error: errorMessage,
            errorStack,
            attempts: downloadAttempt,
            triedFallback,
          }, 'Failed to download subtitle after all retries');
          throw error;
        }

        logger.warn({ 
          segmentId: segment.id,
          error: errorMessage,
          errorStack,
          attempt: downloadAttempt,
          maxRetries: maxDownloadRetries,
        }, 'Download failed, retrying');

        // Exponential backoff before retry (1s, 2s, 4s)
        const backoffDelay = Math.min(1000 * Math.pow(2, downloadAttempt), 8000);
        logger.info({ 
          segmentId: segment.id, 
          delay: backoffDelay,
          nextAttempt: downloadAttempt + 1 
        }, 'Waiting before retry');
        await delay(backoffDelay);
      }
    }

    if (!result) {
      throw new Error('Failed to download subtitle');
    }

    logger.info({
      segmentId: segment.id,
      fileId: result.fileId,
      fileName: result.fileName,
      bytes: result.buffer.length,
      language: result.subtitleInfo.attributes.language,
    }, 'Downloaded subtitle');

    // Build R2 key using episode number from title (not sequence_number)
    // For S02E05, use episode-5 (not episode-17 from sequence_number)
    const segmentInfo = {
      type: segment.segment_type,
      number: episodeNumber, // Use extracted episode number from title
    };

    const r2Key = buildR2Key(
      segment.edition.media_type,
      segment.edition.work_id,
      segment.edition.id,
      result.fileName,
      segmentInfo
    );

    // Upload and register with retry logic
    const success = await uploadAndRegisterAsset(
      result.buffer,
      r2Key,
      'raw_subtitle',
      segment.id,
      'subtitle',
      5, // 5 retries
      undefined, // no source URL available
      result.fileName // original filename
    );

    if (!success) {
      throw new Error(`Failed to upload and register asset after all retries: ${r2Key}`);
    }

    logger.info({ 
      segmentId: segment.id,
      r2Key,
      seasonNumber,
      episodeNumber,
    }, 'Successfully processed segment');
  } catch (error) {
    logger.error({ 
      error: error instanceof Error ? error.message : String(error),
      segmentId: segment.id,
      title: segment.title,
    }, 'Failed to process segment');
    // Continue with next segment
  }
}

async function main() {
  let jobId: string | null = null;
  
  try {
    const args = parseArguments();
    logger.info(args, 'Starting bulk subtitle download');

    // Create pipeline job for tracking
    jobId = await createJob('scrape', {
      workId: args.workId,
      editionId: args.editionId,
      seriesName: args.seriesName,
      languages: args.languages,
      scriptType: 'bulk-download-subtitles',
    });
    
    await updateJobStatus(jobId, 'running');
    logger.info({ jobId }, 'Created pipeline job');

    // Get all segments
    const segments = await getSegments(args.workId, args.editionId, args.limit);
    
    logger.info({ 
      totalSegments: segments.length,
      workId: args.workId,
      editionId: args.editionId,
    }, 'Found segments');

    // Check which segments already have subtitles
    const supabase = getSupabase();
    const editionIdToCheck = args.editionId || segments[0]?.edition_id;
    
    const { data: segmentsWithAssets, error: assetsError } = await supabase
      .from('segments')
      .select('id, segment_assets(segment_id)')
      .eq('edition_id', editionIdToCheck);
    
    if (assetsError) {
      logger.warn({ error: assetsError.message }, 'Error checking existing assets');
    }
    
    // Filter segments that have at least one asset (subtitle)
    const completedSegmentIds = new Set(
      segmentsWithAssets
        ?.filter(s => s.segment_assets && s.segment_assets.length > 0)
        .map(s => s.id) || []
    );
    
    const segmentsToProcess = segments.filter(s => !completedSegmentIds.has(s.id));

    logger.info({ 
      totalSegments: segments.length,
      alreadyCompleted: completedSegmentIds.size,
      pending: segmentsToProcess.length,
      processCount: segmentsToProcess.length,
    }, 'Starting download');

    let successCount = 0;
    let errorCount = 0;
    let skipCount = 0;

    for (let i = 0; i < segmentsToProcess.length; i++) {
      const segment = segmentsToProcess[i];
      
      logger.info({ 
        progress: `${i + 1}/${segmentsToProcess.length}`,
        segmentId: segment.id,
      }, 'Processing segment');

      try {
        await downloadSubtitleForSegment(
          segment,
          args.seriesName,
          args.languages!
        );
        successCount++;
      } catch (error) {
        errorCount++;
        logger.error({
          error: error instanceof Error ? error.message : String(error),
          segmentId: segment.id,
        }, 'Error processing segment');
      }

      // Rate limiting delay
      if (i < segmentsToProcess.length - 1) {
        logger.info({ delay: args.delay }, 'Waiting before next request');
        await delay(args.delay!);
      }
    }

    logger.info({
      total: segmentsToProcess.length,
      success: successCount,
      errors: errorCount,
      skipped: skipCount,
    }, 'Bulk download completed');

    // Update job status to success
    if (jobId) {
      await updateJobStatus(jobId, 'success', {
        total: segmentsToProcess.length,
        success: successCount,
        errors: errorCount,
        skipped: skipCount,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    logger.error({ 
      error: errorMessage,
    }, 'Bulk download failed');

    // Update job status to failed
    if (jobId) {
      await updateJobStatus(jobId, 'failed', undefined, errorMessage);
    }

    process.exit(1);
  }
}

main();
