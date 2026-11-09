# Librarium — Sacrum Florilegium

A mobile-first, searchable index of the PDF books stored in Sacrum Florilegium's Cloudflare R2 library.

The site and Worker use the name **Librarium**.

## What it does

- Reads the live R2 object list directly through a Worker binding.
- Includes every `.pdf` object below the configured `pdfs/` prefix.
- Uses Supabase as the canonical metadata database for the daily R2 scan and the authenticated manual import. Normal Librarium/Census page views read R2, not Supabase.
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
  not Airtable. The sidebar Refresh button becomes available after the initial catalogue loads; it runs a key-protected R2-to-Supabase import (up to five changed PDFs per click) and reloads the visible catalogue immediately. A one-minute cooldown prevents accidental duplicate imports.

## Current production source

| Setting | Value |
| --- | --- |
| R2 bucket | `sacrum-assets` |
| Object prefix | `pdfs/` |
| Public asset origin | `https://assets.sacrumflorilegium.com/` |
| PDF.js reader | `https://reader.sacrumflorilegium.com/web/viewer.html` |

Every PDF uses its catalog slug as its filename:

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

The **Books → Cover URL** field in Supabase remains available as optional
catalogue metadata, and the API continues to expose `coverUrl` for compatibility.
The Librarium interface deliberately does not display or request these images.

The Cover URL value should point to an actual publicly accessible image.
A populated URL alone does not guarantee that the R2 object exists.
Deployments use the Supabase catalog URLs and do not regenerate book covers.
If an image really needs to be created or repaired, `npm run covers` remains
available as a separate manual maintenance command (requires Cloudflare
credentials plus `pdftoppm` and `cwebp`).

## Reviewed publication

1. Upload `pdfs/<slug>.pdf` to the `sacrum-assets` R2 bucket.
2. After the next daily scan, the Worker creates a Books record with `Status = Draft`
   and `Ingest Status = Review Needed`.
3. Review the flagged fields in Supabase. Confirm the linked Author and
   Classification, add Subjects, Source, edition information, Original Language,
   OCR, and adjust Cover Page when necessary.
4. Change `Status` to `Published`. Librarium will include the book after its
   five-minute catalogue cache expires (usually within five minutes).

Replacing a PDF at the same R2 key refreshes its file-derived fields without
overwriting curated bibliographic metadata or a Published status. The R2 ETag is
stored as `Content Hash` so unchanged PDFs are not processed twice.

## Owner-authorized manual import

After the catalogue loads, **Import & refresh** appears in the sidebar. On first use, enter the private manual import key. It is held only in memory for the current page session, never in a URL or persistent browser storage. The Worker verifies its SHA-256 digest; the plaintext key is not committed. After the key is accepted, subsequent clicks in the same page session import immediately.

A successful `POST /api/refresh` performs the R2-to-Supabase scan (up to five changed PDFs per request), rebuilds the shared R2 snapshot from Supabase, updates the Worker's five-minute cache, and immediately updates the page. Additional files are reported as deferred and can be imported on a subsequent manual run. A one-minute cooldown discourages accidental repeats. Ordinary visitors cannot initiate imports without the key.

To rotate the key, generate a new cryptographically random token and replace `MANUAL_REFRESH_KEY_HASH` with its SHA-256 hex digest in `src/index.ts`, then deploy. **Do not put the plaintext key in this repository.**

Supabase is contacted only during the daily R2 import, authorized manual refresh,
and snapshot generation. Ordinary Librarium and Census page visits never contact Supabase.


## Shared snapshot and initial activation

The daily 06:00 UTC cron scans R2 for new/changed PDFs, then publishes a fresh
snapshot at `system/librarium/catalog-snapshot-v1.json` in the existing R2
bucket. The authorized **Import & refresh** button does the same immediately.
The snapshot contains published catalog fields, the existing cover-manifest
fields, and precomputed Census statistics. It does **not** contain all raw
Supabase records or credentials (important because asset buckets may expose
stored objects publicly). The previous snapshot is retained if the import
or snapshot build fails.

**First activation requires a server-only Supabase secret and one successful
synchronization.** If the secret is not configured, the Worker skips the daily
import and denies the manual import with HTTP 503. Ordinary site views still use
R2 (or the limited built-in fallback if a snapshot does not yet exist).
Once the secret is installed, use the authenticated Import & refresh button,
or let the daily cron initialize the full snapshot.

Publication remains review-gated: new PDFs are drafts until manually marked
`Published` in Supabase. R2 PDFs absent from the published snapshot remain
hidden.

## Supabase access — required for the cutover

The imported catalog is in the `Librarium` Supabase project:
`https://gqqzogtrywuvomzmapgf.supabase.co`.

**Only the server-side Cloudflare Worker has database credentials.** The project
URL is a non-secret setting in `wrangler.jsonc`. The database key must be
installed separately in Cloudflare **Worker secrets**:

1. Open [Supabase API Keys](https://supabase.com/dashboard/project/gqqzogtrywuvomzmapgf/settings/api-keys) and create/copy a new **secret key** (starts with `sb_secret_`).
2. Open Cloudflare dashboard → **Workers & Pages** → `florilegium-librarium` → **Settings** → **Variables and Secrets**, then add **Secret** `SUPABASE_SECRET_KEY` with that value.
3. Once the secret has been saved, open Librarium and use the existing authorized **Import & refresh** action. It scans R2 (up to five changed PDFs), writes new/changed records into Supabase, and builds the full R2 catalog snapshot.

Equivalent CLI (on a trusted machine with Wrangler authenticated):

```bash
npx wrangler secret put SUPABASE_SECRET_KEY
```

**Never commit, paste, or disclose the secret value in GitHub source, client
code, URLs, logs, or R2 objects.** Do not use a Supabase publishable key for
database writes: all catalog tables have RLS enabled and no public policies.
The existing manual refresh key protects the *refresh endpoint* and is distinct
from the server-side Supabase API key.

The daily trigger remains 06:00 UTC; the existing authorization, refresh
cooldown, five-minute R2 API cache, publication review, and PDF.js links
are unchanged. An unsuccessful snapshot rebuild retains the previous R2
snapshot. Keep Airtable as a historical backup until the Supabase cutover
has been verified in production.

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
