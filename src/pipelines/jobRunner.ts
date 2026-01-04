import { getQueuedJobs, updateJobStatus } from '../services/supabase.js';
import { scrapeWork } from './scrapeWork.js';
import { scrapeSegment } from './scrapeSegment.js';
import type { ScrapeWorkOptions, ScrapeSegmentOptions, JobRunOptions } from '../extractors/types.js';
import { logger } from '../utils/logger.js';

let isRunning = false;

async function processJob(job: { id: string; job_type: string; input: Record<string, unknown> }): Promise<void> {
  logger.info({ jobId: job.id, jobType: job.job_type }, 'Processing job');

  try {
    await updateJobStatus(job.id, 'running');

    switch (job.job_type) {
      case 'scrape:work': {
        const input = job.input as unknown as ScrapeWorkOptions;
        await scrapeWork(input);
        break;
      }
      case 'scrape:segment': {
        const input = job.input as unknown as ScrapeSegmentOptions;
        await scrapeSegment(input);
        break;
      }
      default:
        throw new Error(`Unknown job type: ${job.job_type}`);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, jobId: job.id }, 'Job processing failed');
  }
}

async function pollOnce(): Promise<boolean> {
  const jobs = await getQueuedJobs(1);

  if (jobs.length === 0) {
    return false;
  }

  for (const job of jobs) {
    await processJob(job);
  }

  return true;
}

export async function runJobRunner(options: JobRunOptions): Promise<void> {
  const { poll } = options;

  logger.info({ pollInterval: poll }, 'Starting job runner');
  isRunning = true;

  process.on('SIGINT', () => {
    logger.info('Received SIGINT, stopping job runner');
    isRunning = false;
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, stopping job runner');
    isRunning = false;
  });

  while (isRunning) {
    try {
      const hadWork = await pollOnce();

      if (!hadWork) {
        await new Promise((resolve) => setTimeout(resolve, poll));
      }
    } catch (error) {
      logger.error({ error }, 'Error during job polling');
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }

  logger.info('Job runner stopped');
}

export async function runOnce(): Promise<void> {
  logger.info('Running job runner once');
  await pollOnce();
}
