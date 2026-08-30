import { beforeAll, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";

describe("Librarium Worker", () => {
  beforeAll(async () => {
    const existing = await env.LIBRARY_BUCKET.list();
    if (existing.objects.length > 0) {
      await env.LIBRARY_BUCKET.delete(existing.objects.map((object) => object.key));
    }

    await Promise.all([
      env.LIBRARY_BUCKET.put(
        "pdfs/fr-lasance/my-prayer-book.pdf",
        "test-pdf",
        { httpMetadata: { contentType: "application/pdf" } },
      ),
      env.LIBRARY_BUCKET.put(
        "pdfs/liturgia/benedictines-of-solesmes/liber-usualis-1961.pdf",
        "test-pdf",
        { httpMetadata: { contentType: "application/pdf" } },
      ),
      env.LIBRARY_BUCKET.put(
        "pdfs/auctores/sophocles/the-theban-plays.pdf",
        "test-pdf",
        { httpMetadata: { contentType: "application/pdf" } },
      ),
      env.LIBRARY_BUCKET.put("pdfs/ignore-me.txt", "not-a-pdf"),
    ]);
  });

  it("lists R2 PDFs and builds links to the PDF.js viewer entry point", async () => {
    const response = await exports.default.fetch(
      "https://librarium.example/api/books",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const payload = await response.json<{
      count: number;
      books: Array<{
        key: string;
        title: string;
        collection: string;
        assetUrl: string;
        readerUrl: string;
      }>;
    }>();

    expect(payload.count).toBe(3);
    expect(payload.books.map((book) => book.title)).toEqual([
      "Liber Usualis 1961",
      "My Prayer Book",
      "The Theban Plays",
    ]);

    const prayerBook = payload.books.find(
      (book) => book.key === "pdfs/fr-lasance/my-prayer-book.pdf",
    );
    expect(prayerBook).toMatchObject({
      category: "Bibliotheca",
      collection: "Fr. Lasance",
      assetUrl:
        "https://assets.sacrumflorilegium.com/pdfs/fr-lasance/my-prayer-book.pdf",
      readerUrl:
        "https://reader.sacrumflorilegium.com/web/viewer.html?file=https%3A%2F%2Fassets.sacrumflorilegium.com%2Fpdfs%2Ffr-lasance%2Fmy-prayer-book.pdf",
    });

    const sophocles = payload.books.find(
      (book) => book.key === "pdfs/auctores/sophocles/the-theban-plays.pdf",
    );
    expect(sophocles).toMatchObject({
      category: "Auctores",
      collection: "Sophocles",
    });

    const liberUsualis = payload.books.find(
      (book) =>
        book.key ===
        "pdfs/liturgia/benedictines-of-solesmes/liber-usualis-1961.pdf",
    );
    expect(liberUsualis).toMatchObject({
      category: "Liturgia",
      collection: "Benedictines of Solesmes",
    });
  });

  it("supports HEAD and rejects unsupported methods", async () => {
    const head = await exports.default.fetch("https://librarium.example/api/books", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const post = await exports.default.fetch("https://librarium.example/api/books", {
      method: "POST",
    });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});
