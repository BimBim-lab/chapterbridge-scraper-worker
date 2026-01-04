import axios from 'axios';
import * as cheerio from 'cheerio';
import type { TemplateConfig } from '../config/templates.js';
import type { Extractor, WorkExtractResult, AssetExtractResult, SegmentItem } from './types.js';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

export class GenericHtmlExtractor implements Extractor {
  name = 'generic-html';

  private async fetchPage(url: string): Promise<cheerio.CheerioAPI> {
    const env = getEnv();
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': env.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 30000,
    });

    return cheerio.load(response.data);
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
