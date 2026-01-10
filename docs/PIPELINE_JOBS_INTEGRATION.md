# Pipeline Jobs Integration

## Overview

Semua script scraping sekarang terintegrasi penuh dengan table `pipeline_jobs` di Supabase untuk tracking dan monitoring eksekusi job.

## Schema Pipeline Jobs

```sql
CREATE TABLE pipeline_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_type TEXT NOT NULL CHECK (job_type IN ('scrape', 'clean', 'summarize', 'entities', 'embed', 'match', 'sync_assets')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'success', 'failed')),
  source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
  work_id UUID REFERENCES works(id) ON DELETE SET NULL,
  edition_id UUID REFERENCES editions(id) ON DELETE SET NULL,
  segment_id UUID REFERENCES segments(id) ON DELETE SET NULL,
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB,
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
```

## Perubahan pada Services

### `src/services/supabase.ts`

#### 1. Interface `CreateJobParams`
```typescript
export interface CreateJobParams {
  jobType: 'scrape' | 'clean' | 'summarize' | 'entities' | 'embed' | 'match' | 'sync_assets';
  input: Record<string, unknown>;
  sourceId?: string;
  workId?: string;
  editionId?: string;
  segmentId?: string;
}
```

#### 2. Fungsi `createJob()` - Enhanced
- **Backward Compatible**: Masih support signature lama `createJob(jobType, input)`
- **New Signature**: `createJob(CreateJobParams)` untuk menyertakan work_id, edition_id, segment_id
- **Auto-fills**: `status: 'queued'`, `attempt: 0`
- **Returns**: `jobId` (UUID)

**Contoh Penggunaan:**
```typescript
// Legacy style (still works)
const jobId = await createJob('scrape', { url: '...' });

// New style (recommended)
const jobId = await createJob({
  jobType: 'scrape',
  workId: 'uuid-here',
  editionId: 'uuid-here',
  input: {
    url: '...',
    scriptType: 'scrape-readnovel-api'
  }
});
```

#### 3. Fungsi `updateJobStatus()` - Enhanced
- **Auto-increments**: `attempt` counter saat status = 'running'
- **Auto-fills**: `started_at` saat status = 'running'
- **Auto-fills**: `finished_at` saat status = 'success' atau 'failed'
- **Logs**: Menampilkan attempt number di log

**Contoh Penggunaan:**
```typescript
await updateJobStatus(jobId, 'running');
// Sets: started_at = NOW(), attempt = attempt + 1

await updateJobStatus(jobId, 'success', {
  totalChapters: 270,
  inserted: 270
});
// Sets: finished_at = NOW(), output = {...}

await updateJobStatus(jobId, 'failed', undefined, 'API timeout');
// Sets: finished_at = NOW(), error = 'API timeout'
```

## Integrasi per Script

### 1. `scrape-readnovel-api.ts` ✅
**Job Type**: `scrape`  
**Input**:
- `novelSlug`: Slug novel dari URL
- `scriptType`: `'scrape-readnovel-api'`
- `apiUrl`: URL API yang digunakan

**Output**:
- `editionId`: ID edition yang dibuat/digunakan
- `totalChapters`: Total chapter yang ditemukan
- `inserted`: Jumlah chapter baru
- `updated`: Jumlah chapter yang diupdate
- `skipped`: Jumlah chapter yang diskip
- `errors`: Jumlah error

**Work/Edition Tracking**:
- `work_id`: Diset saat job dibuat
- `edition_id`: Diupdate setelah edition dibuat/diambil

### 2. `scrape-readnovel-segment.ts` ✅
**Job Type**: `scrape`  
**Input**:
- `segmentIds`: Array of segment IDs yang akan di-scrape
- `scriptType`: `'scrape-readnovel-segment'`
- `totalSegments`: Total segment yang akan diproses

**Output**:
- `totalSegments`: Total segment diproses
- `success`: Jumlah berhasil
- `skipped`: Jumlah sudah ada
- `failed`: Jumlah gagal

**Work/Edition Tracking**:
- `work_id`: Diupdate saat processing segment pertama
- `edition_id`: Diupdate saat processing segment pertama

### 3. `scrape-chereads-work.ts` ✅
**Job Type**: `scrape`  
**Input**:
- `url`: URL chapter list
- `title`: Judul work
- `scriptType`: `'scrape-chereads-work'`

**Output**:
- `workId`: ID work
- `editionId`: ID edition yang dibuat
- `totalChapters`: Total chapter yang ditemukan

**Work/Edition Tracking**:
- `work_id`: Diset saat job dibuat
- `edition_id`: Diupdate setelah edition dibuat

### 4. `scrape-chereads-segment.ts` ✅
**Job Type**: `scrape`  
**Input**:
- `startChapter`: Chapter awal
- `endChapter`: Chapter akhir
- `delay`: Delay antar request (ms)
- `scriptType`: `'scrape-chereads-segment'`

**Output**:
- `totalSegments`: Total segment diproses
- `success`: Jumlah berhasil
- `skipped`: Jumlah sudah ada
- `errors`: Jumlah gagal

**Work/Edition Tracking**:
- `work_id`: Diset saat job dibuat
- `edition_id`: Diset saat job dibuat

### 5. `scrape-opensubtitles-work.ts` ✅
**Job Type**: `scrape`  
**Input**:
- `url`: URL work page
- `provider`: Provider name
- `scriptType`: `'scrape-opensubtitles-work'`
- `totalSegments`: Total episodes ditemukan

**Output**:
- `workId`: ID work
- `seasonCount`: Jumlah season
- `totalEpisodes`: Total episode

**Work/Edition Tracking**:
- `work_id`: Diset saat job dibuat

### 6. `bulk-download-subtitles-api.ts` ✅ (Enhanced)
**Job Type**: `scrape`  
**Input**:
- `seriesName`: Nama series
- `languages`: Bahasa subtitle
- `scriptType`: `'bulk-download-subtitles'`
- `delay`: Delay antar request
- `limit`: Limit jumlah segment

**Output**:
- `total`: Total segment diproses
- `success`: Jumlah berhasil
- `errors`: Jumlah gagal
- `skipped`: Jumlah diskip

**Work/Edition Tracking**:
- `work_id`: Diset saat job dibuat
- `edition_id`: Diset saat job dibuat

## Pattern Umum

### 1. Job Lifecycle
```typescript
async function main() {
  let jobId: string | null = null;
  
  try {
    // 1. Parse arguments
    const args = parseArguments();
    
    // 2. Create job (status: queued)
    jobId = await createJob({
      jobType: 'scrape',
      workId: args.workId,
      editionId: args.editionId,
      input: {
        // ... input parameters
        scriptType: 'script-name'
      }
    });
    
    // 3. Start job (status: running, started_at: NOW(), attempt++)
    await updateJobStatus(jobId, 'running');
    
    // 4. Do work...
    const result = await doWork();
    
    // 5. Update with edition_id if needed
    if (editionId && jobId) {
      await supabase
        .from('pipeline_jobs')
        .update({ edition_id: editionId })
        .eq('id', jobId);
    }
    
    // 6. Mark success (status: success, finished_at: NOW(), output: {...})
    await updateJobStatus(jobId, 'success', {
      // ... output data
    });
    
  } catch (error) {
    // 7. Mark failed (status: failed, finished_at: NOW(), error: '...')
    if (jobId) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await updateJobStatus(jobId, 'failed', undefined, errorMsg);
    }
    throw error;
  }
}
```

### 2. Error Handling
- Semua script memiliki try-catch di level main()
- Error ditangkap dan disimpan di `error` field
- Job status diupdate ke 'failed'
- Script exit dengan code 1

### 3. Output Tracking
- Output disimpan dalam JSONB dengan struktur konsisten
- Minimum fields: `success`, `failed`, `total`
- Additional fields sesuai kebutuhan script

## Monitoring & Debugging

### Query Active Jobs
```sql
SELECT 
  id,
  job_type,
  status,
  work_id,
  edition_id,
  input->>'scriptType' as script,
  created_at,
  started_at,
  finished_at,
  attempt
FROM pipeline_jobs
WHERE status = 'running'
ORDER BY started_at DESC;
```

### Query Failed Jobs
```sql
SELECT 
  id,
  job_type,
  work_id,
  edition_id,
  input->>'scriptType' as script,
  error,
  attempt,
  finished_at
FROM pipeline_jobs
WHERE status = 'failed'
ORDER BY finished_at DESC
LIMIT 10;
```

### Query Job Statistics
```sql
SELECT 
  input->>'scriptType' as script_type,
  status,
  COUNT(*) as count,
  AVG(EXTRACT(EPOCH FROM (finished_at - started_at))) as avg_duration_seconds
FROM pipeline_jobs
WHERE job_type = 'scrape'
  AND finished_at IS NOT NULL
GROUP BY input->>'scriptType', status
ORDER BY script_type, status;
```

### Query Retry Analysis
```sql
SELECT 
  input->>'scriptType' as script_type,
  attempt,
  COUNT(*) as count
FROM pipeline_jobs
WHERE job_type = 'scrape'
  AND status IN ('running', 'success', 'failed')
GROUP BY input->>'scriptType', attempt
ORDER BY script_type, attempt;
```

## Best Practices

1. **Always Create Job Early**: Buat job sesegera mungkin setelah validasi argument
2. **Graceful Error Handling**: Selalu update job status ke 'failed' sebelum exit
3. **Rich Input Data**: Sertakan semua parameter penting di `input` field
4. **Meaningful Output**: Simpan metrics yang berguna untuk monitoring
5. **Update IDs Incrementally**: Update work_id/edition_id/segment_id saat tersedia
6. **Don't Skip Job Tracking**: Jangan bypass job tracking bahkan saat error

## Testing

Untuk testing integrasi, jalankan script dan monitor di Supabase:

```bash
# Test readnovel API scraper
node dist/scripts/scrape-readnovel-api.js "work-id" "novel-slug"

# Check job in Supabase
SELECT * FROM pipeline_jobs ORDER BY created_at DESC LIMIT 1;
```

## Future Enhancements

- [ ] Implement job retry mechanism berdasarkan `attempt` counter
- [ ] Add job priority queue
- [ ] Implement job dependencies (wait for other jobs)
- [ ] Add job scheduling (cron-like)
- [ ] Implement job cancellation
- [ ] Add job progress tracking (percentage)
