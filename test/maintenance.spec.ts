import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "../src/index";

const MANUAL_KEY = "manual-refresh-key-for-vitest-only-12345678901234567890";
const DB_KEY = "sb_secret_test_only_not_real";

afterEach(() => vi.unstubAllGlobals());

function envFixture(withSecret = true) {
  const snapshotStore = new Map<string, string>();
  let objectGetCount = 0;
  const bucket = {
    async head(key: string) {
      return snapshotStore.has(key) ? { uploaded: new Date() } : null;
    },
    async put(key: string, value: string) {
      snapshotStore.set(key, value);
      return {} as R2Object;
    },
    async get(key: string) {
      objectGetCount++;
      const value = snapshotStore.get(key);
      return value ? { json: async () => JSON.parse(value) } : null;
    },
    async list() {
      return {
        objects: [{
          key: "pdfs/test-book.pdf",
          size: 100,
          etag: "etag",
          uploaded: new Date("2026-11-01T00:00:00Z"),
        }],
        truncated: false,
        delimitedPrefixes: [],
      };
    },
  };
  const env = {
    SUPABASE_SECRET_KEY: withSecret ? DB_KEY : undefined,
    SUPABASE_URL: "https://gqqzogtrywuvomzmapgf.supabase.co",
    MANUAL_REFRESH_KEY: MANUAL_KEY,
    R2_PREFIX: "pdfs/",
    R2_PUBLIC_BASE_URL: "https://assets.sacrumflorilegium.com/",
    PDFJS_BASE_URL: "https://reader.sacrumflorilegium.com/web/viewer.html",
    LIBRARY_BUCKET: bucket as unknown as R2Bucket,
  } as Env;
  return { env, snapshotStore, getCount: () => objectGetCount };
}

function restStub() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    expect(init?.method).toBe("GET");
    let rows: unknown[];
    if (url.pathname.endsWith("/books")) {
      rows = [{
        id: "book-one", title: "Test Book", slug: "test-book",
        status: "Published", date_added: "2026-11-01",
        r2_key: "pdfs/test-book.pdf", content_hash: "etag", pages: 3, subjects: [],
        book_authors: [{ author_id: "a1", sort_order: 0 }],
        book_classifications: [{ classification_id: "c1", sort_order: 0 }],
      }];
    } else if (url.pathname.endsWith("/authors")) {
      rows = [{ id: "a1", name: "Fr. Example" }];
    } else if (url.pathname.endsWith("/classifications")) {
      rows = [{ id: "c1", class: "Preces" }];
    } else throw new Error("Unexpected REST path: " + url.pathname);
    return Response.json(rows);
  }));
  return calls;
}

describe("Authenticated catalog maintenance", () => {
  it("does not allow unauthenticated requests to reseed", async () => {
    const { env } = envFixture();
    const resp = await handler.fetch(new Request("https://example.test/api/reseed", {
      method: "POST",
    }), env, { waitUntil() {} } as unknown as ExecutionContext);
    expect(resp.status).toBe(401);
    const body = await resp.json<{ code: string }>();
    expect(body.code).toBe("MANUAL_KEY_INVALID");
  });

  it("shows missing Supabase Worker credentials without exposing them", async () => {
    const { env } = envFixture(false);
    const resp = await handler.fetch(new Request("https://example.test/api/reseed", {
      method: "POST",
      headers: { Authorization: "Bearer " + MANUAL_KEY },
    }), env, { waitUntil() {} } as unknown as ExecutionContext);
    expect(resp.status).toBe(503);
    const body = await resp.json<{ code: string; error: string }>();
    expect(body.code).toBe("SUPABASE_SECRET_MISSING");
    expect(body.error).not.toContain(DB_KEY);
  });

  it("allows a real PDF import immediately after Rebuild index", async () => {
    const { env } = envFixture();
    restStub();
    const auth = { Authorization: "Bearer " + MANUAL_KEY };
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;
    const reseed = await handler.fetch(new Request("https://example.test/api/reseed", {
      method: "POST", headers: auth,
    }), env, ctx);
    expect(reseed.status).toBe(200);

    // A successful reseed writes a cooldown timestamp, but it must not
    // suppress the next R2 import by returning HTTP 429.
    const refresh = await handler.fetch(new Request("https://example.test/api/refresh", {
      method: "POST", headers: auth,
    }), env, ctx);
    expect(refresh.status).toBe(202);
    const body = await refresh.json<{
      queued: boolean;
      job: { id: string; status: string; active: boolean; created: number };
    }>();
    expect(body.queued).toBe(true);
    expect(body.job).toMatchObject({
      status: "queued", active: true, created: 0,
    });
    const progress = await handler.fetch(new Request("https://example.test/api/import-status", {
      method: "GET", headers: auth,
    }), env, ctx);
    expect(progress.status).toBe(200);
    const progressBody = await progress.json<{ job: { id: string } }>();
    expect(progressBody.job.id).toBe(body.job.id);
  });

  it("rebuilds published catalog from Supabase without PDF ingestion", async () => {
    const { env, snapshotStore } = envFixture();
    const calls = restStub();
    const resp = await handler.fetch(new Request("https://example.test/api/reseed", {
      method: "POST",
      headers: { Authorization: "Bearer " + MANUAL_KEY },
    }), env, { waitUntil() {} } as unknown as ExecutionContext);
    expect(resp.status).toBe(200);
    const body = await resp.json<{
      reseedOnly: boolean;
      imported: { scanned: number; created: number; updated: number };
      snapshot: { totalBooks: number; publishedBooks: number };
    }>();
    expect(body.reseedOnly).toBe(true);
    expect(body.imported).toMatchObject({ scanned: 0, created: 0, updated: 0 });
    expect(body.snapshot).toMatchObject({ totalBooks: 1, publishedBooks: 1 });
    expect(calls.sort()).toEqual([
      "/rest/v1/authors", "/rest/v1/books", "/rest/v1/classifications",
    ]);
    expect(snapshotStore.has("system/librarium/catalog-snapshot-v1.json")).toBe(true);
  });
});
