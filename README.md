# Scraper Worker

Automated scraping worker for ChapterBridge Dashboard. This CLI tool extracts segment (chapter/episode) lists and assets from various web sources, stores them in Cloudflare R2, and registers metadata in Supabase.

## Features

- Scrape work pages to extract segment lists (chapters/episodes)
- Scrape segment pages to extract assets (images, subtitles, text)
- Upload scraped data to Cloudflare R2
- Register metadata in Supabase database
- Job queue system for automated processing
- Configurable templates for different site structures

## Prerequisites

- Node.js v20+
- pnpm package manager
- Supabase project with the ChapterBridge schema
- Cloudflare R2 bucket

## Installation

```bash
cd scraper-worker
pnpm install
```

## Configuration

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Required environment variables:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (for backend operations) |
| `CLOUDFLARE_R2_ENDPOINT` | R2 S3-compatible endpoint URL |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | R2 access key ID |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | R2 secret access key |
| `CLOUDFLARE_R2_BUCKET` | R2 bucket name |
| `CLOUDFLARE_R2_PUBLIC_BASE_URL` | (Optional) Public URL for R2 bucket |
| `USER_AGENT` | User agent string for HTTP requests |
| `DEFAULT_RATE_LIMIT_MS` | Delay between asset downloads (default: 500) |

## Usage

### Build

```bash
pnpm build
```

### Development

```bash
pnpm dev <command>
```

### Scrape Work Page

Extract segment list from a work page:

```bash
pnpm dev scrape:work \
  --url "https://example.com/manga/title" \
  --media manhwa \
  --provider "ExampleSite" \
  --template wp-manga \
  --title "My Manga Title"
```

Options:
- `--url`: URL of the work page (required)
- `--media`: Media type - `novel`, `manhwa`, or `anime` (required)
- `--provider`: Provider/site name (required)
- `--template`: Template name to use (required)
- `--title`: Work title (required)

### Scrape Segment Page

Extract assets from a segment (chapter) page:

```bash
pnpm dev scrape:segment \
  --url "https://example.com/manga/title/chapter-1" \
  --segmentId "uuid-from-supabase" \
  --template wp-manga \
  --download
```

Options:
- `--url`: URL of the segment page (required)
- `--segmentId`: Segment UUID from Supabase (required)
- `--template`: Template name to use (required)
- `--download`: Download and upload assets to R2 (optional, default: false)

### Job Runner

Process queued jobs from `pipeline_jobs` table:

```bash
# Run continuously
pnpm dev jobs:run --poll 5000

# Run once and exit
pnpm dev jobs:run --once
```

Options:
- `--poll`: Polling interval in milliseconds (default: 5000)
- `--once`: Process one batch and exit

### List Templates

```bash
pnpm dev templates:list
```

### Validate Configuration

```bash
pnpm dev validate
```

## Output Structure

### Local Output

Scraped data is saved to the `out/` directory:
- `out/segments.json` - Segment list from work scraping
- `out/assets.json` - Asset list from segment scraping

### R2 Storage Structure

```
raw/
└── <media>/                    # novel, manhwa, anime
    └── <workId>/
        └── <editionId>/
            ├── segments.json   # Segment list
            └── <segmentType>-<number>/
                ├── assets.json     # Asset metadata
                ├── page-001.webp   # Downloaded images
                ├── page-002.webp
                └── ...
```

## Templates

Templates define CSS selectors and patterns for extracting data from different site structures. They are stored in the `templates/` directory as JSON files.

### Template Structure

```json
{
  "name": "template-name",
  "description": "Description of the template",
  "selectors": {
    "chapters": ".chapter-list a",
    "chapterNumber": ".chapter-num",
    "chapterTitle": ".chapter-title",
    "image": ".reader-content img",
    "subtitle": "track[kind='subtitles']",
    "text": ".text-content p",
    "textContainer": ".novel-content"
  },
  "patterns": {
    "chapterNumberRegex": "chapter-(\\d+)",
    "imageUrlPattern": "\\.(jpg|png|webp)$"
  },
  "pagination": {
    "nextPage": ".next-page",
    "maxPages": 10
  }
}
```

### Creating a New Template

1. Create a new JSON file in `templates/` (e.g., `my-site.json`)
2. Define the CSS selectors for your target site
3. Use the template name (without .json) with the `--template` option

### Available Templates

- `wp-manga` - WordPress sites using WP-Manga plugin
- `sample` - Empty template for custom configuration

## Database Schema

The worker expects the following tables in Supabase:

- `works` - Work titles
- `editions` - Different editions/sources of a work
- `segments` - Chapters/episodes
- `assets` - Uploaded files (images, subtitles, text)
- `segment_assets` - Junction table linking segments to assets
- `pipeline_jobs` - Job queue for automated processing

## Error Handling

- All errors are logged using Pino
- Job failures are recorded in `pipeline_jobs.error`
- Failed jobs have status `failed`
- Rate limiting is applied between asset downloads

## Development

### Type Checking

```bash
pnpm typecheck
```

### Project Structure

```
scraper-worker/
├── src/
│   ├── cli.ts              # CLI entry point
│   ├── config/
│   │   ├── env.ts          # Environment validation
│   │   └── templates.ts    # Template loader
│   ├── extractors/
│   │   ├── types.ts        # TypeScript interfaces
│   │   ├── generic-html.ts # Generic HTML extractor
│   │   ├── chereads.ts     # Chereads specific extractor
│   │   ├── opensubtitles.ts # OpenSubtitles specific extractor
│   │   └── wp-manga.ts     # WP-Manga specific extractor
│   ├── services/
│   │   ├── supabase.ts     # Supabase operations
│   │   ├── r2.ts           # Cloudflare R2 operations
│   │   └── opensubtitles-api.ts # OpenSubtitles API client
│   ├── pipelines/
│   │   ├── scrapeWork.ts   # Work scraping pipeline
│   │   ├── scrapeSegment.ts # Segment scraping pipeline
│   │   └── jobRunner.ts    # Job queue processor
│   ├── scripts/            # 🆕 Organized by media type
│   │   ├── novel/          # Novel/web novel scrapers
│   │   │   ├── chereads-list.ts
│   │   │   ├── chereads-content.ts
│   │   │   ├── readnovel-list.ts
│   │   │   └── readnovel-content.ts
│   │   ├── anime/          # Anime subtitle scrapers
│   │   │   ├── opensubtitles-list.ts
│   │   │   ├── opensubtitles-bulk-download.ts
│   │   │   └── opensubtitles-single-download.ts
│   │   ├── komik/          # Manhwa/comic scrapers
│   │   │   └── manhwaz-bulk-scrape.ts
│   │   └── utils/          # Utility scripts
│   │       ├── sync-r2.ts
│   │       └── fix-content-types.ts
│   └── utils/
│       ├── hash.ts         # SHA256 & file size utilities
│       └── logger.ts       # Pino logger configuration
├── templates/              # Extractor templates
│   ├── chereads.json
│   ├── komik-manhwaz-list.json
│   ├── komik-manhwaz-page.json
│   ├── opensubtitles.json
│   ├── readnovel.json
│   ├── sample.json
│   └── wp-manga.json
├── docs/                   # Documentation
│   ├── ARCHITECTURE.md     # System architecture
│   ├── MIGRATION_GUIDE.md  # File reorganization guide
│   └── database-schema.sql # Database schema
├── out/                    # Local output directory
└── .env                    # Environment configuration
```

## License

MIT
