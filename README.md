# Librarium — Sacrum Florilegium

A mobile-first, searchable index of the PDF books stored in Sacrum Florilegium's Cloudflare R2 library.

The site and Worker use the name **Librarium**.

## What it does

- Reads the live R2 object list directly through a Worker binding.
- Includes every `.pdf` object below the configured `pdfs/` prefix.
- Uses Supabase as the canonical metadata database for the daily R2 scan and the authenticated manual import. Normal Librarium/Census page views read R2, not Supabase.
  Both Librarium and Census read the same R2 JSON snapshot for ordinary page visits.
  Only records with `Status = Published` appear in Librarium.
- Starts a daily import at 06:00 UTC and automatically resumes pending work every minute. New PDFs become reviewed-publication drafts
  with file data, PDF metadata, page count, searchable-text detection, probable
  language, a suggested title page, and linked author/classification when the
  evidence is sufficiently clear.
- Sends every book to the existing PDF.js reader rather than opening the raw PDF.
- Uses an Orarium-style slide-out sidebar with expandable main classifications (Liturgia, Theologia, Spiritualia, Preces, Auctores) and instant search by title, author, and subject.
- Opens a selected title directly in the existing PDF.js reader in a new tab. No covers, grids, or intermediate book-detail pages.
- Caches the generated API response at the edge for five minutes; cache misses read R2,
  not Supabase. The sidebar Refresh button becomes available after the initial catalogue loads; it starts a single persistent R2-to-Supabase import queue. Cloudflare continues in bounded batches even when the browser closes.

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

1. Upload `pdfs/<slug>.pdf` into the existing `sacrum-assets` R2 bucket.
2. The daily import (starting at 06:00 UTC) or the private **Import & refresh**
   button creates a record in **Supabase → Table Editor → books**, with
   `status = Draft` and `ingest_status = Review Needed`. It does **not**
   appear in the public Librarium or cover manifest at this stage.
3. In the [Supabase Books table](https://supabase.com/dashboard/project/gqqzogtrywuvomzmapgf/editor),
   filter `status = Draft` to find your unpublished review queue. Check the title,
   authors (via `book_authors` if linked), classification (via
   `book_classifications`), language, PDF page count, and suggested cover page.
   Add or correct subjects, publisher, edition year, original language, OCR
   information, and any other fields you know.
4. Manually edit the book's `status` value from `Draft` to `Published` in
   **books**. No automated process changes this status for you.
5. Use **Rebuild index** in Librarium to publish the newly approved title
   immediately, or wait until the next daily snapshot generation (plus any
   short cache delay). Merely changing `status` in Supabase does **not**
   instantly update the cached R2 catalogue.

The old `unpublished` table was an archival placeholder from Airtable's
separate export. **New unpublished books live in `books` with status `Draft`**,
not in that legacy table. This keeps publication as a single explicit review
action.

Metadata extraction is best-effort: the Worker reads PDF metadata and up to
six pages for titles, author, page count, rough language, searchable-text
detection, and a suggested cover page. Files above 25 MB or unreadable PDFs
still get a Draft record with basic file metadata and an explanation in
`ingest_message`. Inferred bibliographic information must be checked; a
suggested `cover_url` is not a generated image.

Replacing a PDF at the same R2 key refreshes its file-derived fields without
overwriting curated bibliographic metadata or a Published status. The R2 ETag is
stored as `Content Hash` so unchanged PDFs are not processed twice.

## Automatic, resumable R2 import queue

Uploading a PDF to R2 **does not trigger immediate processing**.
The daily 06:00 UTC trigger starts the import; **Import & refresh** queues one
on demand. Its server response is HTTP 202 with the job ID. The browser polls
`GET /api/import-status` (authenticated with the existing manual key)
to show progress.

A second scheduled trigger runs **once per minute**. While a queue is active,
it processes a small batch of up to **two changed PDFs per invocation** and
checkpoints progress at `system/librarium/import-queue-v1.json` in R2.
This is a *safety limit per Worker execution*, not a limit on the total number
of PDFs the job imports. The queue resumes automatically until no changed
PDFs remain; do not keep pressing the button. If the browser closes, scheduled
processing continues independently.

The state record uses conditional R2 ETag writes and an expiration lease to
avoid concurrent Workers processing the same batch, and is resumable after a
failed invocation. Failed object versions are checkpointed by hashes instead
of exposing unpublished filenames in the state JSON. One problematic PDF
cannot permanently block the others. Three consecutive fatal batch failures
pause the job with an error; press **Import & refresh** again after checking
the Worker logs to start a new attempt. Individual failed PDFs are logged
and automatically retried by the next *new* import job, not repeatedly in
the same run.

The job only completes after rebuilding the published-only R2 snapshot.
A manual **Rebuild index** remains a separate action, does not scan PDFs, and
does not interfere with ongoing import work. Publishing still requires manual
review in Supabase (`books.status = Published`).

For missing files, verify they are in bucket `sacrum-assets` with a flat
key such as `pdfs/my-new-title.pdf`: the importer scans only keys with
prefix `pdfs/` and suffix `.pdf` (case-insensitive). Files uploaded to the
bucket root or `covers/` will not be discovered.

## Owner-authorized manual import

In Librarium's sidebar, choose **Import & refresh** and enter the private
manual import key from your password manager. It stays in memory for that
page session, not in a URL or persistent browser storage. The key protects
`POST /api/refresh` and `GET /api/import-status` and is **separate** from the
Supabase `SUPABASE_SECRET_KEY` installed only on the Cloudflare Worker.

Repeated button presses while a job is active simply join the existing
queue; no extra work is scheduled. The progress display includes the number
of drafts created, existing records updated, outstanding files, and failures.
New titles do not enter the public website until you mark them `Published`
and the R2 snapshot is updated. To rotate the original manual key, set the
optional `MANUAL_REFRESH_KEY` **Worker secret** to a long random password;
never put the plaintext key in GitHub.

## Shared snapshot and initial activation

The daily 06:00 UTC trigger starts the persistent import job; the minutely
trigger continues it until drained, then rebuilds the snapshot at
`system/librarium/catalog-snapshot-v1.json` in the existing R2 bucket.
The authorized **Import & refresh** button starts the same workflow on demand.
The snapshot contains **published-only** book and cover-manifest entries,
plus precomputed Census statistics. Draft book titles, cover paths, authors,
subjects, and recent-book descriptions are not exposed (only aggregate draft
counts and generic review-completeness indicators). It does **not** contain
all raw Supabase records or credentials (important because asset buckets may
expose stored objects publicly). The previous snapshot is retained if the import
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
3. Once the secret is saved, open Librarium. Use **Rebuild index** to rebuild the public R2 snapshot directly from already-published Supabase books, or **Import & refresh** to queue all outstanding R2 PDFs for automatic background processing. Both require the separate manual import key.

Equivalent CLI (on a trusted machine with Wrangler authenticated):

```bash
npx wrangler secret put SUPABASE_SECRET_KEY
```

**Never commit, paste, or disclose the secret value in GitHub source, client
code, URLs, logs, or R2 objects.** Do not use a Supabase publishable key for
database writes: all catalog tables have RLS enabled and no public policies.
The existing manual refresh key protects the *refresh endpoint* and is distinct
from the server-side Supabase API key.

### Repairing a disabled or unauthorized import button

The **Import & refresh** and **Rebuild index** buttons are enabled after the
site loads. Even if the initial catalog cannot be read, both controls remain
available so a broken or missing snapshot can be repaired.

The **manual import key** entered in the iPhone interface is **not** the
Supabase `sb_secret_...` key. The original manual key is still supported.
If you no longer have it, create your own 32–128 character random password,
save it privately, and add it to the **same** Cloudflare Worker under
**Settings → Variables and Secrets** as another **Secret** named
`MANUAL_REFRESH_KEY`. The new key replaces the old manual key as the
accepted login for both maintenance buttons. Do not enter the Supabase
secret into the Librarium website.

There are two different authorized maintenance actions:

- `POST /api/reseed` rebuilds the JSON snapshot using Supabase only. It is
  designed for recovery from an unavailable or stale R2 index and does not
  inspect or import any PDFs.
- `POST /api/refresh` starts or joins the existing import queue. The minutely
  scheduled Worker drains it automatically in safe batches, preserving all
  reviewed publication metadata. `GET /api/import-status` reads progress.

Both require a valid manual key and return structured error codes.
Rebuild index has a one-minute cooldown; an active import job is idempotent. A Supabase key or schema error shows a specific
non-sensitive message on screen and the Worker logs contain detailed errors.
A missing Cloudflare `SUPABASE_SECRET_KEY` produces
`SUPABASE_SECRET_MISSING`. Existing R2 content is never discarded on failure.

The daily trigger remains at 06:00 UTC with a minutely continuation trigger;
the existing authorization, five-minute R2 API cache, publication review,
and PDF.js links are unchanged. An unsuccessful snapshot rebuild retains the previous R2
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
