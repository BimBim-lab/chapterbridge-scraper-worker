import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

let s3Client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (s3Client) {
    return s3Client;
  }

  const env = getEnv();
  
  s3Client = new S3Client({
    region: 'auto',
    endpoint: env.CLOUDFLARE_R2_ENDPOINT,
    credentials: {
      accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    },
  });

  return s3Client;
}

export async function uploadToR2(
  key: string,
  body: Buffer | string,
  contentType?: string
): Promise<string> {
  const env = getEnv();
  const client = getR2Client();

  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;

  const command = new PutObjectCommand({
    Bucket: env.CLOUDFLARE_R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  });

  try {
    await client.send(command);
    logger.info({ key, size: buffer.length }, 'Uploaded object to R2');
    return key;
  } catch (error) {
    logger.error({ error, key }, 'Failed to upload to R2');
    throw new Error(`Failed to upload to R2: ${error}`);
  }
}

export async function downloadFromR2(key: string): Promise<Buffer> {
  const env = getEnv();
  const client = getR2Client();

  const command = new GetObjectCommand({
    Bucket: env.CLOUDFLARE_R2_BUCKET,
    Key: key,
  });

  try {
    const response = await client.send(command);
    const chunks: Uint8Array[] = [];
    
    if (response.Body) {
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
    }

    return Buffer.concat(chunks);
  } catch (error) {
    logger.error({ error, key }, 'Failed to download from R2');
    throw new Error(`Failed to download from R2: ${error}`);
  }
}

export async function listR2Objects(prefix: string): Promise<string[]> {
  const env = getEnv();
  const client = getR2Client();

  const allKeys: string[] = [];
  let continuationToken: string | undefined;

  try {
    do {
      const command = new ListObjectsV2Command({
        Bucket: env.CLOUDFLARE_R2_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const response = await client.send(command);
      const keys = (response.Contents || []).map((obj) => obj.Key!).filter(Boolean);
      allKeys.push(...keys);

      continuationToken = response.NextContinuationToken;
      
      if (continuationToken) {
        logger.debug({ prefix, currentCount: allKeys.length }, 'Fetching next page of R2 objects');
      }
    } while (continuationToken);

    logger.info({ prefix, count: allKeys.length }, 'Listed all R2 objects');
    return allKeys;
  } catch (error) {
    logger.error({ error, prefix }, 'Failed to list R2 objects');
    throw new Error(`Failed to list R2 objects: ${error}`);
  }
}

export async function deleteFromR2(key: string): Promise<void> {
  const env = getEnv();
  const client = getR2Client();

  const command = new DeleteObjectCommand({
    Bucket: env.CLOUDFLARE_R2_BUCKET,
    Key: key,
  });

  try {
    await client.send(command);
    logger.info({ key }, 'Deleted object from R2');
  } catch (error) {
    logger.error({ error, key }, 'Failed to delete from R2');
    throw new Error(`Failed to delete from R2: ${error}`);
  }
}

export function getPublicUrl(key: string): string {
  const env = getEnv();
  
  if (env.CLOUDFLARE_R2_PUBLIC_BASE_URL) {
    return `${env.CLOUDFLARE_R2_PUBLIC_BASE_URL}/${key}`;
  }
  
  return `${env.CLOUDFLARE_R2_ENDPOINT}/${env.CLOUDFLARE_R2_BUCKET}/${key}`;
}

export function buildR2Key(
  media: string,
  workId: string,
  editionId: string,
  filename: string,
  segmentInfo?: { type: string; number: number }
): string {
  const basePath = `raw/${media}/${workId}/${editionId}`;
  
  if (segmentInfo) {
    return `${basePath}/${segmentInfo.type}-${segmentInfo.number}/${filename}`;
  }
  
  return `${basePath}/${filename}`;
}
