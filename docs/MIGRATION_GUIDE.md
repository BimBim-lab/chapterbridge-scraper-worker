# 📦 File Reorganization - Migration Guide

**Date:** January 10, 2026  
**Status:** ✅ Completed

---

## 🎯 Changes Summary

Semua scripts telah direorganisasi ke dalam folder berdasarkan media type untuk maintenance yang lebih mudah.

---

## 📁 New Structure

```
src/scripts/
├── novel/          # Novel/web novel scrapers (4 files)
│   ├── chereads-list.ts
│   ├── chereads-content.ts
│   ├── readnovel-list.ts
│   └── readnovel-content.ts
│
├── anime/          # Anime subtitle scrapers (3 files)
│   ├── opensubtitles-list.ts
│   ├── opensubtitles-bulk-download.ts
│   └── opensubtitles-single-download.ts
│
├── komik/          # Manhwa/comic scrapers (1 file)
│   └── manhwaz-bulk-scrape.ts
│
└── utils/          # Utility scripts (2 files)
    ├── sync-r2.ts
    └── fix-content-types.ts

templates/
├── chereads.json
├── komik-manhwaz-list.json     ← renamed from manhwaz.json
├── komik-manhwaz-page.json     ← renamed from manhwaz-chapter.json
├── opensubtitles.json
├── readnovel.json
├── sample.json
└── wp-manga.json
```

---

## 🔄 File Mappings

### Novel Scripts
| Old Path | New Path | Purpose |
|----------|----------|---------|
| `scrape-chereads-work.ts` | `novel/chereads-list.ts` | Scrape chapter list |
| `scrape-chereads-segment.ts` | `novel/chereads-content.ts` | Scrape chapter content |
| `scrape-readnovel-api.ts` | `novel/readnovel-list.ts` | Fetch chapters via API |
| `scrape-readnovel-segment.ts` | `novel/readnovel-content.ts` | Scrape chapter content |

### Anime Scripts
| Old Path | New Path | Purpose |
|----------|----------|---------|
| `scrape-opensubtitles-work.ts` | `anime/opensubtitles-list.ts` | Scrape episode list |
| `bulk-download-subtitles-api.ts` | `anime/opensubtitles-bulk-download.ts` | Bulk subtitle download |
| `download-subtitle-api.ts` | `anime/opensubtitles-single-download.ts` | Single subtitle download |

### Komik Scripts
| Old Path | New Path | Purpose |
|----------|----------|---------|
| `bulk-scrape-segments.ts` | `komik/manhwaz-bulk-scrape.ts` | Bulk manhwa scraper |

### Utility Scripts
| Old Path | New Path | Purpose |
|----------|----------|---------|
| `sync-r2-assets.ts` | `utils/sync-r2.ts` | Sync with R2 storage |
| `update-content-types.ts` | `utils/fix-content-types.ts` | Fix asset content types |

---

## 🚀 Updated Command Examples

### Novel Scripts

```bash
# Chereads - List chapters
node dist/scripts/novel/chereads-list.js --url="..." --workId="..." --title="..."

# Chereads - Scrape content
node dist/scripts/novel/chereads-content.js --editionId="..." --start=1 --end=50

# ReadNovel - Fetch via API
node dist/scripts/novel/readnovel-list.js <work_id> <novel-slug>

# ReadNovel - Scrape content
node dist/scripts/novel/readnovel-content.js <segment_id> [<segment_id>...]
node dist/scripts/novel/readnovel-content.js --edition <edition_id>
```

### Anime Scripts

```bash
# OpenSubtitles - List episodes
node dist/scripts/anime/opensubtitles-list.js --url="..." --workId="..." --title="..."

# OpenSubtitles - Bulk download
node dist/scripts/anime/opensubtitles-bulk-download.js --workId="..." --seriesName="..." --languages="en,id"

# OpenSubtitles - Single download
node dist/scripts/anime/opensubtitles-single-download.js <segment_id>
```

### Komik Scripts

```bash
# Manhwaz - Bulk scrape
node dist/scripts/komik/manhwaz-bulk-scrape.js --editionId="..." --template="komik-manhwaz-page"
```

### Utility Scripts

```bash
# Sync R2 assets
node dist/scripts/utils/sync-r2.js

# Fix content types
node dist/scripts/utils/fix-content-types.js
```

---

## ⚙️ Technical Changes

### 1. Import Paths Updated
All relative imports changed from `../` to `../../`:

```typescript
// OLD
import { getEnv } from '../config/env.js';
import { createJob } from '../services/supabase.js';

// NEW
import { getEnv } from '../../config/env.js';
import { createJob } from '../../services/supabase.js';
```

### 2. Template Names Updated
```typescript
// OLD
template = 'manhwaz-chapter';

// NEW  
template = 'komik-manhwaz-page';
```

### 3. Documentation Updated
- ✅ `ARCHITECTURE.md` - Updated with new structure
- ✅ Command examples with new paths
- ✅ File descriptions and purposes

---

## 🎨 Benefits of New Structure

### ✅ Better Organization
- Clear grouping by media type
- Easy to find related scripts
- Logical hierarchy

### ✅ Easier Maintenance
- Add new sources easily (just add to respective folder)
- Clear separation of concerns
- Consistent naming pattern

### ✅ Better Discoverability
- Folder names indicate content type
- File names indicate action (list/content/download)
- Reduced naming conflicts

### ✅ Scalability
- Easy to add new media types
- Room for growth per category
- Clear extension points

---

## 📊 Before vs After Comparison

### Before (Flat Structure)
```
scripts/
├── scrape-chereads-work.ts              ❌ Hard to group
├── scrape-chereads-segment.ts           ❌ Naming inconsistent
├── scrape-readnovel-api.ts              ❌ No clear hierarchy
├── scrape-readnovel-segment.ts
├── scrape-opensubtitles-work.ts
├── bulk-download-subtitles-api.ts       ❌ "bulk" vs "scrape" prefix
├── download-subtitle-api.ts
├── bulk-scrape-segments.ts
├── sync-r2-assets.ts                    ❌ Mixed utilities
└── update-content-types.ts
```

### After (Hierarchical Structure)
```
scripts/
├── novel/                               ✅ Clear grouping
│   ├── chereads-list.ts                 ✅ Consistent naming
│   ├── chereads-content.ts              ✅ Action-based names
│   ├── readnovel-list.ts
│   └── readnovel-content.ts
├── anime/                               ✅ Clear separation
│   ├── opensubtitles-list.ts
│   ├── opensubtitles-bulk-download.ts   ✅ Descriptive names
│   └── opensubtitles-single-download.ts
├── komik/                               ✅ Dedicated folder
│   └── manhwaz-bulk-scrape.ts
└── utils/                               ✅ Utilities isolated
    ├── sync-r2.ts
    └── fix-content-types.ts
```

---

## ✅ Migration Checklist

- [x] Create folder structure (novel/, anime/, komik/, utils/)
- [x] Move and rename all script files
- [x] Update relative imports (../ → ../../)
- [x] Rename template files (manhwaz → komik-manhwaz)
- [x] Update template references in code
- [x] Update ARCHITECTURE.md documentation
- [x] Create migration guide (this file)
- [x] TypeScript compilation successful
- [x] All imports resolved correctly

---

## 🔜 Future Enhancements

1. **Add CLI Router**: Create main CLI entry point that routes to subfolders
2. **Auto-discovery**: Dynamic loading of scripts from folders
3. **Testing Structure**: Mirror folder structure in tests/
4. **More Media Types**: Easy to add manhwa, manhua, etc.

---

## 🆘 Troubleshooting

### Error: Cannot find module
**Problem:** Import paths not updated correctly  
**Solution:** Check that all imports use `../../` instead of `../`

### Error: Template not found
**Problem:** Old template names still referenced  
**Solution:** Use new template names:
- `manhwaz.json` → `komik-manhwaz-list.json`
- `manhwaz-chapter.json` → `komik-manhwaz-page.json`

### Script not found
**Problem:** Using old paths in commands  
**Solution:** Use new paths with folder prefix:
- `dist/scripts/scrape-chereads-work.js` → `dist/scripts/novel/chereads-list.js`

---

## 📞 Support

If you encounter issues after migration:
1. Check file paths in error messages
2. Verify import statements use `../../`
3. Ensure template names are updated
4. Recompile TypeScript: `npx tsc`

---

**Migration Status:** ✅ **COMPLETE & TESTED**  
**Compilation:** ✅ **SUCCESSFUL**  
**Documentation:** ✅ **UPDATED**
