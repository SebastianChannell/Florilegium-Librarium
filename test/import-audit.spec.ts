import { afterEach, describe, expect, it, vi } from "vitest";
import { auditR2Catalog } from "../src/import-audit";

const API_URL = "https://gqqzogtrywuvomzmapgf.supabase.co";
const KEY = "sb_secret_test_only";
afterEach(() => vi.unstubAllGlobals());

describe("R2 and Supabase catalog reconciliation", () => {
  it("finds exact missing R2 keys, highlights normalized slug collisions, and ignores unchanged books", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, options?: RequestInit) => {
      const request = new URL(String(input));
      expect(new Headers(options?.headers).get("apikey")).toBe(KEY);
      seen.push(request.pathname);
      if (!request.pathname.endsWith("/books")) throw Error("Unexpected Supabase table");
      return Response.json([
        { id: "id-1", slug: "first-book", r2_key: "pdfs/first-book.pdf" },
        { id: "id-2", slug: "a-book", r2_key: "pdfs/a-book.pdf" },
        { id: "id-3", slug: "deleted-book", r2_key: "pdfs/deleted-book.pdf" },
      ]);
    }));
    const objects = [
      { key: "pdfs/first-book.pdf" },
      { key: "pdfs/a-book.pdf" },
      { key: "pdfs/a_book.pdf" },
      { key: "pdfs/unlisted-volume.pdf" },
      { key: "pdfs/cover.jpg" },
    ];
    const bucket = {
      list: async () => ({ objects, truncated: false }),
    } as unknown as R2Bucket;

    const report = await auditR2Catalog(bucket, KEY, API_URL, "pdfs/");
    expect(report).toMatchObject({
      r2PdfCount: 4,
      supabaseBookCount: 3,
      matchingKeys: 2,
      missingFromSupabase: [
        { key: "pdfs/a_book.pdf", normalizedSlug: "a-book", collidesWithSlug: "a-book" },
        { key: "pdfs/unlisted-volume.pdf", normalizedSlug: "unlisted-volume" },
      ],
      missingFromR2: [
        { key: "pdfs/deleted-book.pdf", slug: "deleted-book" },
      ],
    });
    expect(seen).toEqual(["/rest/v1/books"]);
  });

  it("does not reveal unpublished PDF filenames without a successful private API key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "Rejected" }, { status: 401 }),
    ));
    const bucket = { list: async () => ({ objects: [{ key: "pdfs/private-draft.pdf" }], truncated: false }) } as unknown as R2Bucket;
    await expect(auditR2Catalog(bucket, KEY, API_URL, "pdfs/")).rejects.toThrow(/Supabase books HTTP 401/);
  });
});
