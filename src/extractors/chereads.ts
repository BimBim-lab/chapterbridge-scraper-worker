import * as cheerio from 'cheerio';
import { Page } from 'playwright';
import type { ChapterInfo, ExtractorResult } from './types.js';

interface ChereadsTemplate {
  config: {
    baseUrl: string;
    selectors: {
      chapterList: {
        container: string;
        item: string;
        link: string;
        number: string;
        title: string;
        href: string;
        date: string;
      };
      chapterContent: {
        container: string;
        title: string;
        content: string;
      };
    };
    filters: {
      skipItems: string[];
      minChapterNumber: number;
    };
  };
}

export class ChereadsExtractor {
  private template: ChereadsTemplate;

  constructor(template: ChereadsTemplate) {
    this.template = template;
  }

  /**
   * Extract chapter list from HTML
   */
  extractChapterList(html: string): ChapterInfo[] {
    const $ = cheerio.load(html);
    const chapters: ChapterInfo[] = [];
    const selectors = this.template.config.selectors.chapterList;

    $(selectors.container).find(selectors.item).each((_, element) => {
      const $el = $(element);
      const $link = $el.find(selectors.link);

      // Get chapter number
      const numberText = $link.find(selectors.number).text().trim();
      const chapterNumber = parseInt(numberText);

      // Filter: only process valid chapter numbers
      if (!isNaN(chapterNumber) && chapterNumber >= this.template.config.filters.minChapterNumber) {
        const title = $link.find(selectors.title).text().trim();
        const href = $link.attr('href');

        if (title && href) {
          const fullUrl = href.startsWith('http')
            ? href
            : `${this.template.config.baseUrl}${href}`;

          chapters.push({
            number: chapterNumber,
            title: title,
            url: fullUrl,
          });
        }
      }
    });

    // Sort by chapter number
    chapters.sort((a, b) => a.number - b.number);

    return chapters;
  }

  /**
   * Extract chapter content from HTML
   */
  extractChapterContent(html: string): ExtractorResult {
    const $ = cheerio.load(html);
    const selectors = this.template.config.selectors.chapterContent;

    // Extract title first (outside main content)
    const titleSelectors = selectors.title.split(',').map(s => s.trim());
    let title = '';
    
    for (const selector of titleSelectors) {
      const titleText = $(selector).first().text().trim();
      if (titleText && titleText.length > 0) {
        title = titleText;
        break;
      }
    }

    // Try multiple selectors for content
    let $contentContainer: cheerio.Cheerio<any> | null = null;
    const contentSelectors = selectors.content.split(',').map(s => s.trim());
    
    for (const selector of contentSelectors) {
      const elem = $(selector).first();
      if (elem.length > 0) {
        $contentContainer = elem;
        break;
      }
    }

    if (!$contentContainer || $contentContainer.length === 0) {
      return {
        success: false,
        error: 'Content container not found',
      };
    }

    // Clean content: remove scripts, styles, ads, title (keep only paragraphs)
    $contentContainer.find('script, style, iframe, .ad, .advertisement, h1, h2, h3').remove();

    // Get clean HTML with paragraphs
    const contentHtml = $contentContainer.html()?.trim() || '';
    const plainText = $contentContainer.text().trim();

    return {
      success: !!plainText && plainText.length > 100,
      data: {
        title,
        contentHtml,
        plainText,
        wordCount: plainText.split(/\s+/).length,
      },
      error: plainText.length > 100 ? undefined : 'Content too short or empty',
    };
  }

  /**
   * Scrape chapter list from page using Playwright
   */
  async scrapeChapterListPage(page: Page): Promise<ChapterInfo[]> {
    await page.waitForTimeout(2000);
    const html = await page.content();
    return this.extractChapterList(html);
  }

  /**
   * Scrape chapter content from page using Playwright
   */
  async scrapeChapterContentPage(page: Page): Promise<ExtractorResult> {
    await page.waitForTimeout(1500);
    const html = await page.content();
    return this.extractChapterContent(html);
  }

  /**
   * Validate if URL is from chereads.com
   */
  static isValidUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.includes('chereads.com');
    } catch {
      return false;
    }
  }

  /**
   * Extract novel ID from URL
   */
  static extractNovelId(url: string): string | null {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      
      // URL format: /chapterlist/{novel_id}/
      // or /novel/{novel_id}/{chapter_id}
      if (pathParts.length >= 2) {
        return pathParts[pathParts.length - 1];
      }
      
      return null;
    } catch {
      return null;
    }
  }
}
