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
    .eq('canonical_title', title)
    .single();

  if (existing) {
    logger.info({ workId: existing.id, title }, 'Work already exists');
    return existing.id;
  }

  const { data, error } = await supabase
    .from('works')
    .insert({ canonical_title: title })
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
      media,
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
  edition?: {
    id: string;
    work_id: string;
    media: string;
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
      edition:editions (
        id,
        work_id,
        media
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
  uploadSource: string
): Promise<string> {
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('assets')
    .select('id')
    .eq('sha256', sha256)
    .single();

  if (existing) {
    logger.info({ assetId: existing.id, sha256 }, 'Asset with same hash already exists');
    return existing.id;
  }

  const { data, error } = await supabase
    .from('assets')
    .insert({
      r2_key: r2Key,
      asset_type: assetType,
      bytes,
      sha256,
      upload_source: uploadSource,
    })
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
): Promise<void> {
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('segment_assets')
    .select('id')
    .eq('segment_id', segmentId)
    .eq('asset_id', assetId)
    .single();

  if (existing) {
    logger.info({ segmentId, assetId }, 'Asset already attached to segment');
    return;
  }

  const { error } = await supabase
    .from('segment_assets')
    .insert({
      segment_id: segmentId,
      asset_id: assetId,
      role: role || 'page',
    });

  if (error) {
    logger.error({ error, segmentId, assetId }, 'Failed to attach asset to segment');
    throw new Error(`Failed to attach asset to segment: ${error.message}`);
  }

  logger.info({ segmentId, assetId, role }, 'Attached asset to segment');
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
    updated_at: new Date().toISOString(),
  };

  if (output) {
    updateData.output = output;
  }

  if (errorMsg) {
    updateData.error = errorMsg;
  }

  if (status === 'success' || status === 'failed') {
    updateData.completed_at = new Date().toISOString();
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
