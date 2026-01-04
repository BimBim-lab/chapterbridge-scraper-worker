import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const templateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  selectors: z.object({
    chapters: z.string().optional(),
    chapterNumber: z.string().optional(),
    chapterTitle: z.string().optional(),
    image: z.string().optional(),
    subtitle: z.string().optional(),
    text: z.string().optional(),
    textContainer: z.string().optional(),
  }),
  patterns: z.object({
    chapterNumberRegex: z.string().optional(),
    imageUrlPattern: z.string().optional(),
  }).optional(),
  pagination: z.object({
    nextPage: z.string().optional(),
    maxPages: z.number().optional(),
  }).optional(),
});

export type TemplateConfig = z.infer<typeof templateSchema>;

const templatesCache = new Map<string, TemplateConfig>();

export function getTemplatesDir(): string {
  return join(__dirname, '../../templates');
}

export function loadTemplate(name: string): TemplateConfig {
  if (templatesCache.has(name)) {
    return templatesCache.get(name)!;
  }

  const templatesDir = getTemplatesDir();
  const templatePath = join(templatesDir, `${name}.json`);

  if (!existsSync(templatePath)) {
    logger.error({ templatePath, name }, 'Template not found');
    throw new Error(`Template "${name}" not found at ${templatePath}`);
  }

  try {
    const content = readFileSync(templatePath, 'utf-8');
    const parsed = JSON.parse(content);
    const validated = templateSchema.parse(parsed);
    templatesCache.set(name, validated);
    logger.info({ name }, 'Template loaded successfully');
    return validated;
  } catch (error) {
    logger.error({ error, name }, 'Failed to load template');
    throw new Error(`Failed to load template "${name}": ${error}`);
  }
}

export function listTemplates(): string[] {
  const templatesDir = getTemplatesDir();
  if (!existsSync(templatesDir)) {
    return [];
  }

  const files = readdirSync(templatesDir);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}
