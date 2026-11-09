# Supabase migration — Sacrum Florilegium

**Status: preparation only.** The production Librarium and Census Workers still
use the shared R2 snapshot that is populated from Airtable. Nothing in this
directory switches the website to Supabase.

## Designed schema

The SQL migration at `migrations/20261109000000_librarium_initial.sql`
creates the following tables in a **new, otherwise empty Supabase project**:

| Table | Use |
| --- | --- |
| `books` | Bibliographic, publication and R2/PDF metadata |
| `authors` | Author and sorting details |
| `classifications` | Existing Liturgia / Theologia / Spiritualia / Preces / Auctores records |
| `book_authors` | Multiple linked authors, preserving order |
| `book_classifications` | Multiple linked classifications, preserving order |
| `unpublished` | Preserve the separate Airtable Unpublished table until its schema is inspected |
| `published_books` | Read-only, published-only view for a future R2 snapshot generator |

Each imported record retains its original Airtable ID in `airtable_id` and
its complete original fields in `airtable_fields` (JSONB). This avoids losing
unexpected properties before the live Airtable schema can be inspected.

The tables use RLS with **no anonymous or authenticated user policies**.
The Supabase secret key is server-only; it must never be embedded in browser
code or stored in a public Cloudflare R2 snapshot. Views have no public grants.
Initially, the published R2 snapshot remains the only public data output.

## Stage 1 — Create and connect a Supabase project

1. Create a free project at https://supabase.com/dashboard.
2. Connect the **Supabase plugin in ChatGPT** if you want ChatGPT to manage
   tables directly. Connecting requires your approval.
3. Apply the initial SQL migration to the new project using a database migration
   workflow (Supabase CLI or an authorized database connection). Keep this
   SQL file in version control as the canonical schema. Do not apply twice.
4. Verify the tables are visible in Supabase Table Editor.

You do **not** need to migrate the R2 bucket, PDFs, covers, PDF.js reader,
Cloudflare Pages, or Workers.

## Stage 2 — Import Airtable records

The script `scripts/migrate-airtable-to-supabase.mjs` supports a dry-run-first,
non-destructive import. It reads Airtable and performs **no writes by default**.

You can run it from a computer, or via the repository's GitHub Actions
**Migrate Airtable to Supabase (manual)** workflow when it is on `main`.
Using Actions makes this possible from iPhone.

In **GitHub repository Settings → Secrets and variables → Actions** set:

- Secret `AIRTABLE_TOKEN`: Airtable PAT with read access to the Librarium base
- Variable `SUPABASE_URL`: `https://<project-ref>.supabase.co`
- Secret `SUPABASE_SECRET_KEY`: new Supabase server-only `sb_secret_...` key

The Airtable base ID is already included in the workflow as a nonsecret value.
Do not paste your credentials into a chat, issue, file, or public code.

First select the workflow with `apply = false`. Review the count of books,
authors, classifications, published records, and linked relations. Then select
`apply = true` to run the import after the initial SQL schema is installed.

The workflow requires working Airtable API access. While your monthly API quota
is exhausted, even a dry run will return HTTP 429; wait for the quota to reset
or use a separate CSV-based migration once the exports are available. The script
reads paginated Airtable tables sequentially and does not rely on the website.

The import uses idempotent upserts (Airtable ID is the unique key), makes no
changes or deletions in Airtable, and does not delete existing Supabase rows.
It intentionally does not sync deletes or automatically overwrite differences
back to Airtable; treat it as a **one-time migration**, not continuous sync.

## Stage 3 — Verify before cutover

- Compare source/destination counts per table, including draft and published.
- Confirm a sampled book has correct title, authors, classifications, subjects,
  language, `r2_key`, `slug`, and `cover_url`.
- Compare author and classification link counts, and verify multiple links.
- Confirm every published book has a valid slug and PDF association.
- Test a Supabase-backed R2 snapshot generator in a non-production environment.
- Only after validation, change the **daily ingest and manual refresh** to
  write to Supabase instead of Airtable; keep normal Librarium/Census reads on R2.
- Retain the original Airtable base and a backup for rollback.

## Current limits

Airtable's API quota is exhausted, so the exact live field schema and counts
could not be inspected. Columns here cover known Worker fields; the JSONB
archive preserves all original fields. The `Unpublished` table is provisionally
modeled with its title and JSONB archive because its specific columns are not
yet verified. Inspect the actual CSV/schema before removing any Airtable fields.

No production Cloudflare configuration changes are included in this PR.
