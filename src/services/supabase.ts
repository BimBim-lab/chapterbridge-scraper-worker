import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';
import { logger } from '../utils/logger.js';

let supabaseClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient;
  }

  const env = getEnv();
  supabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  return supabaseClient;
}

export async function upsertWork(title: string): Promise<string> {
  const supabase = getSupabase();
  
  const { data: existing } = await supabase
    .from('works')
    .select('id')
    .eq('title', title)
    .single();

  if (existing) {
    logger.info({ workId: existing.id, title }, 'Work already exists');
    return existing.id;
  }

  const { data, error } = await supabase
    .from('works')
    .insert({ title: title })
    .select('id')
    .single();

  if (error) {
    logger.error({ error, title }, 'Failed to create work');
    throw new Error(`Failed to create work: ${error.message}`);
  }

  logger.info({ workId: data.id, title }, 'Created new work');
  return data.id;
}

export async function upsertEdition(
  workId: string,
  media: string,
  provider: string,
  canonicalUrl: string
): Promise<string> {
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('editions')
    .select('id')
    .eq('work_id', workId)
    .eq('media_type', media)
    .eq('provider', provider)
    .eq('canonical_url', canonicalUrl)
    .single();

  if (existing) {
    logger.info({ editionId: existing.id }, 'Edition already exists');
    return existing.id;
  }

  const { data, error } = await supabase
    .from('editions')
    .insert({
      work_id: workId,
      media_type: media,
      provider,
      canonical_url: canonicalUrl,
    })
    .select('id')
    .single();

  if (error) {
    logger.error({ error, workId, provider }, 'Failed to create edition');
    throw new Error(`Failed to create edition: ${error.message}`);
  }

  logger.info({ editionId: data.id }, 'Created new edition');
  return data.id;
}

export async function upsertSegment(
  editionId: string,
  number: number,
  title: string,
  canonicalUrl: string
): Promise<string> {
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('segments')
    .select('id')
    .eq('edition_id', editionId)
    .eq('number', number)
    .single();

  if (existing) {
    await supabase
      .from('segments')
      .update({ title, canonical_url: canonicalUrl })
      .eq('id', existing.id);

    logger.info({ segmentId: existing.id, number }, 'Updated existing segment');
    return existing.id;
  }

  const { data, error } = await supabase
    .from('segments')
    .insert({
      edition_id: editionId,
      number,
      title,
      canonical_url: canonicalUrl,
      segment_type: 'chapter',
    })
    .select('id')
    .single();

  if (error) {
    logger.error({ error, editionId, number }, 'Failed to create segment');
    throw new Error(`Failed to create segment: ${error.message}`);
  }

  logger.info({ segmentId: data.id, number }, 'Created new segment');
  return data.id;
}

export interface SegmentWithEdition {
  id: string;
  edition_id: string;
  number: number;
  segment_type: string;
  title?: string;
  edition?: {
    id: string;
    work_id: string;
    media_type: string;
  };
}

export async function getSegmentById(segmentId: string): Promise<SegmentWithEdition | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('segments')
    .select(`
      id,
      edition_id,
      number,
      segment_type,
      title,
      edition:editions (
        id,
        work_id,
        media_type
      )
    `)
    .eq('id', segmentId)
    .single();

  if (error) {
    logger.error({ error, segmentId }, 'Failed to get segment');
    return null;
  }

  const editionData = Array.isArray(data.edition) ? data.edition[0] : data.edition;

  return {
    id: data.id,
    edition_id: data.edition_id,
    number: data.number,
    segment_type: data.segment_type,
    edition: editionData,
  };
}

export async function insertAsset(
  r2Key: string,
  assetType: string,
  bytes: number,
  sha256: string,
  uploadSource: string,
  contentType?: string,
  sourceUrl?: string,
  originalFilename?: string
): Promise<string> {
  const supabase = getSupabase();

  // First check by r2_key (unique identifier)
  const { data: existingByKey } = await supabase
    .from('assets')
    .select('id')
    .eq('r2_key', r2Key)
    .maybeSingle();

  if (existingByKey) {
    logger.info({ assetId: existingByKey.id, r2Key }, 'Asset with same r2_key already exists');
    return existingByKey.id;
  }

  // Then check by sha256 (for deduplication info only)
  const { data: existingByHash } = await supabase
    .from('assets')
    .select('id, r2_key')
    .eq('sha256', sha256)
    .maybeSingle();

  if (existingByHash) {
    logger.info({ assetId: existingByHash.id, sha256, existingKey: existingByHash.r2_key, newKey: r2Key }, 'Asset with same hash already exists, creating new record for different r2_key');
    // Don't return - create new asset record with different r2_key
  }

  const insertData: Record<string, unknown> = {
    provider: 'cloudflare_r2',
    bucket: process.env.CLOUDFLARE_R2_BUCKET || 'chapterbridge-data',
    r2_key: r2Key,
    asset_type: assetType,
    content_type: contentType || null,
    bytes,
    sha256,
    upload_source: uploadSource,
  };

  // TODO: Add metadata column to assets table in Supabase
  // For now, skip metadata to avoid errors
  // if (sourceUrl) {
  //   insertData.metadata = { source_url: sourceUrl };
  // }
  // if (originalFilename) {
  //   insertData.metadata = { ...insertData.metadata as object, original_filename: originalFilename };
  // }

  const { data, error } = await supabase
    .from('assets')
    .insert(insertData)
    .select('id')
    .single();

  if (error) {
    logger.error({ error, r2Key }, 'Failed to create asset');
    throw new Error(`Failed to create asset: ${error.message}`);
  }

  logger.info({ assetId: data.id, r2Key }, 'Created new asset');
  return data.id;
}

export async function attachAssetToSegment(
  segmentId: string,
  assetId: string,
  role?: string
): Promise<boolean> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('segment_assets')
    .upsert(
      {
        segment_id: segmentId,
        asset_id: assetId,
        role: role || 'page',
      },
      {
        onConflict: 'segment_id,asset_id',
        ignoreDuplicates: true,
      }
    )
    .select()
    .maybeSingle();

  if (error) {
    logger.error({ error, segmentId, assetId }, 'Failed to attach asset to segment');
    return false;
  }

  logger.info({ segmentId, assetId }, 'Attached asset to segment');
  return true;
}

export async function createJob(
  jobType: string,
  input: Record<string, unknown>
): Promise<string> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('pipeline_jobs')
    .insert({
      job_type: jobType,
      input,
      status: 'queued',
    })
    .select('id')
    .single();

  if (error) {
    logger.error({ error, jobType }, 'Failed to create job');
    throw new Error(`Failed to create job: ${error.message}`);
  }

  logger.info({ jobId: data.id, jobType }, 'Created new job');
  return data.id;
}

export async function updateJobStatus(
  jobId: string,
  status: 'running' | 'success' | 'failed',
  output?: Record<string, unknown>,
  errorMsg?: string
): Promise<void> {
  const supabase = getSupabase();

  const updateData: Record<string, unknown> = {
    status,
  };

  if (output) {
    updateData.output = output;
  }

  if (errorMsg) {
    updateData.error = errorMsg;
  }

  if (status === 'running') {
    updateData.started_at = new Date().toISOString();
  }

  if (status === 'success' || status === 'failed') {
    updateData.finished_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('pipeline_jobs')
    .update(updateData)
    .eq('id', jobId);

  if (error) {
    logger.error({ error, jobId, status }, 'Failed to update job status');
    throw new Error(`Failed to update job status: ${error.message}`);
  }

  logger.info({ jobId, status }, 'Updated job status');
}

export async function getQueuedJobs(limit = 1): Promise<Array<{
  id: string;
  job_type: string;
  input: Record<string, unknown>;
}>> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('pipeline_jobs')
    .select('id, job_type, input')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    logger.error({ error }, 'Failed to get queued jobs');
    throw new Error(`Failed to get queued jobs: ${error.message}`);
  }

  return data || [];
}

// Additional helper functions for OpenSubtitles scraper

export async function insertWork(title: string): Promise<string> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('works')
    .insert({ title })
    .select('id')
    .single();

  if (error) {
    logger.error({ error, title }, 'Failed to insert work');
    throw new Error(`Failed to insert work: ${error.message}`);
  }

  return data.id;
}

export async function getWorkById(workId: string): Promise<{ id: string; title: string } | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('works')
    .select('id, title')
    .eq('id', workId)
    .single();

  if (error) {
    logger.error({ error, workId }, 'Failed to get work by id');
    return null;
  }

  return data;
}

export async function insertEdition(params: {
  workId: string;
  mediaType: string;
  provider: string;
  canonicalUrl: string;
  isOfficial: boolean;
}): Promise<string> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('editions')
    .insert({
      work_id: params.workId,
      media_type: params.mediaType,
      provider: params.provider,
      canonical_url: params.canonicalUrl,
      is_official: params.isOfficial,
    })
    .select('id')
    .single();

  if (error) {
    logger.error({ error, params }, 'Failed to insert edition');
    throw new Error(`Failed to insert edition: ${error.message}`);
  }

  return data.id;
}

export async function insertSegment(params: {
  editionId: string;
  segmentType: string;
  number: number;
  title: string;
  canonicalUrl: string;
}): Promise<string> {
  const supabase = getSupabase();

  // Check if segment already exists (untuk handle duplicate episodes)
  const { data: existing } = await supabase
    .from('segments')
    .select('id')
    .eq('edition_id', params.editionId)
    .eq('segment_type', params.segmentType)
    .eq('number', params.number)
    .single();

  if (existing) {
    logger.info({ segmentId: existing.id, number: params.number }, 'Segment already exists, skipping');
    return existing.id;
  }

  const { data, error } = await supabase
    .from('segments')
    .insert({
      edition_id: params.editionId,
      segment_type: params.segmentType,
      number: params.number,
      title: params.title,
      canonical_url: params.canonicalUrl,
    })
    .select('id')
    .single();

  if (error) {
    // Handle duplicate key error gracefully
    if (error.code === '23505') {
      logger.warn({ params }, 'Duplicate segment detected, fetching existing');
      const { data: existingAfterError } = await supabase
        .from('segments')
        .select('id')
        .eq('edition_id', params.editionId)
        .eq('segment_type', params.segmentType)
        .eq('number', params.number)
        .single();
      
      if (existingAfterError) {
        return existingAfterError.id;
      }
    }
    
    logger.error({ error, params }, 'Failed to insert segment');
    throw new Error(`Failed to insert segment: ${error.message}`);
  }

  return data.id;
}
