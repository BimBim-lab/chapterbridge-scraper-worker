#!/usr/bin/env node

import { Command } from 'commander';
import { config } from 'dotenv';
import { scrapeWork } from './pipelines/scrapeWork.js';
import { scrapeSegment } from './pipelines/scrapeSegment.js';
import { runJobRunner, runOnce } from './pipelines/jobRunner.js';
import { listTemplates } from './config/templates.js';
import { validateEnv } from './config/env.js';
import { logger } from './utils/logger.js';
import type { MediaType } from './extractors/types.js';

config();

const program = new Command();

program
  .name('scraper-worker')
  .description('Automated scraping worker for ChapterBridge Dashboard')
  .version('1.0.0');

program
  .command('scrape:work')
  .description('Scrape a work page to extract segment list')
  .requiredOption('--url <url>', 'URL of the work page')
  .requiredOption('--media <type>', 'Media type (novel, manhwa, anime)')
  .requiredOption('--provider <provider>', 'Provider name')
  .requiredOption('--template <name>', 'Template name to use')
  .requiredOption('--title <title>', 'Work title')
  .action(async (options) => {
    try {
      if (!validateEnv()) {
        logger.error('Environment validation failed. Check your .env file.');
        process.exit(1);
      }

      const mediaTypes: MediaType[] = ['novel', 'manhwa', 'anime'];
      if (!mediaTypes.includes(options.media as MediaType)) {
        logger.error({ media: options.media }, 'Invalid media type. Must be: novel, manhwa, anime');
        process.exit(1);
      }

      await scrapeWork({
        url: options.url,
        media: options.media as MediaType,
        provider: options.provider,
        template: options.template,
        title: options.title,
      });

      logger.info('scrape:work completed successfully');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'scrape:work failed');
      process.exit(1);
    }
  });

program
  .command('scrape:segment')
  .description('Scrape a segment page to extract assets')
  .requiredOption('--url <url>', 'URL of the segment page')
  .requiredOption('--segmentId <uuid>', 'Segment ID from Supabase')
  .requiredOption('--template <name>', 'Template name to use')
  .option('--download', 'Download and upload assets to R2', false)
  .action(async (options) => {
    try {
      if (!validateEnv()) {
        logger.error('Environment validation failed. Check your .env file.');
        process.exit(1);
      }

      await scrapeSegment({
        url: options.url,
        segmentId: options.segmentId,
        template: options.template,
        download: options.download,
      });

      logger.info('scrape:segment completed successfully');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'scrape:segment failed');
      process.exit(1);
    }
  });

program
  .command('jobs:run')
  .description('Run job runner to process queued jobs')
  .option('--poll <ms>', 'Polling interval in milliseconds', '5000')
  .option('--once', 'Run only once and exit', false)
  .action(async (options) => {
    try {
      if (!validateEnv()) {
        logger.error('Environment validation failed. Check your .env file.');
        process.exit(1);
      }

      const pollInterval = parseInt(options.poll, 10);

      if (options.once) {
        await runOnce();
        process.exit(0);
      }

      await runJobRunner({ poll: pollInterval });
    } catch (error) {
      logger.error({ error }, 'jobs:run failed');
      process.exit(1);
    }
  });

program
  .command('templates:list')
  .description('List available templates')
  .action(() => {
    try {
      const templates = listTemplates();
      
      if (templates.length === 0) {
        console.log('No templates found in templates/ directory');
        return;
      }

      console.log('Available templates:');
      templates.forEach((t) => {
        console.log(`  - ${t}`);
      });
    } catch (error) {
      logger.error({ error }, 'Failed to list templates');
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Validate environment configuration')
  .action(() => {
    try {
      if (validateEnv()) {
        console.log('Environment configuration is valid');
        process.exit(0);
      } else {
        console.log('Environment configuration is invalid. Check your .env file.');
        process.exit(1);
      }
    } catch (error) {
      logger.error({ error }, 'Validation failed');
      process.exit(1);
    }
  });

program.parse();
