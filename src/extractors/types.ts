import type { TemplateConfig } from '../config/templates.js';

export interface SegmentItem {
  number: number;
  title: string;
  url: string;
}

export interface ChapterInfo {
  number: number;
  title: string;
  url: string;
}

export interface ExtractorResult {
  success: boolean;
  data?: {
    title?: string;
    contentHtml?: string;
    plainText?: string;
    wordCount?: number;
  };
  error?: string;
}

export interface WorkExtractResult {
  segments: SegmentItem[];
  metadata?: {
    title?: string;
    author?: string;
    description?: string;
    coverUrl?: string;
    seasonMap?: string; // JSON string of URL to season number mapping
  };
}

export interface AssetItem {
  url: string;
  type: 'image' | 'subtitle' | 'text';
  order?: number;
  filename?: string;
}

export interface AssetExtractResult {
  images: string[];
  subtitles: string[];
  texts: string[];
  assets?: AssetItem[];
}

export interface Extractor {
  name: string;
  scrapeWork(url: string, config: TemplateConfig): Promise<WorkExtractResult>;
  scrapeSegment(url: string, config: TemplateConfig): Promise<AssetExtractResult>;
}

export type MediaType = 'novel' | 'manhwa' | 'anime';

export interface ScrapeWorkOptions {
  url: string;
  media: MediaType;
  provider: string;
  template: string;
  title: string;
}

export interface ScrapeSegmentOptions {
  url: string;
  segmentId: string;
  template: string;
  download: boolean;
}

export interface JobRunOptions {
  poll: number;
}
