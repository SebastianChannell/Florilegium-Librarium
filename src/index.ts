const API_PATH = "/api/books";
const API_CACHE_SECONDS = 300;
const PDF_EXTENSION = /\.pdf$/i;

const CATEGORY_NAMES = new Map([
  ["auctores", "Auctores"],
  ["authors", "Auctores"],
  ["classics", "Auctores"],
  ["liturgia", "Liturgia"],
  ["liturgical", "Liturgia"],
  ["liturgy", "Liturgia"],
  ["spiritual", "Spiritualia"],
  ["spiritualia", "Spiritualia"],
  ["spirituality", "Spiritualia"],
  ["theologia", "Theologia"],
  ["theological", "Theologia"],
  ["theology", "Theologia"],
]);

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
  title: string;
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

    const cacheKey = new Request(new URL(API_PATH, request.url), {
      method: "GET",
    });

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
      books.push({
        key: object.key,
        title: titleFromObjectKey(object.key),
        category: categoryFromObjectKey(object.key, config.prefix),
        collection: collectionFromObjectKey(object.key, config.prefix),
        assetUrl,
        readerUrl: buildPdfjsUrl(config.pdfjsBaseUrl, assetUrl),
        uploaded: object.uploaded.toISOString(),
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

export function collectionFromObjectKey(key: string, prefix: string): string {
  const relativeKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const segments = relativeKey.split("/").filter(Boolean);

  if (segments.length < 2) {
    return "Library";
  }

  return humanizeSlug(segments.at(-2) ?? "") || "Library";
}

export function categoryFromObjectKey(key: string, prefix: string): string {
  const relativeKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const firstSegment = relativeKey.split("/").filter(Boolean).at(0);

  if (!firstSegment) {
    return "Bibliotheca";
  }

  return CATEGORY_NAMES.get(normalizeSlug(firstSegment)) ?? "Bibliotheca";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
