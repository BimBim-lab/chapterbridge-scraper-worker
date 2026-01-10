import { parseArgs } from 'util';
import { OpenSubtitlesExtractor } from '../../extractors/opensubtitles.js';
import { loadTemplate } from '../../config/templates.js';
import { logger } from '../../utils/logger.js';
import {
  insertWork,
  insertEdition,
  insertSegment,
  getWorkById,
  createJob,
  updateJobStatus,
  type CreateJobParams,
} from '../../services/supabase.js';

interface Args {
  url: string;
  workId?: string;
  title?: string;
  provider?: string;
}

function parseArguments(): Args {
  const { values } = parseArgs({
    options: {
      url: {
        type: 'string',
        short: 'u',
      },
      workId: {
        type: 'string',
        short: 'w',
      },
      title: {
        type: 'string',
        short: 't',
      },
      provider: {
        type: 'string',
        short: 'p',
        default: 'opensubtitles',
      },
    },
  });

  if (!values.url || typeof values.url !== 'string') {
    throw new Error('--url is required (e.g., https://www.opensubtitles.com/en/tvshows/2024-solo-leveling)');
  }

  return {
    url: values.url,
    workId: values.workId,
    title: values.title,
    provider: values.provider || 'opensubtitles',
  };
}

let jobId: string | null = null;

async function main() {
  
  try {
    const args = parseArguments();
    logger.info(args, 'Starting OpenSubtitles work scrape');

    const template = loadTemplate('opensubtitles');
    const extractor = new OpenSubtitlesExtractor();

    // Scrape the work page to get all episodes
    const result = await extractor.scrapeWork(args.url, template);

    logger.info({ segmentCount: result.segments.length }, 'Scraped work successfully');

    // Create or get work
    let workId = args.workId;
    if (!workId) {
      if (!args.title) {
        throw new Error('--title is required when creating a new work');
      }
      workId = await insertWork(args.title);
      logger.info({ workId, title: args.title }, 'Created new work');
    } else {
      const work = await getWorkById(workId);
      if (!work) {
        throw new Error(`Work not found: ${workId}`);
      }
      logger.info({ workId, title: work.title }, 'Using existing work');
    }

    // Create pipeline job
    jobId = await createJob({
      jobType: 'scrape',
      workId: workId,
      input: {
        url: args.url,
        provider: args.provider,
        scriptType: 'scrape-opensubtitles-work',
        totalSegments: result.segments.length,
      }
    });
    logger.info({ jobId }, 'Created pipeline job');
    await updateJobStatus(jobId, 'running');

    // Parse season map from metadata
    const urlToSeasonMap = new Map<string, number>();
    if (result.metadata?.seasonMap) {
      const seasonMapData = JSON.parse(result.metadata.seasonMap as string) as [string, number][];
      for (const [url, season] of seasonMapData) {
        urlToSeasonMap.set(url, season);
      }
    }

    // Group episodes by season (extracted from URL map)
    const seasonMap = new Map<number, typeof result.segments>();
    
    for (const segment of result.segments) {
      // Get season from URL map
      const seasonNum = urlToSeasonMap.get(segment.url) || 1;
      
      if (!seasonMap.has(seasonNum)) {
        seasonMap.set(seasonNum, []);
      }
      seasonMap.get(seasonNum)!.push(segment);
    }

    // Create editions (seasons) and segments (episodes)
    for (const [seasonNumber, episodes] of seasonMap.entries()) {
      logger.info({ seasonNumber, episodeCount: episodes.length }, 'Processing season');

      // Create edition for this season
      const editionId = await insertEdition({
        workId,
        mediaType: 'anime',
        provider: `${args.provider}-s${seasonNumber}`,
        canonicalUrl: args.url,
        isOfficial: false,
      });

      logger.info({ editionId, seasonNumber }, 'Created edition');

      // Create segments for each episode
      // Use sequential numbering across all episodes (1, 2, 3...)
      for (const episode of episodes) {
        const segmentId = await insertSegment({
          editionId,
          segmentType: 'episode',
          number: episode.number, // Sequential number from scraper
          title: episode.title,   // Format: "S01E01", "S02E13", etc.
          canonicalUrl: episode.url,
        });

        logger.info({
          segmentId,
          number: episode.number,
          title: episode.title,
          seasonNumber,
        }, 'Created segment');
      }
    }

    logger.info({ workId, seasonCount: seasonMap.size, totalEpisodes: result.segments.length }, 'Work scrape completed successfully');
    
    // Update job status to success
    if (jobId) {
      await updateJobStatus(jobId, 'success', {
        workId,
        seasonCount: seasonMap.size,
        totalEpisodes: result.segments.length,
      });
    }
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Work scrape failed');
    
    // Update job status to failed
    if (jobId) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await updateJobStatus(jobId, 'failed', undefined, errorMsg);
    }
    
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error('❌ Fatal error:', error);
  
  // Update job status to failed if job was created
  if (jobId) {
    try {
      await updateJobStatus(
        jobId, 
        'failed', 
        undefined, 
        error instanceof Error ? error.message : 'Unknown fatal error'
      );
      console.log('✅ Job status updated to failed');
    } catch (updateError) {
      console.error('⚠️  Failed to update job status:', updateError);
    }
  }
  
  process.exit(1);
});
