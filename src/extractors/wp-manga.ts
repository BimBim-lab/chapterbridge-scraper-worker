import axios from 'axios';
import * as cheerio from 'cheerio';
import type { TemplateConfig } from '../config/templates.js';
import type { Extractor, WorkExtractResult, AssetExtractResult, SegmentItem } from './types.js';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

export class WpMangaExtractor implements Extractor {
  name = 'wp-manga';

  private async fetchPage(url: string): Promise<cheerio.CheerioAPI> {
    const env = getEnv();
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': env.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': new URL(url).origin,
      },
      timeout: 30000,
    });

    return cheerio.load(response.data);
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
