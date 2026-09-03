# Librarium — Sacrum Florilegium

A mobile-first, searchable index of the PDF books stored in Sacrum Florilegium's Cloudflare R2 library.

The repository is currently named `Florilegium-Librariun`; the site and Worker use the intended product name, **Librarium**.

## What it does

- Reads the live R2 object list directly through a Worker binding.
- Includes every `.pdf` object below the configured `pdfs/` prefix.
- Uses Airtable as the live, canonical catalogue and publishes only records whose
  `Status` is `Published`.
- Scans `pdfs/` every ten minutes. New PDFs become reviewed-publication drafts
  with file data, PDF metadata, page count, searchable-text detection, probable
  language, a suggested title page, and linked author/classification when the
  evidence is sufficiently clear.
- Sends every book to the existing PDF.js reader rather than opening the raw PDF.
- Provides a compact mobile list, instant search, and A–Z or recently-added sorting.
- Caches the generated API response at the edge for five minutes, so new R2 books appear automatically without maintaining a second index.

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

`src/catalog.ts` is only the read-only fallback used if Airtable is temporarily
unavailable. Normal requests read the live Airtable catalogue at the edge and
cache it for five minutes.

## Reviewed publication

1. Upload `pdfs/<slug>.pdf` to the `sacrum-assets` R2 bucket.
2. Within ten minutes, the Worker creates a Books record with `Status = Draft`
   and `Ingest Status = Review Needed`.
3. Review the flagged fields in Airtable. Confirm the linked Author and
   Classification, add Subjects, Source, edition information, Original Language,
   OCR, and adjust Cover Page when necessary.
4. Change `Status` to `Published`. Librarium will include the book after its
   five-minute catalogue cache expires.

Replacing a PDF at the same R2 key refreshes its file-derived fields without
overwriting curated bibliographic metadata or a Published status. The R2 ETag is
stored as `Content Hash` so unchanged PDFs are not processed twice.

## Airtable access

The Worker requires an Airtable personal access token with read/write access to
records in the Librarium base. Store it as a Cloudflare Worker secret; never add
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
