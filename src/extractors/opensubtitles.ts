import axios from 'axios';
import * as cheerio from 'cheerio';
import type { Extractor, AssetExtractResult, WorkExtractResult, SegmentItem } from './types.js';
import type { TemplateConfig } from '../config/templates.js';
import { logger } from '../utils/logger.js';

export class OpenSubtitlesExtractor implements Extractor {
  name = 'opensubtitles';

  private userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];

  private getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  private async randomDelay(min: number = 1000, max: number = 2500): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  private async fetchPage(url: string, retries: number = 3): Promise<cheerio.CheerioAPI> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        if (attempt > 0) {
          const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10000);
          logger.info({ attempt: attempt + 1, delay: backoffDelay }, 'Retrying after delay');
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        } else {
          await this.randomDelay();
        }
        
        const response = await axios.get(url, {
          headers: {
            'User-Agent': this.getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
          },
          timeout: 45000,
          maxRedirects: 5,
          validateStatus: (status) => status < 500,
        });

        if (response.status === 429) {
          logger.warn({ attempt: attempt + 1 }, 'Rate limited, will retry');
          continue;
        }

        if (response.status >= 400) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return cheerio.load(response.data);
      } catch (error) {
        const isLastAttempt = attempt === retries - 1;
        logger.error({ 
          error: error instanceof Error ? error.message : String(error), 
          attempt: attempt + 1, 
          retries 
        }, isLastAttempt ? 'Failed to fetch page after all retries' : 'Failed to fetch page, will retry');
        
        if (isLastAttempt) {
          throw error;
        }
      }
    }

    throw new Error('Failed to fetch page after all retries');
  }

  async scrapeSegment(url: string, config: TemplateConfig): Promise<AssetExtractResult> {
    try {
      logger.info({ url }, 'Scraping OpenSubtitles episode page');

      const $ = await this.fetchPage(url);
      const subtitles: string[] = [];

      // Extract subtitle download links from the episode page
      // OpenSubtitles has subtitle entries in a list
      const subtitleSelector = config.selectors.subtitle || 'a.download-link';
      
      $(subtitleSelector).each((_, element) => {
        const href = $(element).attr('href');
        if (href) {
          // Make sure it's an absolute URL
          const subtitleUrl = href.startsWith('http') 
            ? href 
            : `https://www.opensubtitles.com${href}`;
          subtitles.push(subtitleUrl);
        }
      });

      logger.info({ url, subtitleCount: subtitles.length }, 'Extracted subtitles from episode page');

      return {
        images: [],
        subtitles,
        texts: [],
      };
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error), url }, 'Failed to scrape OpenSubtitles episode');
      throw error;
    }
  }

  /**
   * Scrape work page to get all seasons and episodes
   * Returns a structure with all episodes as segments
   */
  async scrapeWork(url: string, config: TemplateConfig): Promise<WorkExtractResult> {
    try {
      logger.info({ url }, 'Scraping OpenSubtitles work page');

      const $ = await this.fetchPage(url);
      const segments: SegmentItem[] = [];
      // Map untuk menyimpan season info untuk setiap segment URL
      const seasonMap = new Map<string, number>();

      // Find all season panels
      const seasonPanels = $('#accordion-list > li.panel');
      
      seasonPanels.each((_, seasonElement) => {
        const $season = $(seasonElement);
        
        // Extract season number from "Season X" text
        const seasonText = $season.find('.box-sub-season-link').text().trim();
        const seasonMatch = seasonText.match(/Season\s+(\d+)/i);
        
        if (!seasonMatch) {
          logger.warn({ seasonText }, 'Could not extract season number');
          return;
        }
        
        const seasonNumber = parseInt(seasonMatch[1], 10);

        // Find all episodes in this season
        const episodeList = $season.find('.list-subtitles-inside > li.box-sub');
        
        episodeList.each((_, episodeElement) => {
          const $episode = $(episodeElement);
          
          // Extract episode label (e.g., "S01E01")
          const episodeLabel = $episode.find('.label-default').text().trim();
          
          // Extract episode title and URL
          const episodeLink = $episode.find('.box-sub-headline a');
          const episodeTitle = episodeLink.text().trim();
          const episodeHref = episodeLink.attr('href');
          
          if (episodeHref && episodeLabel) {
            const episodeUrl = episodeHref.startsWith('http')
              ? episodeHref
              : `https://www.opensubtitles.com${episodeHref}`;
            
            // Sequential number starting from 1
            const sequentialNumber = segments.length + 1;

            // Save season info for this URL
            seasonMap.set(episodeUrl, seasonNumber);

            segments.push({
              number: sequentialNumber,
              title: episodeLabel,
              url: episodeUrl,
            });
          }
        });

        logger.info({ seasonNumber, episodeCount: episodeList.length }, 'Extracted season');
      });

      logger.info({ url, segmentCount: segments.length }, 'Completed work scrape');

      return {
        segments,
        metadata: {
          title: $('h1').first().text().trim() || undefined,
          // Store season map as JSON string in metadata
          seasonMap: JSON.stringify(Array.from(seasonMap.entries())),
        },
      };
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error), url }, 'Failed to scrape OpenSubtitles work');
      throw error;
    }
  }
}
