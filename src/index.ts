import { BOOKS_BY_SLUG } from "./catalog";
import { buildAndSaveSnapshot, readSnapshot } from "./snapshot";
import { getImportJob, processImportBatch, startImportJob } from "./import-queue";

const API_PATH = "/api/books";
const COVER_MANIFEST_PATH = "/api/cover-manifest";
const MANUAL_REFRESH_PATH = "/api/refresh";
const IMPORT_STATUS_PATH = "/api/import-status";
const MANUAL_RESEED_PATH = "/api/reseed";
// SHA-256 of an independently generated 256-bit manual refresh key. The key itself is never shipped in the repository or browser assets.
const MANUAL_REFRESH_KEY_HASH = "66deace57b2e4e43ab11d58cf7f29660d0dd97216ed19e69f04d28aa51e9294d";
const MANUAL_RESEED_LAST_KEY = "system/librarium/last-manual-reseed";
const MANUAL_REFRESH_COOLDOWN_MS = 60_000;
const API_CACHE_SECONDS = 300;
const API_CACHE_VERSION = "11";
const PDF_EXTENSION = /\.pdf$/i;

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

const SPECIAL_WORDS = new Map([
  ["bvm", "B.V.M."],
  ["cssr", "C.Ss.R."],
  ["fr", "Fr."],
  ["osb", "O.S.B."],
  ["sj", "S.J."],
  ["st", "St."],
]);

export interface LibraryBook {
  key: string;
  slug: string;
  title: string;
  author: string;
  category: string;
  collection: string;
  assetUrl: string;
  readerUrl: string;
  uploaded: string;
  size: number;
  subjects: string[];
  language: string;
  pages?: number;
  coverUrl: string;
}

interface LibraryConfig {
  prefix: string;
  publicBaseUrl: string;
  pdfjsBaseUrl: string;
}

interface LibraryPayload {
  books: LibraryBook[];
  count: number;
  generatedAt: string;
}

interface CatalogMetadata {
  slug: string;
  title: string;
  author: string;
  classification: string;
  dateAdded: string;
  subjects: string[];
  language: string;
  pages?: number;
  coverUrl: string;
}

interface BookRecordFields {
  Title?: string;
  Authors?: string[];
  Classification?: string[];
  Subjects?: string[];
  Language?: string;
  Pages?: number;
  "Date Added"?: string;
  Slug?: string;
  "Cover URL"?: string;
  "Cover Page"?: number;
  "R2 Key"?: string;
  Status?: string;
}

interface AuthorRecordFields { Name?: string }
interface ClassificationRecordFields { Class?: string }

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === IMPORT_STATUS_PATH) {
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed." }, {
          status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" },
        });
      }
      if (!(await hasManualRefreshAccess(request, env))) {
        return Response.json({ error: "Invalid manual import key.", code: "MANUAL_KEY_INVALID" }, {
          status: 401, headers: { "Cache-Control": "no-store" },
        });
      }
      try {
        return Response.json({ job: await getImportJob(env.LIBRARY_BUCKET) }, {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        console.error("Could not read Librarium import progress:", errorMessage(error));
        return Response.json({ error: "Could not retrieve import progress." }, {
          status: 503, headers: { "Cache-Control": "no-store" },
        });
      }
    }

    if (url.pathname === MANUAL_REFRESH_PATH || url.pathname === MANUAL_RESEED_PATH) {
      const reseedOnly = url.pathname === MANUAL_RESEED_PATH;
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed." }, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
      }
      if (!(await hasManualRefreshAccess(request, env))) {
        return Response.json({
          error: "Incorrect manual import key. This is separate from the Supabase secret key.",
          code: "MANUAL_KEY_INVALID",
        }, { status: 401, headers: { "Cache-Control": "no-store" } });
      }
      if (!env.SUPABASE_SECRET_KEY) {
        return Response.json({
          error: "The Cloudflare Worker is missing the SUPABASE_SECRET_KEY binding.",
          code: "SUPABASE_SECRET_MISSING",
        }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
      if (!reseedOnly) {
        try {
          const job = await startImportJob(env.LIBRARY_BUCKET, "manual");
          return Response.json({ queued: true, job }, {
            status: 202, headers: { "Cache-Control": "no-store" },
          });
        } catch (error) {
          console.error("Could not start Librarium import:", errorMessage(error));
          return Response.json({ error: "Could not start the import queue.", code: "QUEUE_START_FAILED" }, {
            status: 503, headers: { "Cache-Control": "no-store" },
          });
        }
      }
      try {
        const last = await env.LIBRARY_BUCKET.head(MANUAL_RESEED_LAST_KEY);
        if (last && Date.now() - last.uploaded.getTime() < MANUAL_REFRESH_COOLDOWN_MS) {
          const retryAfter = Math.ceil((MANUAL_REFRESH_COOLDOWN_MS - (Date.now() - last.uploaded.getTime())) / 1000);
          return Response.json({ error: "A manual import just completed. Try again in a minute." }, {
            status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.max(1, retryAfter)) },
          });
        }
        // Snapshot-only rebuild never scans or modifies PDFs.
        const imported = {
          scanned: 0, created: 0, updated: 0, unchanged: 0, failed: 0, deferred: 0,
        };
        const snapshot = await buildAndSaveSnapshot(env.LIBRARY_BUCKET, env.SUPABASE_SECRET_KEY, {
          projectUrl: env.SUPABASE_URL,
          booksTable: "Books",
          authorsTable: "Authors",
          classificationsTable: "Classifications",
        });
        const catalogue = await loadCatalogue(env, true);
        const books = await listBooks(env.LIBRARY_BUCKET, {
          prefix: env.R2_PREFIX,
          publicBaseUrl: env.R2_PUBLIC_BASE_URL,
          pdfjsBaseUrl: env.PDFJS_BASE_URL,
        }, catalogue);
        const payload: LibraryPayload = { books, count: books.length, generatedAt: new Date().toISOString() };
        const cacheUrl = new URL(API_PATH, request.url);
        cacheUrl.searchParams.set("catalog", API_CACHE_VERSION);
        const cacheResponse = Response.json(payload, {
          headers: { "Cache-Control": `public, max-age=60, s-maxage=${API_CACHE_SECONDS}, stale-while-revalidate=86400` },
        });
        try {
          await caches.default.put(new Request(cacheUrl), cacheResponse);
        } catch (cacheError) {
          // The R2 snapshot is already saved. A cache-write failure should not
          // turn a successful database synchronization into an error response.
          console.warn("Librarium cache update failed; new snapshot remains saved.", errorMessage(cacheError));
        }
        await env.LIBRARY_BUCKET.put(MANUAL_RESEED_LAST_KEY, payload.generatedAt, { httpMetadata: { contentType: "text/plain" } });
        return Response.json({
          ...payload, imported, reseedOnly,
          snapshot: {
            generatedAt: snapshot.generatedAt,
            totalBooks: snapshot.census.totalBooks,
            publishedBooks: snapshot.census.publishedBooks,
          },
        }, { headers: { "Cache-Control": "no-store" } });
      } catch (error: unknown) {
        console.error(JSON.stringify({ message: "Manual Librarium import failed", error: errorMessage(error) }));
        return Response.json(publicRefreshFailure(error), {
          status: 503, headers: { "Cache-Control": "no-store" },
        });
      }
    }

    if (url.pathname === COVER_MANIFEST_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      try {
        const snapshot = await readSnapshot(env.LIBRARY_BUCKET);
        if (!snapshot) {
          return Response.json({ error: "Catalogue snapshot not yet initialized." }, {
            status: 503, headers: { "Cache-Control": "no-store" },
          });
        }
        const covers = snapshot.covers.map((cover) => ({
          title: cover.title,
          slug: cover.slug,
          pdfUrl: buildPublicUrl(env.R2_PUBLIC_BASE_URL, cover.pdfKey),
          coverUrl: cover.coverUrl,
          page: cover.page,
        }));
        const response = Response.json({ covers, count: covers.length }, {
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
        return request.method === "HEAD"
          ? new Response(null, { status: response.status, headers: response.headers })
          : response;
      } catch (error: unknown) {
        console.error(JSON.stringify({ message: "Cover manifest failed", error: errorMessage(error) }));
        return Response.json({ error: "Cover manifest is temporarily unavailable." }, { status: 503 });
      }
    }

    if (url.pathname !== API_PATH) {
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json(
        { error: "Method not allowed" },
        {
          status: 405,
          headers: {
            Allow: "GET, HEAD",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const cacheUrl = new URL(API_PATH, request.url);
    cacheUrl.searchParams.set("catalog", API_CACHE_VERSION);
    const cacheKey = new Request(cacheUrl, { method: "GET" });

    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        return responseForRequest(request, cached, "HIT");
      }

      const catalogue = await loadCatalogue(env);
      const books = await listBooks(env.LIBRARY_BUCKET, {
        prefix: env.R2_PREFIX,
        publicBaseUrl: env.R2_PUBLIC_BASE_URL,
        pdfjsBaseUrl: env.PDFJS_BASE_URL,
      }, catalogue);

      const payload: LibraryPayload = {
        books,
        count: books.length,
        generatedAt: new Date().toISOString(),
      };

      const response = Response.json(payload, {
        headers: {
          "Cache-Control": `public, max-age=60, s-maxage=${API_CACHE_SECONDS}, stale-while-revalidate=86400`,
          "X-Content-Type-Options": "nosniff",
        },
      });

      ctx.waitUntil(
        caches.default.put(cacheKey, response.clone()).catch((error: unknown) => {
          console.error(
            JSON.stringify({
              message: "Librarium API cache write failed",
              error: errorMessage(error),
            }),
          );
        }),
      );

      return responseForRequest(request, response, "MISS");
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          message: "Librarium could not list R2 books",
          error: errorMessage(error),
          path: url.pathname,
        }),
      );

      return Response.json(
        { error: "The library is temporarily unavailable." },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": "60",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      try {
        // Daily discovery starts a durable import job. The every-minute trigger
        // resumes queued work until finished, even after the browser closes.
        if (controller.cron === "0 6 * * *") {
          if (!env.SUPABASE_SECRET_KEY) {
            console.error("Daily R2 import skipped: SUPABASE_SECRET_KEY is missing.");
            return;
          }
          await startImportJob(env.LIBRARY_BUCKET, "daily");
        }
        await processImportBatch(env);
      } catch (error) {
        console.error(JSON.stringify({
          message: "Librarium scheduled import failed",
          error: errorMessage(error),
        }));
        throw error;
      }
    })());
  },
} satisfies ExportedHandler<Env>;

export async function listBooks(
  bucket: R2Bucket,
  config: LibraryConfig,
  catalogue: Map<string, CatalogMetadata> = FALLBACK_CATALOGUE,
): Promise<LibraryBook[]> {
  const books: LibraryBook[] = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list({
      prefix: config.prefix,
      cursor,
      limit: 1000,
    });

    for (const object of page.objects) {
      if (!PDF_EXTENSION.test(object.key)) {
        continue;
      }

      const assetUrl = buildVersionedPublicUrl(config.publicBaseUrl, object.key, object);
      const slug = slugFromObjectKey(object.key);
      const metadata = catalogue.get(slug);

      // R2 is the file store, but Supabase controls publication. Uncatalogued
      // objects remain invisible until their reviewed record is Published.
      if (!metadata) {
        continue;
      }
      books.push({
        key: object.key,
        slug,
        title: metadata?.title ?? titleFromObjectKey(object.key),
        author: metadata?.author ?? "",
        category: resolveClassification(
          slug,
          metadata?.classification,
          metadata?.title ?? titleFromObjectKey(object.key),
          metadata?.author,
          metadata?.subjects,
        ),
        collection: metadata?.author || collectionFromObjectKey(object.key, config.prefix),
        assetUrl,
        readerUrl: buildPdfjsUrl(config.pdfjsBaseUrl, assetUrl),
        uploaded: metadata
          ? `${metadata.dateAdded}T00:00:00.000Z`
          : object.uploaded.toISOString(),
        size: object.size,
        subjects: metadata?.subjects ?? [],
        language: metadata?.language ?? "",
        pages: metadata?.pages,
        coverUrl: metadata?.coverUrl ?? "",
      });
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return books.sort((left, right) =>
    left.title.localeCompare(right.title, "en", { sensitivity: "base" }),
  );
}

// Only these are catalogue classifications. "Bibliotheca" was an old
// placeholder for a missing classification, not a real browsing category.
const CLASSIFICATION_NAMES = new Map([
  ["liturgia", "Liturgia"],
  ["theologia", "Theologia"],
  ["spiritualia", "Spiritualia"],
  ["preces", "Preces"],
  ["auctores", "Auctores"],
]);

export function resolveClassification(
  slug: string,
  classification?: string,
  title = "",
  author = "",
  subjects: string[] = [],
): string {
  const current = CLASSIFICATION_NAMES.get((classification ?? "").trim().toLocaleLowerCase("en-US"));
  if (current) return current;

  // Prefer reviewed metadata from the checked-in catalogue if Supabase's
  // classification is empty or the API is temporarily unavailable.
  const known = BOOKS_BY_SLUG.get(slug)?.classification;
  if (known) return known;

  // High-confidence title/subject hints help classify newly imported books.
  // Do not invent a classification for ambiguous works: they remain in Omnes
  // and search until their Supabase record has been classified.
  const value = [title, author, ...subjects].join(" ")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US");
  if (/\b(sophocles|xenophon|homer|virgil|vergil|theban plays|greek tragedies|classical literature|memorabilia|plato|aristophanes)\b/.test(value)) return "Auctores";
  if (/\b(missal|misal|breviary|breviario|antiphonary|antiphonarius|graduale|liber usualis|liturgy|liturgia|liturgical|little offices?|divine office)\b/.test(value)) return "Liturgia";
  if (/\b(catechism|catecismo|theology|theologia|theological|dogmatic|eucharistic texts|textos eucaristicos|summa theologica)\b/.test(value)) return "Theologia";
  if (/\b(prayer book|prayer-book|prayers|oraciones|oracionario|devocionario|manual of devotion|book of devotions|novena|litanies|litany|rosary)\b/.test(value)) return "Preces";
  if (/\b(devout|devotional|spiritual|meditations?|meditaciones|saints? lives|lives of the saints|martyrs?|scruples|examination of conscience|vida devota|life of christ)\b/.test(value)) return "Spiritualia";
  return "";
}

const FALLBACK_CATALOGUE = fallbackCatalogue();

async function loadCatalogue(env: Env, strict = false): Promise<Map<string, CatalogMetadata>> {
  try {
    const snapshot = await readSnapshot(env.LIBRARY_BUCKET);
    if (!snapshot) {
      if (strict) throw new Error("Librarium snapshot has not been initialized.");
      console.warn("Librarium snapshot is missing; serving the limited checked-in catalog.");
      return FALLBACK_CATALOGUE;
    }
    return new Map(snapshot.publishedBooks.map((book) => [book.slug, book]));
  } catch (error: unknown) {
    console.error(JSON.stringify({
      message: "R2 catalog snapshot unavailable; serving the limited checked-in fallback",
      error: errorMessage(error),
    }));
    if (strict) throw error;
    return FALLBACK_CATALOGUE;
  }
}

function fallbackCatalogue(): Map<string, CatalogMetadata> {
  return new Map(Array.from(BOOKS_BY_SLUG.entries(), ([slug, book]) => [slug, {
    ...book,
    subjects: [],
    language: "",
    coverUrl: "",
  }] as const));
}

export function buildPublicUrl(baseUrl: string, key: string): string {
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const normalizedBase = `${baseUrl.replace(/\/+$/, "")}/`;
  return new URL(encodedKey, normalizedBase).toString();
}

function buildVersionedPublicUrl(baseUrl: string, key: string, object: R2Object): string {
  const url = new URL(buildPublicUrl(baseUrl, key));
  const version = object.etag || `${object.size}-${object.uploaded.getTime()}`;
  url.searchParams.set("v", version);
  return url.toString();
}

export function buildPdfjsUrl(baseUrl: string, assetUrl: string): string {
  const viewerUrl = new URL(baseUrl);
  const fileUrl = new URL(assetUrl);

  // PDF.js must fetch a PDF from its own origin. Using the R2 public URL
  // directly can be blocked by browser CORS policy, especially on mobile.
  // The Reader Worker serves these exact R2 keys under /pdfs/ on its origin.
  if (fileUrl.origin === "https://assets.sacrumflorilegium.com" &&
      fileUrl.pathname.startsWith("/pdfs/")) {
    fileUrl.protocol = viewerUrl.protocol;
    fileUrl.host = viewerUrl.host;
  }

  // Separate the reader-friendly cached response from older JPX/JBIG2 copies.
  // The Worker keeps the archival R2 object intact and serves a verified
  // lower-memory derivative when one is available.
  if (fileUrl.pathname === "/pdfs/viva-el-rey.pdf") {
    fileUrl.searchParams.set("render", "low-memory-1");
  }

  viewerUrl.searchParams.set("file", fileUrl.toString());
  return viewerUrl.toString();
}

export function titleFromObjectKey(key: string): string {
  const filename = key.split("/").at(-1) ?? key;
  const withoutExtension = filename.replace(PDF_EXTENSION, "");
  return humanizeSlug(withoutExtension) || "Untitled Book";
}

export function slugFromObjectKey(key: string): string {
  const filename = key.split("/").at(-1) ?? key;
  return normalizeSlug(filename.replace(PDF_EXTENSION, ""));
}

export function collectionFromObjectKey(key: string, prefix: string): string {
  const relativeKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const segments = relativeKey.split("/").filter(Boolean);

  if (segments.length < 2) {
    return "Library";
  }

  return humanizeSlug(segments.at(-2) ?? "") || "Library";
}

function normalizeSlug(value: string): string {
  return safeDecodeURIComponent(value)
    .toLocaleLowerCase("en-US")
    .replace(/[_\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function humanizeSlug(value: string): string {
  const decoded = safeDecodeURIComponent(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!decoded) {
    return "";
  }

  const words = decoded.split(" ");
  return words
    .map((word, index) => formatWord(word, index, words.length))
    .join(" ");
}

function formatWord(word: string, index: number, totalWords: number): string {
  const lower = word.toLocaleLowerCase("en-US");
  const special = SPECIAL_WORDS.get(lower);
  if (special) {
    return special;
  }

  if (/^[ivxlcdm]+$/i.test(word) && word.length <= 8) {
    return word.toLocaleUpperCase("en-US");
  }

  if (/^[a-z]$/i.test(word) && totalWords > 1) {
    return word.toLocaleUpperCase("en-US");
  }

  if (SMALL_WORDS.has(lower) && index > 0 && index < totalWords - 1) {
    return lower;
  }

  return `${lower.charAt(0).toLocaleUpperCase("en-US")}${lower.slice(1)}`;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function responseForRequest(
  request: Request,
  response: Response,
  cacheStatus: "HIT" | "MISS",
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Librarium-Cache", cacheStatus);

  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function hasManualRefreshAccess(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const key = auth.slice("Bearer ".length);
  if (key.length < 32 || key.length > 128) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hash = new Uint8Array(digest);
  const expectedHex = env.MANUAL_REFRESH_KEY
    ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.MANUAL_REFRESH_KEY))),
        (byte) => byte.toString(16).padStart(2, "0")).join("")
    : MANUAL_REFRESH_KEY_HASH;
  const expectedBytes = new Uint8Array(expectedHex.match(/../g)!.map((byte) => parseInt(byte, 16)));
  let mismatch = 0;
  for (let i = 0; i < hash.length; i++) mismatch |= hash[i] ^ expectedBytes[i];
  return mismatch === 0;
}

function publicRefreshFailure(error: unknown): { error: string; code: string } {
  const message = errorMessage(error);
  if (/Supabase .+ HTTP 40[13]/.test(message)) return {
    code: "SUPABASE_AUTH_FAILED",
    error: "Supabase rejected the Worker API key. Verify SUPABASE_SECRET_KEY in Cloudflare.",
  };
  if (/Supabase .+ HTTP 404/.test(message)) return {
    code: "SUPABASE_SCHEMA_ERROR",
    error: "Supabase catalog tables are unavailable. Check the Worker project URL and database schema.",
  };
  if (/Supabase .+ HTTP/.test(message)) return {
    code: "SUPABASE_API_ERROR",
    error: "Supabase returned an error. Check the Librarium Worker logs for details.",
  };
  return {
    code: "IMPORT_OR_SNAPSHOT_ERROR",
    error: "The catalog operation could not finish. Check the Librarium Worker logs for details.",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
