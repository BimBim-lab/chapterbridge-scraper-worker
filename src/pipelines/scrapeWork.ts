import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { loadTemplate } from '../config/templates.js';
import { GenericHtmlExtractor } from '../extractors/generic-html.js';
import { WpMangaExtractor } from '../extractors/wp-manga.js';
import type { ScrapeWorkOptions, Extractor } from '../extractors/types.js';
import {
  upsertWork,
  upsertEdition,
  upsertSegment,
  createJob,
  updateJobStatus,
} from '../services/supabase.js';
import { uploadToR2, buildR2Key } from '../services/r2.js';
import { logger } from '../utils/logger.js';

function getExtractor(templateName: string): Extractor {
  if (templateName === 'wp-manga') {
    return new WpMangaExtractor();
  }
  return new GenericHtmlExtractor();
}

export async function scrapeWork(options: ScrapeWorkOptions): Promise<void> {
  const { url, media, provider, template, title } = options;
  let jobId: string | null = null;

  try {
    jobId = await createJob('scrape:work', { url, media, provider, template, title });
    await updateJobStatus(jobId, 'running');

    logger.info({ url, media, provider, template, title }, 'Starting work scrape');

    const templateConfig = loadTemplate(template);
    const extractor = getExtractor(template);

    const workId = await upsertWork(title);
    const editionId = await upsertEdition(workId, media, provider, url);

    const result = await extractor.scrapeWork(url, templateConfig);

    for (const segment of result.segments) {
      await upsertSegment(editionId, segment.number, segment.title, segment.url);
    }

    const outputData = {
      workId,
      editionId,
      url,
      media,
      provider,
      scrapedAt: new Date().toISOString(),
      segments: result.segments,
    };

    const outDir = join(process.cwd(), 'out');
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }
    const localPath = join(outDir, 'segments.json');
    writeFileSync(localPath, JSON.stringify(outputData, null, 2));
    logger.info({ localPath }, 'Saved segments to local file');

    const r2Key = buildR2Key(media, workId, editionId, 'segments.json');
    await uploadToR2(r2Key, JSON.stringify(outputData, null, 2), 'application/json');
    logger.info({ r2Key }, 'Uploaded segments to R2');

    await updateJobStatus(jobId, 'success', {
      workId,
      editionId,
      segmentCount: result.segments.length,
      r2Key,
      localPath,
    });

    logger.info({
      workId,
      editionId,
      segmentCount: result.segments.length,
    }, 'Work scrape completed successfully');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, url }, 'Work scrape failed');

    if (jobId) {
      await updateJobStatus(jobId, 'failed', undefined, errorMessage);
    }

    throw error;
  }
}
