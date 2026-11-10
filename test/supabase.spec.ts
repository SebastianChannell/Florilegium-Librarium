import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogClient } from "../src/catalog-db";
import { buildAndSaveSnapshot, CATALOG_SNAPSHOT_KEY } from "../src/snapshot";

const ROOT = "https://gqqzogtrywuvomzmapgf.supabase.co";
const SECRET = "sb_secret_test_nonproduction";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Supabase catalog adapter", () => {
  it("reads books with UUID-linked authors and classifications in stable order", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      calls.push({ url: url.toString(), headers });
      return jsonResponse([{
        id: "book-1", slug: "sample", title: "Sample", status: "Published",
        date_added: "2026-11-09", r2_key: "pdfs/sample.pdf", content_hash: "etag-1",
        book_authors: [
          { author_id: "author-b", sort_order: 1 },
          { author_id: "author-a", sort_order: 0 },
        ],
        book_classifications: [{ classification_id: "class-a", sort_order: 0 }],
      }]);
    }));

    const client = new CatalogClient(SECRET, ROOT);
    const books = await client.list<{
      Title?: string; Status?: string; Authors?: string[]; Classification?: string[];
    }>("Books");
    expect(books).toHaveLength(1);
    expect(books[0].fields).toMatchObject({
      Title: "Sample",
      Status: "Published",
      Authors: ["author-a", "author-b"],
      Classification: ["class-a"],
    });
    expect(calls[0].url).toContain("book_authors");
    expect(calls[0].headers.get("apikey")).toBe(SECRET);
    expect(calls[0].headers.has("Authorization")).toBe(false);
  });

  it("creates a draft and its link tables without replacing reviewed book metadata", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path: url.pathname, method: init.method ?? "GET", body });
      if (url.pathname.endsWith("/books") && init.method === "POST") {
        return jsonResponse([{ id: "book-new", slug: "new", title: "New",
          status: "Draft", created_at: "2026-11-09T10:00:00Z" }]);
      }
      if (url.pathname.endsWith("/books") && init.method === "PATCH") {
        return jsonResponse([{ id: "book-new", status: "Published",
          title: "Reviewed", slug: "new", content_hash: "new-hash" }]);
      }
      // Supabase/PostgREST commonly returns 201 with an empty body for
      // relationship inserts when Prefer: return=minimal is used.
      return new Response(null, { status: 201 });
    }));

    const client = new CatalogClient(SECRET, ROOT);
    await client.create("Books", {
      Title: "New", Slug: "new", Status: "Draft", Authors: ["author-a"],
      Classification: ["class-a"], "R2 Key": "pdfs/new.pdf",
    });
    expect(requests).toHaveLength(3);
    expect(requests[0].body).toMatchObject({
      title: "New", status: "Draft", slug: "new", r2_key: "pdfs/new.pdf",
    });
    expect(requests[1].body).toEqual([{ book_id: "book-new", author_id: "author-a", sort_order: 0 }]);
    expect(requests[2].body).toEqual([{ book_id: "book-new", classification_id: "class-a", sort_order: 0 }]);

    await client.update("Books", "book-new", {
      "Content Hash": "new-hash", "Ingest Status": "Ready",
    });
    const updated = requests.find((req) => req.method === "PATCH");
    expect(updated?.body).toEqual({ content_hash: "new-hash", ingest_status: "Ready" });
  });

  it("rejects publishable keys and arbitrary project URLs", () => {
    expect(() => new CatalogClient("sb_publishable_test", ROOT)).toThrow(/server-only/);
    expect(() => new CatalogClient(SECRET, "https://example.com")).toThrow(/project URL/);
  });
});

describe("Supabase to R2 snapshot", () => {
  it("publishes only reviewed books but retains overall Census statistics", async () => {
    const rows: Record<string, unknown[]> = {
      books: [
        { id: "b1", title: "Published title", slug: "published-title",
          status: "Published", date_added: "2026-09-01",
          authors: [], subjects: ["Prayer"], language: "English",
          r2_key: "pdfs/published-title.pdf",
          cover_url: "https://assets.sacrumflorilegium.com/covers/published-title.webp",
          cover_page: 1,
          book_authors: [{ author_id: "a1", sort_order: 0 }],
          book_classifications: [{ classification_id: "c1", sort_order: 0 }],
        },
        { id: "b2", title: "Unreviewed", slug: "unreviewed", status: "Draft",
          date_added: "2026-09-02", subjects: [], language: "",
          book_authors: [], book_classifications: [] },
      ],
      authors: [{ id: "a1", name: "The Author" }],
      classifications: [{ id: "c1", class: "Preces" }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const table = url.pathname.split("/").at(-1) ?? "";
      return jsonResponse(rows[table] ?? []);
    }));
    const stored: Array<{ key: string; value: string }> = [];
    const bucket = {
      put: async (key: string, value: string) => {
        stored.push({ key, value });
        return {} as R2Object;
      },
    } as unknown as R2Bucket;

    const snapshot = await buildAndSaveSnapshot(bucket, SECRET, {
      projectUrl: ROOT,
      booksTable: "Books", authorsTable: "Authors", classificationsTable: "Classifications",
    });

    expect(snapshot.publishedBooks).toHaveLength(1);
    expect(snapshot.publishedBooks[0]).toMatchObject({
      title: "Published title", author: "The Author", classification: "Preces",
    });
    expect(snapshot.census.totalBooks).toBe(2);
    expect(snapshot.census.publishedBooks).toBe(1);
    expect(snapshot.census.draftBooks).toBe(1);
    expect(stored).toHaveLength(1);
    expect(stored[0].key).toBe(CATALOG_SNAPSHOT_KEY);
    expect(JSON.parse(stored[0].value).publishedBooks.map((book: { title: string }) => book.title)).toEqual(["Published title"]);
  });
});
