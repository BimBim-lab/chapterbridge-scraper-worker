# Architecture Overview

## 📁 Folder Structure & Responsibilities

### 🔄 **pipelines/** - Automated Job Runner System
Folder ini berisi **sistem otomatis** untuk menjalankan scraping jobs dari database queue.

#### Files:
- **`jobRunner.ts`** - Main orchestrator yang:
  - Poll jobs dari table `pipeline_jobs` dengan status `queued`
  - Route jobs berdasarkan `job_type` ke handler yang sesuai
  - Update job status: `queued` → `running` → `success`/`failed`
  - Run as daemon process (terus berjalan)

- **`scrapeWork.ts`** - Handler untuk job type `scrape:work`:
  - Scrape chapter lists/episode lists dari sebuah work
  - Support multiple extractors: WpManga, GenericHTML, OpenSubtitles
  - Create work, edition, dan segments di database
  - Upload hasil ke R2 storage

- **`scrapeSegment.ts`** - Handler untuk job type `scrape:segment`:
  - Scrape content individual chapter/episode
  - Download images/subtitles/text content
  - Upload assets ke R2
  - Link assets ke segments via `segment_assets` table

#### Usage Pattern:
```bash
# Start job runner daemon (process yang terus berjalan)
node dist/pipelines/jobRunner.js --poll=5000

# Or run once (process single job then exit)
node dist/pipelines/jobRunner.js --once
```

#### How Jobs Are Created:
Jobs dibuat dari **scripts/** atau manual insert ke database:
```sql
INSERT INTO pipeline_jobs (job_type, input, status)
VALUES ('scrape:work', '{"url": "...", "template": "..."}', 'queued');
```

---

### 📜 **scripts/** - Direct Execution Scripts
Folder ini berisi **script standalone** yang bisa dijalankan langsung via CLI, terorganisir berdasarkan media type.

#### Karakteristik:
- ✅ **Run langsung** tanpa perlu job queue
- ✅ **CLI arguments** untuk flexibility
- ✅ **Pipeline jobs tracking** built-in
- ✅ Site-specific implementations
- ✅ **Organized by media type** untuk maintenance yang mudah

#### 📁 Folder Structure:
```
scripts/
├── novel/          # Novel/web novel scrapers
├── anime/          # Anime subtitle scrapers
├── komik/          # Manhwa/comic scrapers
└── utils/          # Utility scripts
```

#### Scripts Available:

##### 📚 Novel Scrapers (novel/):
1. **`chereads-list.ts`** (formerly: scrape-chereads-work.ts)
   - Scrape chapter list dari chereads.com
   - Creates: work → edition → segments
   ```bash
   node dist/scripts/novel/chereads-list.js --url="..." --workId="..." --title="..."
   ```

2. **`chereads-content.ts`** (formerly: scrape-chereads-segment.ts)
   - Scrape content chapters dari chereads.com
   - Downloads HTML content, uploads to R2
   ```bash
   node dist/scripts/novel/chereads-content.js --editionId="..." --start=1 --end=50
   ```

3. **`readnovel-list.ts`** (formerly: scrape-readnovel-api.ts)
   - Scrape chapter list via WuxiaWorld API
   - Fast, no browser automation needed
   ```bash
   node dist/scripts/novel/readnovel-list.js <work_id> <novel-slug>
   ```

4. **`readnovel-content.ts`** (formerly: scrape-readnovel-segment.ts)
   - Scrape chapter content dengan Playwright + Stealth
   - Anti-bot detection bypass
   ```bash
   node dist/scripts/novel/readnovel-content.js <segment_id> [<segment_id>...]
   node dist/scripts/novel/readnovel-content.js --edition <edition_id>
   ```

##### 📺 Anime/Subtitle Scrapers (anime/):
5. **`opensubtitles-list.ts`** (formerly: scrape-opensubtitles-work.ts)
   - Scrape episode list dari OpenSubtitles
   - Creates seasons as editions
   ```bash
   node dist/scripts/anime/opensubtitles-list.js --url="..." --workId="..." --title="..."
   ```

6. **`opensubtitles-bulk-download.ts`** (formerly: bulk-download-subtitles-api.ts)
   - Download subtitles via OpenSubtitles API
   - Batch processing dengan rate limiting
   ```bash
   node dist/scripts/anime/opensubtitles-bulk-download.js --workId="..." --seriesName="..." --languages="en,id"
   ```

7. **`opensubtitles-single-download.ts`** (formerly: download-subtitle-api.ts)
   - Single subtitle download via API
   ```bash
   node dist/scripts/anime/opensubtitles-single-download.js <segment_id>
   ```

##### 📖 Komik/Manhwa Scrapers (komik/):
8. **`manhwaz-bulk-scrape.ts`** (formerly: bulk-scrape-segments.ts)
   - Bulk scraper untuk manhwaz website
   - Generic segment scraper using pipeline system
   ```bash
   node dist/scripts/komik/manhwaz-bulk-scrape.js --editionId="..." --template="komik-manhwaz-page"
   ```

##### 🛠️ Utility Scripts (utils/):
9. **`sync-r2.ts`** (formerly: sync-r2-assets.ts)
   - Sync assets dengan R2 storage
   ```bash
   node dist/scripts/utils/sync-r2.js
   ```
   
10. **`fix-content-types.ts`** (formerly: update-content-types.ts)
    - Fix/update content types di assets table
    ```bash
    node dist/scripts/utils/fix-content-types.js
    ```

---

## 🔄 Relationship: pipelines/ vs scripts/

### **pipelines/** = Automated Queue System
```
Database (pipeline_jobs) 
    ↓ [queued jobs]
jobRunner.ts (polls every 5s)
    ↓ [routes by job_type]
scrapeWork.ts / scrapeSegment.ts
    ↓ [executes]
Updates job status → success/failed
```

**Use Case:**
- Scheduled scraping
- Batch processing
- Background workers
- Distributed processing (multiple workers)

---

### **scripts/** = Direct CLI Execution
```
User runs command
    ↓ [CLI arguments]
Script executes directly
    ↓ [creates pipeline_job for tracking]
Scrapes → Processes → Saves
    ↓ [updates job status]
Done
```

**Use Case:**
- One-off scraping tasks
- Testing/debugging
- Manual triggers
- Site-specific implementations

---

## 🔗 Integration Between Both

Scripts in `scripts/` folder **DO** integrate with pipeline_jobs:

1. **Create job at start** - untuk tracking
2. **Update status** - `running`, `success`, `failed`
3. **Store results** - input/output JSONB
4. **Same tracking** - as pipelines system

```typescript
// Pattern used in all scripts:
const jobId = await createJob({
  jobType: 'scrape',
  workId: workId,
  editionId: editionId,
  input: { ...params }
});

await updateJobStatus(jobId, 'running');
// ... do work ...
await updateJobStatus(jobId, 'success', { results });
```

---

## 🎯 When to Use What?

### Use **pipelines/** when:
- ✅ Need automated scheduling
- ✅ Want queue-based processing
- ✅ Building worker pool
- ✅ Generic scrapers (work with templates)

### Use **scripts/** when:
- ✅ Need CLI flexibility
- ✅ One-off tasks
- ✅ Site-specific logic
- ✅ Testing new scrapers
- ✅ Manual interventions

---

## 📊 Monitoring Both Systems

Both systems write to `pipeline_jobs` table:

```sql
-- Monitor all scraping activity
SELECT 
  id,
  job_type,
  status,
  work_id,
  edition_id,
  input->>'scriptType' as script_name,
  created_at,
  started_at,
  finished_at,
  EXTRACT(EPOCH FROM (finished_at - started_at)) as duration_seconds
FROM pipeline_jobs
WHERE created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

---

## 🚀 Future Enhancements

1. **Unified Interface**: Scripts could be called by jobRunner
2. **Dynamic Loading**: jobRunner dynamically loads scripts
3. **Hybrid Mode**: Scripts can run standalone OR as job handler
4. **Retry Logic**: Automatic retry for failed jobs

---

## 📝 Summary

| Aspect | pipelines/ | scripts/ |
|--------|-----------|----------|
| **Execution** | Queue-based (automated) | CLI-based (manual) |
| **Job Tracking** | ✅ Always tracked | ✅ Always tracked |
| **Flexibility** | Template-driven | Site-specific |
| **Use Case** | Background workers | Direct commands |
| **Dependencies** | Database queue required | Can run standalone |
| **Best For** | Production automation | Development & testing |

**Both systems complement each other** and write to the same `pipeline_jobs` table for unified monitoring! 🎉
