# Librarium — Sacrum Florilegium

A mobile-first, searchable index of the PDF books stored in Sacrum Florilegium's Cloudflare R2 library.

The site and Worker use the name **Librarium**.

## What it does

- Reads the live R2 object list directly through a Worker binding.
- Includes every `.pdf` object below the configured `pdfs/` prefix.
- Uses Airtable only for the scheduled R2 import and authenticated manual refresh.
  Both Librarium and Census read the same R2 JSON snapshot for ordinary page visits.
  Only records with `Status = Published` appear in Librarium.
- Scans `pdfs/` once daily (06:00 UTC). New PDFs become reviewed-publication drafts
  with file data, PDF metadata, page count, searchable-text detection, probable
  language, a suggested title page, and linked author/classification when the
  evidence is sufficiently clear.
- Sends every book to the existing PDF.js reader rather than opening the raw PDF.
- Uses an Orarium-style slide-out sidebar with expandable main classifications (Liturgia, Theologia, Spiritualia, Preces, Auctores) and instant search by title, author, and subject.
- Opens a selected title directly in the existing PDF.js reader in a new tab. No covers, grids, or intermediate book-detail pages.
- Caches the generated API response at the edge for five minutes; cache misses read R2,
  not Airtable. The sidebar Refresh button becomes available after the initial catalogue loads; it runs a key-protected R2-to-Airtable import (up to five changed PDFs per click) and reloads the visible catalogue immediately. A one-minute cooldown prevents accidental duplicate imports.

## Current production source

| Setting | Value |
| --- | --- |
| R2 bucket | `sacrum-assets` |
| Object prefix | `pdfs/` |
| Public asset origin | `https://assets.sacrumflorilegium.com/` |
| PDF.js reader | `https://reader.sacrumflorilegium.com/web/viewer.html` |

Every PDF now uses the Airtable slug as its filename:

```text
pdfs/my-prayer-book.pdf
```

Librarium produces this reader link:

```text
https://reader.sacrumflorilegium.com/web/viewer.html?file=https%3A%2F%2Fassets.sacrumflorilegium.com%2Fpdfs%2Fmy-prayer-book.pdf
```

The asset namespace is deliberately flat and predictable:

```text
pdfs/<slug>.pdf
covers/<slug>.webp
```

`src/catalog.ts` is the limited, read-only fallback used if the shared R2 snapshot
is missing or corrupt. Normal requests read `system/librarium/catalog-snapshot-v1.json`
from the `sacrum-assets` R2 bucket and cache the response for five minutes.
The fallback shows only its explicitly listed titles; unreviewed R2 PDFs are not
published merely because the snapshot is unavailable.

### Optional title-page assets (not displayed in Librarium)

The **Books → Cover URL** field in Airtable remains available as optional
catalogue metadata, and the API continues to expose `coverUrl` for compatibility.
The Librarium interface deliberately does not display or request these images.

The Cover URL value should point to an actual publicly accessible image.
A populated URL alone does not guarantee that the R2 object exists.
Deployments use the Airtable URLs and do not regenerate book covers.
If an image really needs to be created or repaired, `npm run covers` remains
available as a separate manual maintenance command (requires Cloudflare
credentials plus `pdftoppm` and `cwebp`).

## Reviewed publication

1. Upload `pdfs/<slug>.pdf` to the `sacrum-assets` R2 bucket.
2. After the next daily scan, the Worker creates a Books record with `Status = Draft`
   and `Ingest Status = Review Needed`.
3. Review the flagged fields in Airtable. Confirm the linked Author and
   Classification, add Subjects, Source, edition information, Original Language,
   OCR, and adjust Cover Page when necessary.
4. Change `Status` to `Published`. Librarium will include the book after its
   five-minute catalogue cache expires (usually within five minutes).

Replacing a PDF at the same R2 key refreshes its file-derived fields without
overwriting curated bibliographic metadata or a Published status. The R2 ETag is
stored as `Content Hash` so unchanged PDFs are not processed twice.

## Owner-authorized manual import

After the catalogue loads, **Import & refresh** appears in the sidebar. On first use, enter the private manual import key. It is held only in memory for the current page session, never in a URL or persistent browser storage. The Worker verifies its SHA-256 digest; the plaintext key is not committed. After the key is accepted, subsequent clicks in the same page session import immediately.

A successful `POST /api/refresh` performs the R2-to-Airtable scan (up to five changed PDFs per request), rebuilds the shared R2 snapshot from Airtable, updates the Worker's five-minute cache, and immediately updates the page. Additional files are reported as deferred and can be imported on a subsequent manual run. A one-minute cooldown discourages accidental repeats. Ordinary visitors cannot initiate imports without the key.

To rotate the key, generate a new cryptographically random token and replace `MANUAL_REFRESH_KEY_HASH` with its SHA-256 hex digest in `src/index.ts`, then deploy. **Do not put the plaintext key in this repository.**

The monthly Airtable API allowance applies only to the automatic daily import,
manual imports, and their snapshot rebuilds. Ordinary Librarium and Census visits
never call Airtable.


## Shared snapshot and initial activation

The daily 06:00 UTC cron scans R2 for new/changed PDFs, then publishes a fresh
snapshot at `system/librarium/catalog-snapshot-v1.json` in the existing R2
bucket. The authorized **Import & refresh** button does the same immediately.
The snapshot contains published catalog fields, the existing cover-manifest
fields, and precomputed Census statistics. It does **not** contain all raw
Airtable records or credentials (important because asset buckets may expose
stored objects publicly). The previous snapshot is retained if the import
or snapshot build fails.

**First activation requires one successful Airtable synchronization.** If
Airtable's monthly API allowance is exhausted, the snapshot cannot be built.
Until then Librarium serves the small checked-in catalog and Census reports
that the snapshot is uninitialized. Once Airtable access resumes, use the
authorized Import & refresh button, or let the daily cron initialize it.

Publication remains review-gated: new PDFs are drafts until manually marked
`Published` in Airtable. R2 PDFs absent from the published snapshot remain
hidden.

## Airtable access

The Worker requires an Airtable personal access token with read/write access to
records in the Librarium base for daily/manual synchronization only. Store it as a Cloudflare Worker secret; never add
it to this repository:

```bash
npx wrangler secret put AIRTABLE_TOKEN
```

The base ID and table names are non-secret values in `wrangler.jsonc`.

## Development

```bash
npm install
npm run dev
```

The local R2 binding is isolated from production by default. Add test PDFs with Wrangler or run the automated test suite to exercise the index.

## Validation

```bash
npm run check
```

This regenerates binding types from `wrangler.jsonc`, type-checks the Worker, runs the R2-backed tests, and performs a dry-run deployment build.

## Deploy

```bash
npm run deploy
```

No R2 access keys belong in this repository. Cloudflare grants the Worker direct access through the `LIBRARY_BUCKET` binding declared in `wrangler.jsonc`.

To change the object prefix, public asset origin, or reader origin, update the non-secret values under `vars` in `wrangler.jsonc` and run `npm run types` before committing.
