# Librarium — Sacrum Florilegium

A mobile-first, searchable index of the PDF books stored in Sacrum Florilegium's Cloudflare R2 library.

The repository is currently named `Florilegium-Librariun`; the site and Worker use the intended product name, **Librarium**.

## What it does

- Reads the live R2 object list directly through a Worker binding.
- Includes every `.pdf` object below the configured `pdfs/` prefix.
- Derives a readable title and collection label from each R2 object key.
- Sends every book to the existing PDF.js reader rather than opening the raw PDF.
- Provides a compact mobile list, instant search, and A–Z or recently-added sorting.
- Caches the generated API response at the edge for five minutes, so new R2 books appear automatically without maintaining a second index.

## Current production source

| Setting | Value |
| --- | --- |
| R2 bucket | `sacrum-assets` |
| Object prefix | `pdfs/` |
| Public asset origin | `https://assets.sacrumflorilegium.com/` |
| PDF.js reader | `https://reader.sacrumflorilegium.com/` |

For an R2 key such as:

```text
pdfs/fr-lasance/my-prayer-book.pdf
```

Librarium produces this reader link:

```text
https://reader.sacrumflorilegium.com/?file=https%3A%2F%2Fassets.sacrumflorilegium.com%2Fpdfs%2Ffr-lasance%2Fmy-prayer-book.pdf
```

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

