import axios, { AxiosInstance } from 'axios';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

interface SearchSubtitlesParams {
  query?: string;
  languages?: string;
  season_number?: number;
  episode_number?: number;
  order_by?: 'download_count' | 'upload_date' | 'ratings';
  order_direction?: 'asc' | 'desc';
}

interface SubtitleResult {
  id: string;
  type: string;
  attributes: {
    subtitle_id: string;
    language: string;
    download_count: number;
    new_download_count: number;
    hearing_impaired: boolean;
    hd: boolean;
    fps: number;
    votes: number;
    ratings: number;
    from_trusted: boolean;
    foreign_parts_only: boolean;
    upload_date: string;
    ai_translated: boolean;
    machine_translated: boolean;
    release: string;
    comments: string;
    legacy_subtitle_id: number;
    uploader: {
      uploader_id: number;
      name: string;
      rank: string;
    };
    feature_details: {
      feature_id: number;
      feature_type: string;
      year: number;
      title: string;
      movie_name: string;
      imdb_id: number;
      tmdb_id: number;
      season_number?: number;
      episode_number?: number;
      parent_imdb_id?: number;
      parent_title?: string;
      parent_tmdb_id?: number;
      parent_feature_id?: number;
    };
    url: string;
    related_links: {
      label: string;
      url: string;
      img_url: string;
    }[];
    files: Array<{
      file_id: number;
      cd_number: number;
      file_name: string;
    }>;
  };
}

interface SearchResponse {
  total_pages: number;
  total_count: number;
  per_page: number;
  page: number;
  data: SubtitleResult[];
}

interface DownloadResponse {
  link: string;
  file_name: string;
  requests: number;
  remaining: number;
  message: string;
  reset_time: string;
  reset_time_utc: string;
}

export class OpenSubtitlesApiService {
  private apiKey: string;
  private client: AxiosInstance;
  private baseUrl: string;

  constructor() {
    const env = getEnv();
    
    if (!env.OPENSUBTITLES_API_KEY) {
      throw new Error('OPENSUBTITLES_API_KEY is required in environment variables');
    }

    this.apiKey = env.OPENSUBTITLES_API_KEY;
    this.baseUrl = process.env.OPENSUBTITLES_BASE_URL || 'https://api.opensubtitles.com/api/v1';
    
    logger.info({ baseUrl: this.baseUrl }, 'Initializing OpenSubtitles API client');

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Api-Key': this.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'ChapterBridge v1.0.0',
      },
      timeout: 30000,
    });
  }

  /**
   * Search for subtitles
   * Only requires Api-Key (no login/bearer token needed)
   */
  async searchSubtitles(params: SearchSubtitlesParams): Promise<SubtitleResult[]> {
    try {
      logger.info({ params }, 'Searching for subtitles');

      // Search endpoint only needs Api-Key header (set in axios defaults)
      const response = await this.client.get<SearchResponse>('/subtitles', {
        params: {
          ...params,
          languages: params.languages || 'en',
          order_by: params.order_by || 'download_count',
          order_direction: params.order_direction || 'desc',
        },
      });

      logger.info({ 
        totalCount: response.data.total_count,
        resultCount: response.data.data.length,
        page: response.data.page,
        totalPages: response.data.total_pages,
      }, 'Search completed');

      return response.data.data;
    } catch (error) {
      logger.error({ 
        error: error instanceof Error ? error.message : String(error),
        params,
      }, 'Failed to search subtitles');
      throw error;
    }
  }

  /**
   * Download a subtitle file
   */
  async downloadSubtitle(fileId: number): Promise<{ url: string; fileName: string; buffer: Buffer }> {
    try {
      logger.info({ fileId }, 'Requesting subtitle download');

      const response = await axios.post<DownloadResponse>(
        `${this.baseUrl}/download`,
        { file_id: fileId },
        {
          headers: {
            'Accept': 'application/json',
            'Api-Key': this.apiKey,
            'Content-Type': 'application/json',
            'User-Agent': 'ChapterBridge v1.0.0',
          },
          timeout: 30000,
        }
      );

      const { link, file_name, remaining } = response.data;

      logger.info({ 
        fileId, 
        fileName: file_name,
        remainingDownloads: remaining,
      }, 'Got download link');

      // Download the actual file from the temporary URL
      const fileResponse = await axios.get(link, {
        responseType: 'arraybuffer',
        timeout: 60000,
      });

      const buffer = Buffer.from(fileResponse.data);

      logger.info({ 
        fileId, 
        fileName: file_name,
        bytes: buffer.length,
      }, 'Downloaded subtitle file');

      return {
        url: link,
        fileName: file_name,
        buffer,
      };
    } catch (error) {
      logger.error({ 
        error: error instanceof Error ? error.message : String(error),
        fileId,
      }, 'Failed to download subtitle');
      throw error;
    }
  }

  /**
   * Search and download best subtitle for a specific episode
   */
  async searchAndDownloadBest(params: {
    query: string;
    seasonNumber: number;
    episodeNumber: number;
    languages?: string;
  }): Promise<{ fileId: number; fileName: string; buffer: Buffer; subtitleInfo: SubtitleResult }> {
    logger.info(params, 'Searching and downloading best subtitle');

    // Search for subtitles
    const results = await this.searchSubtitles({
      query: params.query,
      season_number: params.seasonNumber,
      episode_number: params.episodeNumber,
      languages: params.languages || 'en',
      order_by: 'download_count',
      order_direction: 'desc',
    });

    if (results.length === 0) {
      throw new Error(`No subtitles found for ${params.query} S${params.seasonNumber}E${params.episodeNumber}`);
    }

    // Get the first (best) result
    const bestSubtitle = results[0];
    
    // Get the first file (usually there's only one)
    if (!bestSubtitle.attributes.files || bestSubtitle.attributes.files.length === 0) {
      throw new Error('No files found in subtitle result');
    }

    const firstFile = bestSubtitle.attributes.files[0];
    const fileId = firstFile.file_id;

    logger.info({
      fileId,
      fileName: firstFile.file_name,
      language: bestSubtitle.attributes.language,
      downloadCount: bestSubtitle.attributes.download_count,
      rating: bestSubtitle.attributes.ratings,
      fromTrusted: bestSubtitle.attributes.from_trusted,
    }, 'Selected best subtitle');

    // Download the subtitle
    const download = await this.downloadSubtitle(fileId);

    return {
      fileId,
      fileName: download.fileName,
      buffer: download.buffer,
      subtitleInfo: bestSubtitle,
    };
  }
}

// Singleton instance
let apiService: OpenSubtitlesApiService | null = null;

export function getOpenSubtitlesApi(): OpenSubtitlesApiService {
  if (!apiService) {
    apiService = new OpenSubtitlesApiService();
  }
  return apiService;
}
