import { config } from 'dotenv';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

config();

const envSchema = z.object({
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  CLOUDFLARE_R2_ENDPOINT: z.string().url('CLOUDFLARE_R2_ENDPOINT must be a valid URL'),
  CLOUDFLARE_R2_ACCESS_KEY_ID: z.string().min(1, 'CLOUDFLARE_R2_ACCESS_KEY_ID is required'),
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: z.string().min(1, 'CLOUDFLARE_R2_SECRET_ACCESS_KEY is required'),
  CLOUDFLARE_R2_BUCKET: z.string().min(1, 'CLOUDFLARE_R2_BUCKET is required'),
  CLOUDFLARE_R2_PUBLIC_BASE_URL: z.string().url('CLOUDFLARE_R2_PUBLIC_BASE_URL must be a valid URL').optional(),
  USER_AGENT: z.string().default('Mozilla/5.0 (compatible; ChapterBridgeBot/1.0; +http://example.com/bot)'),
  DEFAULT_RATE_LIMIT_MS: z.coerce.number().default(500),
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedEnv: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (cachedEnv) {
    return cachedEnv;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    logger.error({ errors: result.error.flatten().fieldErrors }, 'Environment validation failed');
    throw new Error(`Environment validation failed: ${result.error.message}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

export function validateEnv(): boolean {
  try {
    getEnv();
    return true;
  } catch {
    return false;
  }
}
