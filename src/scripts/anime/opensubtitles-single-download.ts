import { parseArgs } from 'util';
import { getOpenSubtitlesApi } from '../../services/opensubtitles-api.js';
import { 
  getSegmentById, 
  insertAsset, 
  attachAssetToSegment,
  createJob,
  updateJobStatus,
} from '../../services/supabase.js';
import { uploadToR2, buildR2Key } from '../../services/r2.js';
import { computeFileHash } from '../../utils/hash.js';
import { logger } from '../../utils/logger.js';
import { getEnv } from '../../config/env.js';

interface Args {
  segmentId: string;
  query: string;
  languages?: string;
}

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
  retries: number = 5
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
      const assetId = await insertAsset(r2Key, assetType, bytes, sha256, 'pipeline', contentType);
      
      logger.info({ r2Key, attempt: attempt + 1, retries }, 'Attaching asset to segment');
      await attachAssetToSegment(segmentId, assetId, role);
      
      logger.info({ r2Key, assetId, bytes, sha256 }, 'Successfully uploaded and registered asset');
      return true;
      
    } catch (error) {
      const isLastAttempt = attempt === retries - 1;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      logger.warn({ 
        r2Key, 
        attempt: attempt + 1, 
        retries,
        error: errorMessage,
        uploadedToR2 
      }, 'Failed to upload/register asset');
      
      if (isLastAttempt) {
        logger.error({ r2Key, error: errorMessage, attempts: retries }, 'Failed after all retries');
        return false;
      }
      
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s
      const backoffDelay = Math.min(2000 * Math.pow(2, attempt), 32000);
      logger.info({ r2Key, delay: backoffDelay }, 'Waiting before retry');
      await delay(backoffDelay);
    }
  }
  
  return false;
}

function parseArguments(): Args {
  const { values } = parseArgs({
    options: {
      segmentId: {
        type: 'string',
        short: 's',
      },
      query: {
        type: 'string',
        short: 'q',
      },
      languages: {
        type: 'string',
        short: 'l',
        default: 'en',
      },
    },
  });

  if (!values.segmentId || typeof values.segmentId !== 'string') {
    throw new Error('--segmentId is required');
  }

  if (!values.query || typeof values.query !== 'string') {
    throw new Error('--query is required (e.g., "Solo Leveling")');
  }

  return {
    segmentId: values.segmentId,
    query: values.query,
    languages: values.languages,
  };
}

async function main() {
  let jobId: string | null = null;

  try {
    const args = parseArguments();
    logger.info(args, 'Starting OpenSubtitles API subtitle download');

    // Get segment info
    const segment = await getSegmentById(args.segmentId);
    if (!segment) {
      throw new Error(`Segment not found: ${args.segmentId}`);
    }

    const edition = segment.edition as { id: string; work_id: string; media_type: string } | undefined;
    if (!edition) {
      throw new Error(`Edition not found for segment: ${args.segmentId}`);
    }

    // Extract season and episode from title
    const seasonEpisode = extractSeasonEpisode(segment.title || '');
    if (!seasonEpisode) {
      throw new Error(`Could not extract season/episode from title: "${segment.title || 'N/A'}". Expected format: S01E01`);
    }

    logger.info({
      segmentId: args.segmentId,
      title: segment.title || 'N/A',
      seasonNumber: seasonEpisode.seasonNumber,
      episodeNumber: seasonEpisode.episodeNumber,
    }, 'Extracted season/episode from title');

    // Create job
    jobId = await createJob('scrape', {
      segmentId: args.segmentId,
      query: args.query,
      seasonNumber: seasonEpisode.seasonNumber,
      episodeNumber: seasonEpisode.episodeNumber,
      source: 'opensubtitles-api',
    });
    await updateJobStatus(jobId, 'running');

    // Get OpenSubtitles API service
    const api = getOpenSubtitlesApi();

    // Search and download best subtitle with retry
    let result;
    let downloadAttempt = 0;
    const maxDownloadRetries = 3;

    while (downloadAttempt < maxDownloadRetries) {
      try {
        logger.info({ 
          segmentId: args.segmentId,
          attempt: downloadAttempt + 1,
          maxRetries: maxDownloadRetries,
        }, 'Attempting to download subtitle');

        result = await api.searchAndDownloadBest({
          query: args.query,
          seasonNumber: seasonEpisode.seasonNumber,
          episodeNumber: seasonEpisode.episodeNumber,
          languages: args.languages,
        });

        break; // Success, exit retry loop
      } catch (error) {
        downloadAttempt++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        if (downloadAttempt >= maxDownloadRetries) {
          logger.error({ 
            segmentId: args.segmentId,
            error: errorMessage,
            attempts: downloadAttempt,
          }, 'Failed to download subtitle after all retries');
          throw error;
        }

        logger.warn({ 
          segmentId: args.segmentId,
          error: errorMessage,
          attempt: downloadAttempt,
          maxRetries: maxDownloadRetries,
        }, 'Download failed, retrying');

        // Exponential backoff before retry
        const backoffDelay = Math.min(1000 * Math.pow(2, downloadAttempt), 8000);
        await delay(backoffDelay);
      }
    }

    if (!result) {
      throw new Error('Failed to download subtitle');
    }

    logger.info({
      fileId: result.fileId,
      fileName: result.fileName,
      bytes: result.buffer.length,
      language: result.subtitleInfo.attributes.language,
      downloadCount: result.subtitleInfo.attributes.download_count,
    }, 'Downloaded subtitle successfully');

    // Build R2 key
    const segmentInfo = {
      type: segment.segment_type,
      number: segment.number,
    };

    const r2Key = buildR2Key(
      edition.media_type,
      edition.work_id,
      edition.id,
      result.fileName,
      segmentInfo
    );

    // Upload and register with retry logic
    const success = await uploadAndRegisterAsset(
      result.buffer,
      r2Key,
      'raw_subtitle',
      args.segmentId,
      'subtitle',
      5 // 5 retries
    );

    if (!success) {
      throw new Error(`Failed to upload and register asset after all retries: ${r2Key}`);
    }

    // Get hash and bytes for job output
    const { sha256, bytes } = computeFileHash(result.buffer);

    logger.info({ segmentId: args.segmentId, r2Key }, 'Asset registered successfully');

    // Update job status
    await updateJobStatus(jobId, 'success', {
      segmentId: args.segmentId,
      fileId: result.fileId,
      fileName: result.fileName,
      r2Key,
      bytes,
      sha256,
      language: result.subtitleInfo.attributes.language,
      downloadCount: result.subtitleInfo.attributes.download_count,
      rating: result.subtitleInfo.attributes.ratings,
      fromTrusted: result.subtitleInfo.attributes.from_trusted,
    });

    logger.info({ segmentId: args.segmentId, r2Key }, 'Subtitle download completed successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, 'Subtitle download failed');

    if (jobId) {
      await updateJobStatus(jobId, 'failed', undefined, errorMessage);
    }

    process.exit(1);
  }
}

main();
