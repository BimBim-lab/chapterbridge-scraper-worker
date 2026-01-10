import axios from 'axios';
import * as cheerio from 'cheerio';
import type { TemplateConfig } from '../config/templates.js';
import type { Extractor, WorkExtractResult, AssetExtractResult, SegmentItem } from './types.js';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

export class GenericHtmlExtractor implements Extractor {
  name = 'generic-html';

  private userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  ];

  private getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  private async randomDelay(min: number = 2000, max: number = 5000): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  private async fetchPage(url: string, retries: number = 3): Promise<cheerio.CheerioAPI> {
    const env = getEnv();
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Random delay between requests
        if (attempt > 0) {
          const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10000);
          logger.info({ attempt: attempt + 1, delay: backoffDelay }, 'Retrying after delay');
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        } else {
          await this.randomDelay(1500, 3500);
        }
        
        const response = await axios.get(url, {
          headers: {
            'User-Agent': this.getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0',
            'DNT': '1',
          },
          timeout: 45000,
          maxRedirects: 5,
          validateStatus: (status) => status < 500, // Don't throw on 4xx
        });

        if (response.status === 429) {
          logger.warn({ attempt: attempt + 1 }, 'Rate limited, will retry');
          continue;
        }

        if (response.status >= 400) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        logger.info({ url, attempt: attempt + 1 }, 'Successfully fetched page');
        return cheerio.load(response.data);
      } catch (error) {
        const isLastAttempt = attempt === retries - 1;
        logger.error({ 
          error: error instanceof Error ? error.message : String(error), 
          attempt: attempt + 1, 
          retries,
          url 
        }, isLastAttempt ? 'Failed to fetch page after all retries' : 'Failed to fetch page, will retry');
        
        if (isLastAttempt) {
          throw error;
        }
      }
    }

    throw new Error('Failed to fetch page after all retries');
  }

  async scrapeWork(url: string, config: TemplateConfig): Promise<WorkExtractResult> {
    logger.info({ url, template: config.name }, 'Scraping work page');
    
    const $ = await this.fetchPage(url);
    const segments: SegmentItem[] = [];

    const chaptersSelector = config.selectors.chapters;
    if (!chaptersSelector) {
      logger.warn('No chapters selector defined in template');
      return { segments: [] };
    }

    $(chaptersSelector).each((index, element) => {
      const $el = $(element);
      const href = $el.attr('href');
      
      if (!href) return;

      let number = index + 1;
      let title = $el.text().trim();

      if (config.selectors.chapterNumber) {
        const numEl = $el.find(config.selectors.chapterNumber);
        if (numEl.length) {
          const numText = numEl.text().trim();
          const numMatch = numText.match(/\d+/);
          if (numMatch) {
            number = parseInt(numMatch[0], 10);
          }
        }
      }

      if (config.patterns?.chapterNumberRegex) {
        const regex = new RegExp(config.patterns.chapterNumberRegex);
        const match = title.match(regex) || href.match(regex);
        if (match && match[1]) {
          number = parseInt(match[1], 10);
        }
      }

      if (config.selectors.chapterTitle) {
        const titleEl = $el.find(config.selectors.chapterTitle);
        if (titleEl.length) {
          title = titleEl.text().trim();
        }
      }

      const fullUrl = new URL(href, url).toString();

      segments.push({
        number,
        title: title || `Chapter ${number}`,
        url: fullUrl,
      });
    });

    segments.sort((a, b) => a.number - b.number);

    logger.info({ count: segments.length }, 'Extracted segments from work page');
    return { segments };
  }

  async scrapeSegment(url: string, config: TemplateConfig): Promise<AssetExtractResult> {
    logger.info({ url, template: config.name }, 'Scraping segment page');
    
    const $ = await this.fetchPage(url);
    const images: string[] = [];
    const subtitles: string[] = [];
    const texts: string[] = [];

    if (config.selectors.image) {
      $(config.selectors.image).each((_, element) => {
        const src = $(element).attr('src') || $(element).attr('data-src') || $(element).attr('data-lazy-src');
        if (src) {
          const fullUrl = new URL(src, url).toString();
          images.push(fullUrl);
        }
      });
    }

    if (config.selectors.subtitle) {
      $(config.selectors.subtitle).each((_, element) => {
        const src = $(element).attr('src') || $(element).attr('href');
        if (src) {
          const fullUrl = new URL(src, url).toString();
          subtitles.push(fullUrl);
        }
      });
    }

    if (config.selectors.text || config.selectors.textContainer) {
      const selector = config.selectors.textContainer || config.selectors.text;
      if (selector) {
        $(selector).each((_, element) => {
          const text = $(element).text().trim();
          if (text) {
            texts.push(text);
          }
        });
      }
    }

    logger.info({ 
      images: images.length, 
      subtitles: subtitles.length, 
      texts: texts.length 
    }, 'Extracted assets from segment page');

    return { images, subtitles, texts };
  }
}

export default new GenericHtmlExtractor();
