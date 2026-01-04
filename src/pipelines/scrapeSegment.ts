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

async function downloadAsset(url: string): Promise<Buffer> {
  const env = getEnv();
  
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: {
      'User-Agent': env.USER_AGENT,
      'Accept': 'image/webp,image/*,*/*;q=0.8',
      'Referer': new URL(url).origin,
    },
    timeout: 60000,
  });

  return Buffer.from(response.data);
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeSegment(options: ScrapeSegmentOptions): Promise<void> {
  const { url, segmentId, template, download } = options;
  let jobId: string | null = null;

  try {
    jobId = await createJob('scrape:segment', { url, segmentId, template, download });
    await updateJobStatus(jobId, 'running');

    logger.info({ url, segmentId, template, download }, 'Starting segment scrape');

    const segment = await getSegmentById(segmentId);
    if (!segment) {
      throw new Error(`Segment not found: ${segmentId}`);
    }

    const edition = segment.edition as { id: string; work_id: string; media: string } | undefined;
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
      edition.media,
      edition.work_id,
      edition.id,
      'assets.json',
      segmentInfo
    );
    await uploadToR2(assetsJsonKey, JSON.stringify(outputData, null, 2), 'application/json');
    logger.info({ r2Key: assetsJsonKey }, 'Uploaded assets.json to R2');

    const uploadedAssets: string[] = [];

    if (download) {
      const env = getEnv();
      const rateLimitMs = env.DEFAULT_RATE_LIMIT_MS;

      for (let i = 0; i < result.images.length; i++) {
        const imageUrl = result.images[i];
        try {
          logger.info({ index: i + 1, total: result.images.length, imageUrl }, 'Downloading image');
          
          const buffer = await downloadAsset(imageUrl);
          const { sha256, bytes } = computeFileHash(buffer);
          
          const filename = getAssetFilename(imageUrl, i, 'image');
          const r2Key = buildR2Key(
            edition.media,
            edition.work_id,
            edition.id,
            filename,
            segmentInfo
          );

          await uploadToR2(r2Key, buffer, 'image/webp');
          
          const assetId = await insertAsset(r2Key, 'image', bytes, sha256, 'scraper');
          await attachAssetToSegment(segmentId, assetId, 'page');
          
          uploadedAssets.push(r2Key);
          logger.info({ r2Key, bytes, sha256 }, 'Uploaded and registered image asset');

          if (i < result.images.length - 1) {
            await delay(rateLimitMs);
          }
        } catch (error) {
          logger.error({ error, imageUrl, index: i }, 'Failed to download/upload image');
        }
      }

      for (let i = 0; i < result.subtitles.length; i++) {
        const subUrl = result.subtitles[i];
        try {
          const buffer = await downloadAsset(subUrl);
          const { sha256, bytes } = computeFileHash(buffer);
          
          const filename = getAssetFilename(subUrl, i, 'subtitle');
          const r2Key = buildR2Key(
            edition.media,
            edition.work_id,
            edition.id,
            filename,
            segmentInfo
          );

          await uploadToR2(r2Key, buffer, 'text/vtt');
          
          const assetId = await insertAsset(r2Key, 'subtitle', bytes, sha256, 'scraper');
          await attachAssetToSegment(segmentId, assetId, 'subtitle');
          
          uploadedAssets.push(r2Key);
          logger.info({ r2Key, bytes }, 'Uploaded and registered subtitle asset');

          await delay(rateLimitMs);
        } catch (error) {
          logger.error({ error, subUrl, index: i }, 'Failed to download/upload subtitle');
        }
      }

      for (let i = 0; i < result.texts.length; i++) {
        const text = result.texts[i];
        const buffer = Buffer.from(text, 'utf-8');
        const { sha256, bytes } = computeFileHash(buffer);
        
        const filename = getAssetFilename(`text-${i}.txt`, i, 'text');
        const r2Key = buildR2Key(
          edition.media,
          edition.work_id,
          edition.id,
          filename,
          segmentInfo
        );

        await uploadToR2(r2Key, buffer, 'text/plain');
        
        const assetId = await insertAsset(r2Key, 'text', bytes, sha256, 'scraper');
        await attachAssetToSegment(segmentId, assetId, 'text');
        
        uploadedAssets.push(r2Key);
        logger.info({ r2Key, bytes }, 'Uploaded and registered text asset');
      }
    }

    await updateJobStatus(jobId, 'success', {
      segmentId,
      imageCount: result.images.length,
      subtitleCount: result.subtitles.length,
      textCount: result.texts.length,
      downloadedAssets: uploadedAssets.length,
      assetsJsonKey,
      localPath,
    });

    logger.info({
      segmentId,
      imageCount: result.images.length,
      downloadedAssets: uploadedAssets.length,
    }, 'Segment scrape completed successfully');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, url, segmentId }, 'Segment scrape failed');

    if (jobId) {
      await updateJobStatus(jobId, 'failed', undefined, errorMessage);
    }

    throw error;
  }
}
