import axios from 'axios';
import * as cheerio from 'cheerio';
import type { TemplateConfig } from '../config/templates.js';
import type { Extractor, WorkExtractResult, AssetExtractResult, SegmentItem } from './types.js';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

export class WpMangaExtractor implements Extractor {
  name = 'wp-manga';

  private userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];

  private getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  private async randomDelay(min: number = 1500, max: number = 3500): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  private async fetchPage(url: string, retries: number = 3): Promise<cheerio.CheerioAPI> {
    const env = getEnv();
    
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
            'Referer': new URL(url).origin + '/',
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

  async scrapeWork(url: string, config: TemplateConfig): Promise<WorkExtractResult> {
    logger.info({ url, extractor: this.name }, 'Scraping WP-Manga work page');
    
    const $ = await this.fetchPage(url);
    const segments: SegmentItem[] = [];

    const chaptersSelector = config.selectors.chapters || '.wp-manga-chapter a';

    $(chaptersSelector).each((index, element) => {
      const $el = $(element);
      const href = $el.attr('href');
      
      if (!href) return;

      let title = $el.text().trim();
      let number = index + 1;

      const chapterMatch = title.match(/chapter\s*(\d+(?:\.\d+)?)/i) || 
                          href.match(/chapter[_-]?(\d+(?:\.\d+)?)/i);
      
      if (chapterMatch) {
        number = parseFloat(chapterMatch[1]);
      }

      const fullUrl = new URL(href, url).toString();

      segments.push({
        number,
        title: title || `Chapter ${number}`,
        url: fullUrl,
      });
    });

    segments.sort((a, b) => a.number - b.number);

    logger.info({ count: segments.length }, 'Extracted segments from WP-Manga work page');
    return { segments };
  }

  async scrapeSegment(url: string, config: TemplateConfig): Promise<AssetExtractResult> {
    logger.info({ url, extractor: this.name }, 'Scraping WP-Manga segment page');
    
    const $ = await this.fetchPage(url);
    const images: string[] = [];
    const subtitles: string[] = [];
    const texts: string[] = [];

    const imageSelector = config.selectors.image || 'img.wp-manga-chapter-img, .reading-content img';

    $(imageSelector).each((_, element) => {
      const $img = $(element);
      const src = $img.attr('src') || 
                  $img.attr('data-src') || 
                  $img.attr('data-lazy-src') ||
                  $img.attr('data-cfsrc');
      
      if (src) {
        const cleanSrc = src.trim();
        if (cleanSrc && !cleanSrc.startsWith('data:')) {
          const fullUrl = new URL(cleanSrc, url).toString();
          images.push(fullUrl);
        }
      }
    });

    logger.info({ images: images.length }, 'Extracted images from WP-Manga segment page');

    return { images, subtitles, texts };
  }
}

export default new WpMangaExtractor();
