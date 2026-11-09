#!/usr/bin/env node
/**
 * One-time, additive Airtable -> Supabase migration for Sacrum Florilegium.
 *
 * Dry run is the default. No source rows are deleted or updated in Airtable.
 * Requires an initial Supabase schema migration; writes use server-only
 * sb_secret_... API keys. Intended for GitHub Actions on an iPhone.
 */
const APPLY = process.argv.includes("--apply");
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const TABLES = ["Authors", "Classifications", "Books", "Unpublished"];

function requireValue(value, name) {
  if (!value) throw new Error(`Missing ${name}. See supabase/README.md.`);
  return value;
}

function string(value) {
  return typeof value === "string" ? value.trim() : null;
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function boolean(value) {
  return typeof value === "boolean" ? value : null;
}
function isoDate(value) {
  const text = string(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
function ids(value) {
  return Array.isArray(value) ? value.filter((x) => typeof x === "string") : [];
}
function subjects(value) {
  return Array.isArray(value) ? value
    .map((x) => typeof x === "string" ? x : x?.name)
    .filter((x) => typeof x === "string" && x.trim()) : [];
}
function baseRecord(record) {
  return {
    airtable_id: record.id,
    source_created_at: record.createdTime,
    airtable_fields: record.fields,
  };
}

async function airtableFetch(table) {
  const rows = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(table)}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    if (response.status === 404 && table === "Unpublished") {
      console.warn("No Unpublished table; skipping optional import.");
      return [];
    }
    if (!response.ok) {
      throw new Error(`Airtable ${table}: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const result = await response.json();
    rows.push(...result.records);
    offset = result.offset;
  } while (offset);
  return rows;
}

async function supabaseUpsert(table, rows, conflict, select = "id,airtable_id") {
  if (!rows.length) return [];
  const results = [];
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
    url.searchParams.set("on_conflict", conflict);
    url.searchParams.set("select", select);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(batch),
    });
    if (!response.ok) {
      throw new Error(`Supabase ${table}: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    results.push(...(await response.json()));
  }
  return results;
}

function ensureUnique(values, label) {
  const duplicates = new Set();
  const seen = new Set();
  for (const value of values.filter(Boolean)) {
    const normalized = value.toLocaleLowerCase("en-US");
    if (seen.has(normalized)) duplicates.add(value);
    seen.add(normalized);
  }
  if (duplicates.size) {
    throw new Error(`Duplicate ${label}: ${[...duplicates].join(", ")}. Resolve before importing.`);
  }
}

function mapAuthor(record) {
  const f = record.fields;
  return {
    ...baseRecord(record),
    name: string(f.Name) || `Unnamed author [${record.id}]`,
    sort_name: string(f["Sort Name"]),
    honorific: string(f.Honorific),
    religious_order: string(f.Order),
  };
}
function mapClass(record) {
  const f = record.fields;
  return {
    ...baseRecord(record),
    class: string(f.Class) || `Unclassified [${record.id}]`,
    description: string(f.Description),
  };
}
function mapBook(record) {
  const f = record.fields;
  return {
    ...baseRecord(record),
    title: string(f.Title),
    slug: string(f.Slug),
    status: string(f.Status) || "Draft",
    subjects: subjects(f.Subjects),
    language: string(f.Language),
    original_language: string(f["Original Language"]),
    edition_year: f["Edition Year"] == null ? null : String(f["Edition Year"]),
    publisher: string(f.Publisher),
    source: string(f.Source),
    date_added: isoDate(f["Date Added"]),
    pages: number(f.Pages),
    r2_key: string(f["R2 Key"]),
    content_hash: string(f["Content Hash"]),
    file_size: number(f["File Size"]),
    file_type: string(f["File Type"]),
    pdf_available: boolean(f["PDF Available"]),
    local_pdf: string(f["Local PDF"]),
    cover_url: string(f["Cover URL"]),
    cover_page: number(f["Cover Page"]),
    searchable_text: boolean(f["Searchable Text"]),
    ocr: boolean(f.OCR),
    ingest_status: string(f["Ingest Status"]),
    ingest_message: string(f["Ingest Message"]),
    last_ingested: string(f["Last Ingested"]),
  };
}

async function main() {
  requireValue(AIRTABLE_TOKEN, "AIRTABLE_TOKEN");
  requireValue(AIRTABLE_BASE_ID, "AIRTABLE_BASE_ID");
  if (APPLY) {
    requireValue(SUPABASE_URL, "SUPABASE_URL");
    requireValue(SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
    if (!/^https:\/\/[-a-z0-9]+\.supabase\.co$/i.test(SUPABASE_URL)) {
      throw new Error("SUPABASE_URL must be the official https://<project>.supabase.co URL.");
    }
    if (!SUPABASE_SECRET_KEY.startsWith("sb_secret_")) {
      throw new Error("Use a new Supabase sb_secret_ API key, not a publishable/legacy key.");
    }
  }

  const exports = {};
  // Fetch all Airtable data before beginning any Supabase changes.
  for (const table of TABLES) exports[table] = await airtableFetch(table);

  const authors = exports.Authors.map(mapAuthor);
  const classifications = exports.Classifications.map(mapClass);
  const books = exports.Books.map(mapBook);
  const unpublished = exports.Unpublished.map((r) => ({
    ...baseRecord(r),
    title: string(r.fields.Title) || string(r.fields.Name),
  }));

  if (!books.length) throw new Error("Books table is empty; refusing to migrate.");
  ensureUnique(books.map((b) => b.slug), "book slugs");
  ensureUnique(books.map((b) => b.r2_key), "R2 keys");
  ensureUnique(classifications.map((c) => c.class), "classification names");

  const authorIds = new Set(authors.map((a) => a.airtable_id));
  const classIds = new Set(classifications.map((c) => c.airtable_id));
  const missing = [];
  for (const record of exports.Books) {
    for (const id of ids(record.fields.Authors)) {
      if (!authorIds.has(id)) missing.push(`Book ${record.id} references absent author ${id}`);
    }
    for (const id of ids(record.fields.Classification)) {
      if (!classIds.has(id)) missing.push(`Book ${record.id} references absent classification ${id}`);
    }
  }
  if (missing.length) throw new Error(`Missing linked records:\n${missing.join("\n")}`);

  console.log(JSON.stringify({
    mode: APPLY ? "APPLY" : "DRY RUN",
    tables: {
      authors: authors.length,
      classifications: classifications.length,
      books: books.length,
      unpublished: unpublished.length,
    },
    publishedBooks: books.filter((b) => b.status === "Published").length,
    links: {
      authors: exports.Books.reduce((n, r) => n + ids(r.fields.Authors).length, 0),
      classifications: exports.Books.reduce((n, r) => n + ids(r.fields.Classification).length, 0),
    },
  }, null, 2));

  if (!APPLY) {
    console.log("Dry run: Supabase was not modified. Re-run with --apply after validating the schema and counts.");
    return;
  }

  const authorMapping = new Map((await supabaseUpsert("authors", authors, "airtable_id"))
    .map((r) => [r.airtable_id, r.id]));
  const classMapping = new Map((await supabaseUpsert("classifications", classifications, "airtable_id"))
    .map((r) => [r.airtable_id, r.id]));
  const bookMapping = new Map((await supabaseUpsert("books", books, "airtable_id"))
    .map((r) => [r.airtable_id, r.id]));
  await supabaseUpsert("unpublished", unpublished, "airtable_id");

  const bookAuthors = [];
  const bookClasses = [];
  for (const record of exports.Books) {
    const bookId = bookMapping.get(record.id);
    if (!bookId) throw new Error(`Missing migrated book mapping for ${record.id}`);
    ids(record.fields.Authors).forEach((id, pos) => bookAuthors.push({
      book_id: bookId, author_id: authorMapping.get(id), sort_order: pos,
    }));
    ids(record.fields.Classification).forEach((id, pos) => bookClasses.push({
      book_id: bookId, classification_id: classMapping.get(id), sort_order: pos,
    }));
  }
  await supabaseUpsert("book_authors", bookAuthors, "book_id,author_id", "book_id,author_id");
  await supabaseUpsert("book_classifications", bookClasses, "book_id,classification_id", "book_id,classification_id");
  console.log("Migration applied. Verify row counts and relationships in Supabase before switching Cloudflare.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
