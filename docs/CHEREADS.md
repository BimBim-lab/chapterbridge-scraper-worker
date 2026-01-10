# Chereads.com Scraper

Scraper for extracting novel chapters from chereads.com with template-based configuration.

## Structure

- **Template**: `templates/chereads.json` - Configuration for selectors and filters
- **Extractor**: `src/extractors/chereads.ts` - Logic for extracting chapter data
- **Scripts**:
  - `src/scripts/scrape-chereads-work.ts` - Scrape chapter list and create segments
  - `src/scripts/scrape-chereads-segment.ts` - Scrape chapter content and upload to R2

## Database Flow

```
Work → Edition → Segments → Assets → Segment Assets
```

## Usage

### Step 1: Scrape Chapter List (Create Work, Edition, Segments)

```bash
npx tsx src/scripts/scrape-chereads-work.ts \
  --url="https://www.chereads.com/chapterlist/34048845808168505/" \
  --workId="5c36ee25-e4ff-4e49-ac89-302ae715e596" \
  --title="The Beginning After The End"
```

**Parameters:**
- `--url` (required): URL to the chapter list page
- `--workId` (required): UUID for the work (generate new or use existing)
- `--title` (optional): Title of the novel (default: "Unknown Title")

**What it does:**
1. Creates/retrieves Work in database
2. Creates/retrieves Edition for chereads provider
3. Scrapes all chapters from the list
4. Creates Segments in database with chapter URLs

### Step 2: Scrape Chapter Content (Download and Upload)

```bash
npx tsx src/scripts/scrape-chereads-segment.ts \
  --editionId="abc-123-def-456" \
  --start=1 \
  --end=50 \
  --delay=3000
```

**Parameters:**
- `--editionId` (required): UUID of the edition from step 1
- `--start` (optional): Starting chapter number (default: 1)
- `--end` (optional): Ending chapter number (default: 999999)
- `--delay` (optional): Delay between requests in ms (default: 2000)

**What it does:**
1. Fetches segments from database
2. For each segment:
   - Scrapes chapter content from URL
   - Cleans and extracts plain text
   - Uploads text to Cloudflare R2
   - Creates Asset record
   - Links Asset to Segment

## Template Configuration

The template (`templates/chereads.json`) contains:

```json
{
  "config": {
    "selectors": {
      "chapterList": {
        "container": "ul.ChapterItems_list__kW9Em",
        "item": "li",
        "number": "i.styles_num___sIei span",
        "title": "strong.ells._3",
        "href": "a"
      },
      "chapterContent": {
        "content": "div.chapter-content, div.text-content"
      }
    },
    "filters": {
      "minChapterNumber": 1
    },
    "rateLimit": {
      "requestsPerMinute": 30,
      "delayBetweenRequests": 2000
    }
  }
}
```

## Extractor Features

The `ChereadsExtractor` class provides:

- `extractChapterList(html)` - Extract chapter list from HTML
- `extractChapterContent(html)` - Extract chapter content from HTML
- `scrapeChapterListPage(page)` - Scrape using Playwright
- `scrapeChapterContentPage(page)` - Scrape content using Playwright
- `isValidUrl(url)` - Validate chereads.com URL
- `extractNovelId(url)` - Extract novel ID from URL

## Example Workflow

```bash
# 1. Create work and segments
npx tsx src/scripts/scrape-chereads-work.ts \
  --url="https://www.chereads.com/chapterlist/34048845808168505/" \
  --workId="5c36ee25-e4ff-4e49-ac89-302ae715e596" \
  --title="The Beginning After The End"

# Output will show the edition ID, e.g., "Edition created: abc-123-def-456"

# 2. Scrape first 10 chapters
npx tsx src/scripts/scrape-chereads-segment.ts \
  --editionId="abc-123-def-456" \
  --start=1 \
  --end=10 \
  --delay=3000

# 3. Scrape remaining chapters in batches
npx tsx src/scripts/scrape-chereads-segment.ts \
  --editionId="abc-123-def-456" \
  --start=11 \
  --end=50 \
  --delay=3000
```

## Rate Limiting

To avoid getting blocked:
- Default delay: 2000ms (2 seconds) between requests
- Recommended: 3000ms (3 seconds) for safer scraping
- Adjust `--delay` parameter based on site response

## Error Handling

The scripts handle:
- Duplicate detection (skips existing segments/assets)
- Missing content (reports errors)
- Network failures (with error messages)
- Invalid URLs (validation checks)

## Database Schema

### Work
```sql
id UUID PRIMARY KEY
title TEXT
```

### Edition
```sql
id UUID PRIMARY KEY
work_id UUID REFERENCES works(id)
media_type TEXT -- 'novel'
provider TEXT -- 'chereads'
canonical_url TEXT
```

### Segments
```sql
id UUID PRIMARY KEY
edition_id UUID REFERENCES editions(id)
segment_type TEXT -- 'chapter'
number NUMERIC
title TEXT
canonical_url TEXT
```

### Assets
```sql
id UUID PRIMARY KEY
provider TEXT -- 'cloudflare_r2'
r2_key TEXT UNIQUE
asset_type TEXT -- 'cleaned_text'
content_type TEXT -- 'text/plain'
bytes BIGINT
sha256 TEXT
```

### Segment Assets
```sql
segment_id UUID REFERENCES segments(id)
asset_id UUID REFERENCES assets(id)
role TEXT -- 'content'
```

## Notes

- Chapter 0, Maps, and other special entries are automatically filtered
- Only chapters with valid numbers (≥ 1) are processed
- Content is stored as plain text in R2
- SHA256 hash is computed for each file
- Duplicate segments are skipped automatically
