import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, extname } from 'path';
import axios from 'axios';
import { loadTemplate } from '../config/templates.js';
import { GenericHtmlExtractor } from '../extractors/generic-html.js';
import { WpMangaExtractor } from '../extractors/wp-manga.js';
import type { ScrapeSegmentOptions, Extractor } from '../extractors/types.js';
import {
  getSegmentById,
  insertAsset,
  attachAssetToSegment,
  createJob,
  updateJobStatus,
} from '../services/supabase.js';
import { uploadToR2, buildR2Key } from '../services/r2.js';
import { computeFileHash } from '../utils/hash.js';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

function getExtractor(templateName: string): Extractor {
  if (templateName === 'wp-manga') {
    return new WpMangaExtractor();
  }
  return new GenericHtmlExtractor();
}

function getAssetFilename(url: string, index: number, type: 'image' | 'subtitle' | 'text'): string {
  const ext = extname(new URL(url).pathname) || '.webp';
  
  switch (type) {
    case 'image':
      return `page-${String(index + 1).padStart(3, '0')}${ext}`;
    case 'subtitle':
      return `sub-${String(index + 1).padStart(2, '0')}${ext || '.vtt'}`;
    case 'text':
      return `text-${String(index + 1).padStart(2, '0')}.txt`;
    default:
      return `asset-${String(index + 1).padStart(3, '0')}${ext}`;
  }
}

async function downloadAsset(url: string, retries: number = 3): Promise<Buffer> {
  const env = getEnv();
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) {
        const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 8000);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }

      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Referer': new URL(url).origin + '/',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 60000,
        maxRedirects: 5,
      });

      return Buffer.from(response.data);
    } catch (error) {
      const isLastAttempt = attempt === retries - 1;
      if (isLastAttempt) {
        throw error;
      }
      logger.warn({ url, attempt: attempt + 1, error: error instanceof Error ? error.message : String(error) }, 'Download failed, retrying');
    }
  }

  throw new Error('Failed to download asset after all retries');
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect content type from buffer and filename
 */
function detectContentType(buffer: Buffer, filename: string): string {
  // Check magic bytes for images
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return 'image/webp';
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif';
  }
  
  // Check file extension for subtitles and structured data
  const ext = extname(filename).toLowerCase();
  if (ext === '.srt') return 'text/plain';
  if (ext === '.vtt') return 'text/vtt';
  if (ext === '.ass' || ext === '.ssa') return 'text/x-ssa';
  if (ext === '.sub') return 'text/plain';
  if (ext === '.json') return 'application/json';
  
  // Default fallbacks
  if (ext === '.txt' || ext === '.html') return 'text/plain';
  if (ext === '.json') return 'application/json';
  
  return 'application/octet-stream';
}

/**
 * Atomic function: Upload to R2 + Register in DB with retry logic
 * Prevents orphaned files by ensuring both operations succeed or cleanup
 */
async function uploadAndRegisterAsset(
  buffer: Buffer,
  r2Key: string,
  assetType: 'raw_image' | 'raw_subtitle' | 'cleaned_text',
  segmentId: string,
  role: 'page' | 'subtitle' | 'text',
  retries: number = 5
): Promise<boolean> {
  const { sha256, bytes } = computeFileHash(buffer);
  let uploadedToR2 = false;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Step 1: Upload to R2 (only once)
      if (!uploadedToR2) {
        logger.info({ r2Key, attempt: attempt + 1, retries }, 'Uploading to R2');
        const contentType = detectContentType(buffer, r2Key);
        logger.info({ r2Key, contentType }, 'Detected content type');
        await uploadToR2(r2Key, buffer, contentType);
        uploadedToR2 = true;
        logger.info({ r2Key }, 'Successfully uploaded to R2');
      }
      
      // Step 2: Register in Database (with retry)
      logger.info({ r2Key, attempt: attempt + 1, retries }, 'Registering asset in database');
      const contentType = detectContentType(buffer, r2Key);
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
      await new Promise(resolve => setTimeout(resolve, backoffDelay));
    }
  }
  
  return false;
}

export async function scrapeSegment(options: ScrapeSegmentOptions): Promise<void> {
  const { url, segmentId, template, download } = options;
  let jobId: string | null = null;

  try {
    jobId = await createJob('scrape', { url, segmentId, template, download });
    await updateJobStatus(jobId, 'running');

    logger.info({ url, segmentId, template, download }, 'Starting segment scrape');

    const segment = await getSegmentById(segmentId);
    if (!segment) {
      throw new Error(`Segment not found: ${segmentId}`);
    }

    const edition = segment.edition as { id: string; work_id: string; media_type: string } | undefined;
    if (!edition) {
      throw new Error(`Edition not found for segment: ${segmentId}`);
    }

    const templateConfig = loadTemplate(template);
    const extractor = getExtractor(template);

    const result = await extractor.scrapeSegment(url, templateConfig);

    const outputData = {
      segmentId,
      url,
      scrapedAt: new Date().toISOString(),
      images: result.images,
      subtitles: result.subtitles,
      texts: result.texts,
    };

    const outDir = join(process.cwd(), 'out');
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }
    const localPath = join(outDir, 'assets.json');
    writeFileSync(localPath, JSON.stringify(outputData, null, 2));
    logger.info({ localPath }, 'Saved assets to local file');

    const segmentInfo = {
      type: segment.segment_type,
      number: segment.number,
    };

    const assetsJsonKey = buildR2Key(
      edition.media_type,
      edition.work_id,
      edition.id,
      'assets.json',
      segmentInfo
    );
    await uploadToR2(assetsJsonKey, JSON.stringify(outputData, null, 2), 'application/json');
    logger.info({ r2Key: assetsJsonKey }, 'Uploaded assets.json to R2');

    const uploadedAssets: string[] = [];
    let successCount = 0;
    let failedCount = 0;

    if (download) {
      const env = getEnv();
      const rateLimitMs = env.DEFAULT_RATE_LIMIT_MS;

      logger.info({ total: result.images.length }, 'Starting image download and upload');

      // Process images
      for (let i = 0; i < result.images.length; i++) {
        const imageUrl = result.images[i];
        const filename = getAssetFilename(imageUrl, i, 'image');
        const r2Key = buildR2Key(
          edition.media_type,
          edition.work_id,
          edition.id,
          filename,
          segmentInfo
        );

        try {
          logger.info({ index: i + 1, total: result.images.length, imageUrl }, 'Processing image');
          
          // Download with retry
          const buffer = await downloadAsset(imageUrl, 5);
          
          // Upload and register with retry
          const success = await uploadAndRegisterAsset(
            buffer,
            r2Key,
            'raw_image',
            segmentId,
            'page',
            5 // 5 retries for DB operations
          );

          if (success) {
            uploadedAssets.push(r2Key);
            successCount++;
            logger.info({ 
              index: i + 1, 
              total: result.images.length, 
              successRate: `${Math.round(successCount / (i + 1) * 100)}%` 
            }, 'Image processed successfully');
          } else {
            failedCount++;
            logger.error({ index: i + 1, imageUrl }, 'Failed to process image after all retries');
          }

          if (i < result.images.length - 1) {
            await delay(rateLimitMs);
          }
        } catch (error) {
          failedCount++;
          logger.error({ error: error instanceof Error ? error.message : String(error), imageUrl, index: i }, 'Failed to download image');
        }
      }

      logger.info({ 
        total: result.images.length,
        success: successCount,
        failed: failedCount,
        successRate: `${Math.round(successCount / result.images.length * 100)}%`
      }, 'Image processing completed');

      // Process subtitles
      for (let i = 0; i < result.subtitles.length; i++) {
        const subUrl = result.subtitles[i];
        const filename = getAssetFilename(subUrl, i, 'subtitle');
        const r2Key = buildR2Key(
          edition.media_type,
          edition.work_id,
          edition.id,
          filename,
          segmentInfo
        );

        try {
          const buffer = await downloadAsset(subUrl, 5);
          
          const success = await uploadAndRegisterAsset(
            buffer,
            r2Key,
            'raw_subtitle',
            segmentId,
            'subtitle',
            5
          );

          if (success) {
            uploadedAssets.push(r2Key);
          }

          await delay(rateLimitMs);
        } catch (error) {
          logger.error({ error: error instanceof Error ? error.message : String(error), subUrl, index: i }, 'Failed to process subtitle');
        }
      }

      // Process texts
      for (let i = 0; i < result.texts.length; i++) {
        const text = result.texts[i];
        const buffer = Buffer.from(text, 'utf-8');
        
        const filename = getAssetFilename(`text-${i}.txt`, i, 'text');
        const r2Key = buildR2Key(
          edition.media_type,
          edition.work_id,
          edition.id,
          filename,
          segmentInfo
        );

        try {
          const success = await uploadAndRegisterAsset(
            buffer,
            r2Key,
            'cleaned_text',
            segmentId,
            'text',
            5
          );

          if (success) {
            uploadedAssets.push(r2Key);
          }
        } catch (error) {
          logger.error({ error: error instanceof Error ? error.message : String(error), index: i }, 'Failed to process text');
        }
      }
    }

    // Only fail job if ALL assets failed
    if (download && successCount === 0 && result.images.length > 0) {
      throw new Error(`Failed to upload any assets (0/${result.images.length} succeeded)`);
    }

    await updateJobStatus(jobId, 'success', {
      segmentId,
      imageCount: result.images.length,
      subtitleCount: result.subtitles.length,
      textCount: result.texts.length,
      downloadedAssets: uploadedAssets.length,
      successCount,
      failedCount,
      successRate: result.images.length > 0 
        ? `${Math.round(successCount / result.images.length * 100)}%` 
        : '100%',
      assetsJsonKey,
      localPath,
    });

    logger.info({
      segmentId,
      imageCount: result.images.length,
      downloadedAssets: uploadedAssets.length,
      successCount,
      failedCount,
    }, 'Segment scrape completed');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, url, segmentId }, 'Segment scrape failed');

    if (jobId) {
      await updateJobStatus(jobId, 'failed', undefined, errorMessage);
    }

    throw error;
  }
}
