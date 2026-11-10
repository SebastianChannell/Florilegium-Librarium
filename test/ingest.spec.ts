import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestLibrary } from "../src/ingest";
import { buildAndSaveSnapshot, type CatalogSnapshot } from "../src/snapshot";

// Model a readable PDF without requiring a real archived book or live R2 access.
vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn(async () => ({
    numPages: 2,
    getPage: async (_page: number) => ({
      getTextContent: async () => ({
        items: [
          { str: "The Catholic catechism explains the doctrines of the faith and the commandments." },
          { str: "The faithful learn the truth with reverence and good instruction in the Church." },
        ],
      }),
      cleanup: () => {},
    }),
  })),
  getMeta: vi.fn(async () => ({
    info: { Title: "The Parish Catechism", Author: "Fr. Example" },
    metadata: {},
  })),
}));

const SECRET = "sb_secret_test_only";
const API_URL = "https://gqqzogtrywuvomzmapgf.supabase.co";
const config = {
  prefix: "pdfs/",
  publicBaseUrl: "https://assets.sacrumflorilegium.com/",
  projectUrl: API_URL,
  booksTable: "Books",
  authorsTable: "Authors",
  classificationsTable: "Classifications",
};

interface BookRow {
  id: string;
  title: string;
  slug: string;
  status: string;
  r2_key: string;
  content_hash: string;
  cover_url: string;
  cover_page: number;
  ingest_status: string;
  book_authors: Array<{ author_id: string; sort_order: number }>;
  book_classifications: Array<{ classification_id: string; sort_order: number }>;
  [key: string]: unknown;
}

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const books: BookRow[] = [];
  const authors = [{ id: "author-1", name: "Fr. Example", sort_name: "Example, Fr." }];
  const classifications = [{ id: "class-1", class: "Theologia" }];
  const posts: Array<{ path: string; body: unknown; prefer: string }> = [];
  const objects = [{
    key: "pdfs/the-parish-catechism.pdf",
    size: 314,
    etag: "original-r2-etag",
    uploaded: new Date("2026-11-10T15:00:00Z"),
  }];
  const snapshots: CatalogSnapshot[] = [];
  const saved = new Map<string, string>();

  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (method === "GET") {
      if (path.endsWith("/books")) return Response.json(books);
      if (path.endsWith("/authors")) return Response.json(authors);
      if (path.endsWith("/classifications")) return Response.json(classifications);
    }
    if (method === "POST") {
      const body: unknown = JSON.parse(String(init?.body));
      posts.push({ path, body, prefer: new Headers(init?.headers).get("Prefer") ?? "" });
      if (path.endsWith("/books")) {
        const fields = body as Record<string, unknown>;
        const row = {
          ...fields,
          id: "book-1",
          created_at: "2026-11-10T15:00:00Z",
          book_authors: [],
          book_classifications: [],
        } as BookRow;
        books.push(row);
        return Response.json([row], { status: 201 });
      }
      if (path.endsWith("/book_authors")) {
        books[0].book_authors.push(...(body as BookRow["book_authors"]));
      } else if (path.endsWith("/book_classifications")) {
        books[0].book_classifications.push(...(body as BookRow["book_classifications"]));
      } else {
        throw new Error("Unexpected POST " + path);
      }
      // PostgREST accepts inserts with no response body.
      return new Response(null, { status: 201 });
    }
    if (method === "PATCH" && path.endsWith("/books")) {
      const fields = JSON.parse(String(init?.body)) as Record<string, unknown>;
      Object.assign(books[0], fields);
      return Response.json([books[0]]);
    }
    if (method === "DELETE" && path.endsWith("/books")) {
      books.splice(0, books.length);
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected Supabase REST request " + method + " " + path);
  }));

  const bucket = {
    list: async () => ({
      objects, truncated: false, cursor: undefined,
      delimitedPrefixes: [],
    }),
    get: async (key: string) => {
      if (key.startsWith("pdfs/")) return {
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
      const value = saved.get(key);
      return value ? { json: async () => JSON.parse(value) } : null;
    },
    put: async (key: string, value: string) => {
      saved.set(key, value);
      const parsed = JSON.parse(value) as CatalogSnapshot;
      snapshots.push(parsed);
      return {} as R2Object;
    },
  } as unknown as R2Bucket;

  return { bucket, books, objects, posts, snapshots };
}

describe("New R2 PDF -> Supabase draft -> explicit publication", () => {
  it("auto-fills title, author/classification, language, pages, and file metadata, without publishing", async () => {
    const { bucket, books, posts, objects } = setup();
    const summary = await ingestLibrary(bucket, SECRET, config);

    expect(summary).toMatchObject({ scanned: 1, created: 1, updated: 0, failed: 0 });
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({
      title: "The Parish Catechism",
      slug: "the-parish-catechism",
      status: "Draft",
      r2_key: objects[0].key,
      content_hash: objects[0].etag,
      file_type: "PDF",
      pdf_available: true,
      pages: 2,
      searchable_text: true,
      language: "English",
      ocr: false,
      ingest_status: "Review Needed",
      cover_page: 1,
    });
    expect(books[0].ingest_message).toContain("Verify subjects");
    expect(books[0].book_authors).toMatchObject([{ author_id: "author-1", sort_order: 0 }]);
    expect(books[0].book_classifications).toMatchObject([{ classification_id: "class-1", sort_order: 0 }]);
    expect(posts.filter((p) => p.path.includes("book_"))).toHaveLength(2);
    expect(posts.filter((p) => p.path.includes("book_")).every((p) => p.prefer === "return=minimal")).toBe(true);

    const snapshot = await buildAndSaveSnapshot(bucket, SECRET, config);
    expect(snapshot.publishedBooks).toHaveLength(0);
    expect(snapshot.covers).toHaveLength(0);
    expect(snapshot.census).toMatchObject({ totalBooks: 1, publishedBooks: 0, draftBooks: 1 });
    expect(snapshot.census.recent).toHaveLength(0);
    expect(JSON.stringify(snapshot)).not.toContain("The Parish Catechism");
  });

  it("only publishes after manual Status change, and never overwrites reviewed metadata", async () => {
    const { bucket, books, objects } = setup();
    await ingestLibrary(bucket, SECRET, config);
    const draftSnapshot = await buildAndSaveSnapshot(bucket, SECRET, config);
    expect(draftSnapshot.publishedBooks).toHaveLength(0);

    // This represents the owner's manual review and Status edit in Supabase.
    books[0].status = "Published";
    books[0].title = "Reviewed Catechism";
    books[0].cover_url = "https://assets.sacrumflorilegium.com/covers/reviewed.webp";
    const approved = await buildAndSaveSnapshot(bucket, SECRET, config);
    expect(approved.publishedBooks).toHaveLength(1);
    expect(approved.publishedBooks[0]).toMatchObject({
      title: "Reviewed Catechism",
      author: "Fr. Example",
      classification: "Theologia",
    });
    expect(approved.covers).toHaveLength(1);

    // Replacing a PDF refreshes file-derived fields, never publication status
    // nor the owner's chosen title and cover.
    objects[0].etag = "new-r2-etag";
    const update = await ingestLibrary(bucket, SECRET, config);
    expect(update).toMatchObject({ created: 0, updated: 1, failed: 0 });
    expect(books[0]).toMatchObject({
      status: "Published",
      title: "Reviewed Catechism",
      cover_url: "https://assets.sacrumflorilegium.com/covers/reviewed.webp",
      content_hash: "new-r2-etag",
      ingest_status: "Ready",
    });
  });
});
