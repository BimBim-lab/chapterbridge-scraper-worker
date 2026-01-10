# 📝 Proposal Penamaan File untuk Maintenance

## 🎯 Tujuan
- Konsistensi naming convention
- Grouping yang jelas berdasarkan domain/fungsi
- Mudah dicari dan di-maintain
- Hubungan antar file lebih explicit

---

## 📊 Struktur Saat Ini vs Proposal

### 1️⃣ **scripts/** - Skrip Eksekusi

#### **Current Structure:**
```
scripts/
├── scrape-chereads-work.ts
├── scrape-chereads-segment.ts
├── scrape-readnovel-api.ts
├── scrape-readnovel-segment.ts
├── scrape-opensubtitles-work.ts
├── bulk-download-subtitles-api.ts
├── download-subtitle-api.ts
├── bulk-scrape-segments.ts
├── sync-r2-assets.ts
└── update-content-types.ts
```

#### **Proposed Structure (Option A - Group by Media Type):**
```
scripts/
├── novel.chereads.list.ts          (was: scrape-chereads-work.ts)
├── novel.chereads.content.ts       (was: scrape-chereads-segment.ts)
├── novel.readnovel.list.ts         (was: scrape-readnovel-api.ts)
├── novel.readnovel.content.ts      (was: scrape-readnovel-segment.ts)
├── anime.opensubtitles.list.ts     (was: scrape-opensubtitles-work.ts)
├── anime.opensubtitles.download.ts (was: bulk-download-subtitles-api.ts)
├── anime.opensubtitles.single.ts   (was: download-subtitle-api.ts)
├── batch.scrape-segments.ts        (was: bulk-scrape-segments.ts)
├── util.sync-r2.ts                 (was: sync-r2-assets.ts)
└── util.fix-content-types.ts       (was: update-content-types.ts)
```

**Naming Pattern:** `{mediaType}.{source}.{action}.ts`
- Media Type: `novel`, `anime`, `manhwa`, `batch`, `util`
- Source: `chereads`, `readnovel`, `opensubtitles`, etc
- Action: `list`, `content`, `download`, `single`

---

#### **Proposed Structure (Option B - Group by Action):**
```
scripts/
├── list.chereads.ts                (was: scrape-chereads-work.ts)
├── content.chereads.ts             (was: scrape-chereads-segment.ts)
├── list.readnovel.ts               (was: scrape-readnovel-api.ts)
├── content.readnovel.ts            (was: scrape-readnovel-segment.ts)
├── list.opensubtitles.ts           (was: scrape-opensubtitles-work.ts)
├── download.subtitles-bulk.ts      (was: bulk-download-subtitles-api.ts)
├── download.subtitle-single.ts     (was: download-subtitle-api.ts)
├── batch.segments.ts               (was: bulk-scrape-segments.ts)
├── util.sync-r2.ts                 (was: sync-r2-assets.ts)
└── util.fix-content-types.ts       (was: update-content-types.ts)
```

**Naming Pattern:** `{action}.{source}.ts`
- Action: `list`, `content`, `download`, `batch`, `util`
- Source: `chereads`, `readnovel`, `opensubtitles`, etc

---

#### **Proposed Structure (Option C - Folder Hierarchy):**
```
scripts/
├── novel/
│   ├── chereads-list.ts
│   ├── chereads-content.ts
│   ├── readnovel-list.ts
│   └── readnovel-content.ts
├── anime/
│   ├── opensubtitles-list.ts
│   ├── opensubtitles-download-bulk.ts
│   └── opensubtitles-download-single.ts
├── batch/
│   └── scrape-segments.ts
└── utils/
    ├── sync-r2.ts
    └── fix-content-types.ts
```

**Benefit:** Clear grouping, easy to navigate

---

### 2️⃣ **extractors/** - Logic Ekstraksi

#### **Current Structure:**
```
extractors/
├── chereads.ts
├── generic-html.ts
├── opensubtitles.ts
├── types.ts
└── wp-manga.ts
```

#### **Proposed Structure (Option A - Explicit Naming):**
```
extractors/
├── novel-chereads.extractor.ts      (was: chereads.ts)
├── base-generic-html.extractor.ts   (was: generic-html.ts)
├── anime-opensubtitles.extractor.ts (was: opensubtitles.ts)
├── manhwa-wp-manga.extractor.ts     (was: wp-manga.ts)
└── extractor.types.ts               (was: types.ts)
```

**Naming Pattern:** `{mediaType}-{source}.extractor.ts`

---

#### **Proposed Structure (Option B - Keep Simple):**
```
extractors/
├── chereads.ts          (unchanged - simple is good)
├── generic-html.ts      (unchanged)
├── opensubtitles.ts     (unchanged)
├── wp-manga.ts          (unchanged)
└── types.ts             (unchanged)
```

**Rationale:** Extractor names are already clear and short

---

### 3️⃣ **templates/** - Konfigurasi Template

#### **Current Structure:**
```
templates/
├── chereads.json
├── manhwaz-chapter.json
├── manhwaz.json
├── opensubtitles.json
├── readnovel.json
├── sample.json
└── wp-manga.json
```

#### **Proposed Structure (Option A - Consistent with Scripts):**
```
templates/
├── novel-chereads.json        (was: chereads.json)
├── manhwa-manhwaz-list.json   (was: manhwaz.json)
├── manhwa-manhwaz-page.json   (was: manhwaz-chapter.json)
├── anime-opensubtitles.json   (was: opensubtitles.json)
├── novel-readnovel.json       (was: readnovel.json)
├── manhwa-wp-manga.json       (was: wp-manga.json)
└── _sample.json               (was: sample.json)
```

**Naming Pattern:** `{mediaType}-{source}-{variant}.json`

---

#### **Proposed Structure (Option B - Source First):**
```
templates/
├── chereads.novel.json
├── manhwaz.list.json
├── manhwaz.page.json
├── opensubtitles.anime.json
├── readnovel.novel.json
├── wp-manga.manhwa.json
└── _sample.json
```

---

## 🎨 Rekomendasi

### **RECOMMENDED: Hybrid Approach**

Menggunakan folder hierarchy untuk scripts (mudah grouping) + simple naming untuk extractors/templates:

```
📁 scripts/
├── 📁 novel/
│   ├── chereads-list.ts
│   ├── chereads-content.ts
│   ├── readnovel-list.ts
│   └── readnovel-content.ts
├── 📁 anime/
│   ├── opensubtitles-list.ts
│   ├── opensubtitles-bulk-download.ts
│   └── opensubtitles-single-download.ts
├── 📁 batch/
│   └── scrape-segments.ts
└── 📁 utils/
    ├── sync-r2.ts
    └── fix-content-types.ts

📁 extractors/ (keep simple)
├── chereads.ts
├── generic-html.ts
├── opensubtitles.ts
├── wp-manga.ts
└── types.ts

📁 templates/
├── chereads.json
├── manhwaz-list.json       (renamed from manhwaz.json)
├── manhwaz-page.json       (renamed from manhwaz-chapter.json)
├── opensubtitles.json
├── readnovel.json
├── wp-manga.json
└── sample.json
```

### **Keuntungan:**
✅ **scripts/** - Folder hierarchy untuk grouping yang jelas
✅ **extractors/** - Simple naming (sudah bagus)
✅ **templates/** - Minor rename untuk clarity

---

## 🚀 Implementation Plan

### Phase 1: Rename Templates (Low Risk)
```bash
mv manhwaz.json manhwaz-list.json
mv manhwaz-chapter.json manhwaz-page.json
```

### Phase 2: Restructure Scripts (Medium Risk)
- Create folders: `novel/`, `anime/`, `batch/`, `utils/`
- Move and rename files
- Update imports in affected files

### Phase 3: Update Documentation
- Update ARCHITECTURE.md
- Update README.md
- Update any CLI examples

---

## ⚠️ Breaking Changes

Files yang perlu update imports setelah rename:

### If using folder structure:
- `src/cli.ts` - jika ada CLI router
- `src/pipelines/jobRunner.ts` - jika memanggil scripts
- Any test files
- Documentation files

### Migration Strategy:
1. Keep old file as symlink/re-export temporarily
2. Update all imports gradually
3. Remove old files after verification

---

## 📝 Decision Needed

**Pilih salah satu approach:**

1. **Option A** - Folder hierarchy (recommended)
   - Pros: Very organized, easy to find
   - Cons: Longer import paths

2. **Option B** - Flat with prefix
   - Pros: Simple, no folder changes
   - Cons: Longer file names

3. **Option C** - Keep current, minor tweaks only
   - Pros: Minimal changes
   - Cons: Less organized

**Your choice?** → Let me know and I'll implement it!
