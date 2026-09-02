import { BOOK_CATALOG, BOOKS_BY_SLUG, canonicalPdfKey } from "./catalog";

const API_PATH = "/api/books";
const API_CACHE_SECONDS = 300;
const API_CACHE_VERSION = "3";
const PDF_EXTENSION = /\.pdf$/i;
const MIGRATION_PATH = "/api/maintenance/flatten-pdfs";
const MIGRATION_TOKEN_HASH = "7bc09ab5a0cbb067b15df56db90658b5fed3ffaa6bb61c6c798b4b39e578c3a2";

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

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === MIGRATION_PATH) {
      return flattenPdfMigration(request, env.LIBRARY_BUCKET);
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

      const books = await listBooks(env.LIBRARY_BUCKET, {
        prefix: env.R2_PREFIX,
        publicBaseUrl: env.R2_PUBLIC_BASE_URL,
        pdfjsBaseUrl: env.PDFJS_BASE_URL,
      });

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
} satisfies ExportedHandler<Env>;

export async function listBooks(
  bucket: R2Bucket,
  config: LibraryConfig,
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

      const assetUrl = buildPublicUrl(config.publicBaseUrl, object.key);
      const slug = slugFromObjectKey(object.key);
      const metadata = BOOKS_BY_SLUG.get(slug);
      books.push({
        key: object.key,
        slug,
        title: metadata?.title ?? titleFromObjectKey(object.key),
        author: metadata?.author ?? "",
        category: metadata?.classification ?? "Bibliotheca",
        collection: metadata?.author ?? collectionFromObjectKey(object.key, config.prefix),
        assetUrl,
        readerUrl: buildPdfjsUrl(config.pdfjsBaseUrl, assetUrl),
        uploaded: metadata
          ? `${metadata.dateAdded}T00:00:00.000Z`
          : object.uploaded.toISOString(),
        size: object.size,
      });
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return books.sort((left, right) =>
    left.title.localeCompare(right.title, "en", { sensitivity: "base" }),
  );
}

export function buildPublicUrl(baseUrl: string, key: string): string {
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const normalizedBase = `${baseUrl.replace(/\/+$/, "")}/`;
  return new URL(encodedKey, normalizedBase).toString();
}

export function buildPdfjsUrl(baseUrl: string, assetUrl: string): string {
  const viewerUrl = new URL(baseUrl);
  viewerUrl.searchParams.set("file", assetUrl);
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

async function flattenPdfMigration(
  request: Request,
  bucket: R2Bucket,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || (await sha256Hex(token)) !== MIGRATION_TOKEN_HASH) {
    return new Response("Unauthorized", { status: 401 });
  }

  const results: Array<{
    slug: string;
    status: "moved" | "already-flat" | "failed";
    error?: string;
  }> = [];

  for (let index = 0; index < BOOK_CATALOG.length; index += 3) {
    const group = BOOK_CATALOG.slice(index, index + 3);
    const groupResults = await Promise.all(
      group.map(async (book) => {
        try {
          return await movePdf(bucket, book.slug, book.legacyKey);
        } catch (error: unknown) {
          return {
            slug: book.slug,
            status: "failed" as const,
            error: errorMessage(error),
          };
        }
      }),
    );
    results.push(...groupResults);
  }

  const failed = results.filter((result) => result.status === "failed");
  return Response.json(
    {
      ok: failed.length === 0,
      moved: results.filter((result) => result.status === "moved").length,
      alreadyFlat: results.filter((result) => result.status === "already-flat").length,
      failed,
    },
    {
      status: failed.length === 0 ? 200 : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function movePdf(
  bucket: R2Bucket,
  slug: string,
  legacyKey: string,
): Promise<{ slug: string; status: "moved" | "already-flat" }> {
  const targetKey = canonicalPdfKey(slug);
  const [source, target] = await Promise.all([
    bucket.head(legacyKey),
    bucket.head(targetKey),
  ]);

  if (!source) {
    if (target) {
      return { slug, status: "already-flat" };
    }
    throw new Error(`Missing source object: ${legacyKey}`);
  }

  if (target && target.size !== source.size) {
    throw new Error(`Target exists with a different size: ${targetKey}`);
  }

  if (!target) {
    const object = await bucket.get(legacyKey);
    if (!object) {
      throw new Error(`Could not read source object: ${legacyKey}`);
    }

    await bucket.put(targetKey, object.body, {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    });

    const copied = await bucket.head(targetKey);
    if (!copied || copied.size !== source.size) {
      throw new Error(`Copy verification failed: ${targetKey}`);
    }
  }

  await bucket.delete(legacyKey);
  return { slug, status: "moved" };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
