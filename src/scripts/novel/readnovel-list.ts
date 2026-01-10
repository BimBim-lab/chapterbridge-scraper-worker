import { createClient } from '@supabase/supabase-js';
import { getEnv } from '../../config/env.js';
import { 
  createJob, 
  updateJobStatus,
  type CreateJobParams 
} from '../../services/supabase.js';

const env = getEnv();
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

interface ChapterAPIResponse {
  id: number;
  index: number;
  title: string;
  novSlugChapSlug: string;
  timeAdded: string;
}

async function scrapeReadNovelViaAPI(novelSlug: string, workId: string) {
  let jobId: string | null = null;
  
  console.log('🚀 Starting ReadNovel API scraper...');
  console.log(`📚 Novel Slug: ${novelSlug}`);
  console.log(`📚 Work ID: ${workId}\n`);

  try {
    // Validate work exists
    console.log('🔍 Validating work...');
    const { data: existingWork, error: checkError } = await supabase
      .from('works')
      .select('id, title')
      .eq('id', workId)
      .single();

    if (checkError) {
      throw new Error(`Work with id ${workId} not found: ${checkError.message}`);
    }

    console.log(`✅ Work found: ${existingWork.title} (${workId})`);

    // Create pipeline job
    jobId = await createJob({
      jobType: 'scrape',
      workId: workId,
      input: {
        novelSlug,
        scriptType: 'scrape-readnovel-api',
        apiUrl: `https://wuxiaworld.eu/api/chapters/${novelSlug}/`,
      }
    });
    console.log(`📋 Created pipeline job: ${jobId}`);
    
    await updateJobStatus(jobId, 'running');

    // Fetch chapters from API
    console.log('\n📡 Fetching chapters from WuxiaWorld API...');
    const apiUrl = `https://wuxiaworld.eu/api/chapters/${novelSlug}/`;
    console.log(`🔗 API URL: ${apiUrl}`);
    
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': `https://readnovel.eu/novel/${novelSlug}`
      }
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    const chapters: ChapterAPIResponse[] = await response.json() as ChapterAPIResponse[];
    console.log(`✅ Found ${chapters.length} chapters from API`);

    // Get or create edition
    console.log(`\n📖 Checking edition for work: ${workId}`);
    
    const { data: existingEdition } = await supabase
      .from('editions')
      .select('id')
      .eq('work_id', workId)
      .eq('media_type', 'novel')
      .eq('provider', 'readnovel')
      .single();

    let editionId: string;

    if (existingEdition) {
      console.log(`✅ Edition already exists: ${existingEdition.id}`);
      editionId = existingEdition.id;
    } else {
      console.log(`📝 Creating new edition for readnovel`);
      const { data: newEdition, error: editionError } = await supabase
        .from('editions')
        .insert({
          work_id: workId,
          media_type: 'novel',
          provider: 'readnovel',
          canonical_url: `https://readnovel.eu/novel/${novelSlug}`,
          is_official: false
        })
        .select()
        .single();

      if (editionError) {
        throw new Error(`Failed to create edition: ${editionError.message}`);
      }

      editionId = newEdition!.id;
      console.log(`✅ Edition created: ${editionId}`);
    }
    
    // Update job with edition_id
    if (jobId) {
      await supabase
        .from('pipeline_jobs')
        .update({ edition_id: editionId })
        .eq('id', jobId);
    }

    // Insert or update segments
    console.log(`\n📝 Inserting segments...`);
    let insertCount = 0;
    let updateCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const chapter of chapters) {
      try {
        const chapterUrl = `https://readnovel.eu/chapter/${chapter.novSlugChapSlug}`;
        
        // Check if segment already exists
        const { data: existingSegment } = await supabase
          .from('segments')
          .select('id, canonical_url')
          .eq('edition_id', editionId)
          .eq('segment_type', 'chapter')
          .eq('number', chapter.index)
          .single();

        if (existingSegment) {
          // Update existing segment if URL is different
          if (existingSegment.canonical_url !== chapterUrl) {
            const { error: updateError } = await supabase
              .from('segments')
              .update({
                title: chapter.title,
                canonical_url: chapterUrl
              })
              .eq('id', existingSegment.id);

            if (updateError) {
              console.error(`❌ Error updating chapter ${chapter.index}: ${updateError.message}`);
              errorCount++;
            } else {
              console.log(`🔄 Chapter ${chapter.index}: ${chapter.title} (updated URL)`);
              updateCount++;
            }
          } else {
            console.log(`⏭️  Chapter ${chapter.index}: Already correct, skipping`);
            skipCount++;
          }
        } else {
          // Insert new segment
          const { error: insertError } = await supabase
            .from('segments')
            .insert({
              edition_id: editionId,
              segment_type: 'chapter',
              number: chapter.index,
              title: chapter.title,
              canonical_url: chapterUrl
            });

          if (insertError) {
            console.error(`❌ Error inserting chapter ${chapter.index}: ${insertError.message}`);
            errorCount++;
          } else {
            console.log(`✅ Chapter ${chapter.index}: ${chapter.title}`);
            insertCount++;
          }
        }
      } catch (error) {
        console.error(`❌ Error processing chapter ${chapter.index}:`, error);
        errorCount++;
      }
    }

    console.log(`\n✅ Scraping completed!`);
    console.log(`📊 Summary:`);
    console.log(`   - Total chapters: ${chapters.length}`);
    console.log(`   - Inserted: ${insertCount}`);
    console.log(`   - Updated: ${updateCount}`);
    console.log(`   - Skipped: ${skipCount}`);
    console.log(`   - Errors: ${errorCount}`);

    // Update job status to success
    if (jobId) {
      await updateJobStatus(jobId, 'success', {
        editionId,
        totalChapters: chapters.length,
        inserted: insertCount,
        updated: updateCount,
        skipped: skipCount,
        errors: errorCount,
      });
    }

  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    
    // Update job status to failed
    if (jobId) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await updateJobStatus(jobId, 'failed', undefined, errorMsg);
    }
    
    throw error;
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Usage: node dist/scripts/scrape-readnovel-api.js <work_id> <novel-slug>');
  console.error('');
  console.error('Example:');
  console.error('  node dist/scripts/scrape-readnovel-api.js "fac62ab8-ecf3-4ebb-8752-58d1df1273fc" "solo-leveling"');
  console.error('');
  console.error('Note: novel-slug is the slug from readnovel.eu URL (e.g., "solo-leveling" from https://readnovel.eu/novel/solo-leveling)');
  process.exit(1);
}

const [workId, novelSlug] = args;

// Validate work_id format
if (!workId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
  console.error('Error: Invalid work_id format (must be UUID)');
  process.exit(1);
}

scrapeReadNovelViaAPI(novelSlug, workId)
  .then(() => {
    console.log('\n✅ All done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
