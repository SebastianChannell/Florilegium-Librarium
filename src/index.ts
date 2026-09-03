import { BOOKS_BY_SLUG } from "./catalog";
import { AirtableClient } from "./airtable";
import { ingestLibrary } from "./ingest";

const API_PATH = "/api/books";
const COVER_MANIFEST_PATH = "/api/cover-manifest";
const API_CACHE_SECONDS = 300;
const API_CACHE_VERSION = "4";
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

    if (url.pathname === COVER_MANIFEST_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      if (!env.AIRTABLE_TOKEN) {
        return Response.json({ error: "Airtable is not configured." }, { status: 503 });
      }

      try {
        const airtable = new AirtableClient(env.AIRTABLE_TOKEN, env.AIRTABLE_BASE_ID);
        const records = await airtable.list<BookRecordFields>(env.AIRTABLE_BOOKS_TABLE, {
          fields: ["Title", "Slug", "R2 Key", "Cover Page", "Cover URL"],
        });
        const covers = records.flatMap((record) => {
          const slug = record.fields.Slug?.trim();
          const pdfKey = record.fields["R2 Key"]?.trim();
          const page = record.fields["Cover Page"];
          const coverUrl = record.fields["Cover URL"]?.trim();
          if (!slug || !pdfKey || !coverUrl || !page || page < 1) return [];
          return [{
            title: record.fields.Title?.trim() ?? slug,
            slug,
            pdfUrl: buildPublicUrl(env.R2_PUBLIC_BASE_URL, pdfKey),
            coverUrl,
            page: Math.floor(page),
          }];
        });
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

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.AIRTABLE_TOKEN) {
      console.error("Librarium ingest skipped: AIRTABLE_TOKEN is not configured.");
      return;
    }

    ctx.waitUntil(
      ingestLibrary(env.LIBRARY_BUCKET, env.AIRTABLE_TOKEN, {
        prefix: env.R2_PREFIX,
        publicBaseUrl: env.R2_PUBLIC_BASE_URL,
        baseId: env.AIRTABLE_BASE_ID,
        booksTable: env.AIRTABLE_BOOKS_TABLE,
        authorsTable: env.AIRTABLE_AUTHORS_TABLE,
        classificationsTable: env.AIRTABLE_CLASSIFICATIONS_TABLE,
      }).then((summary) => {
        console.log(JSON.stringify({ message: "Librarium ingest completed", ...summary }));
      }),
    );
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

      const assetUrl = buildPublicUrl(config.publicBaseUrl, object.key);
      const slug = slugFromObjectKey(object.key);
      const metadata = catalogue.get(slug);

      // R2 is the file store, but Airtable controls publication. Uncatalogued
      // objects remain invisible until their reviewed record is Published.
      if (!metadata && catalogue !== FALLBACK_CATALOGUE) {
        continue;
      }
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

const FALLBACK_CATALOGUE = fallbackCatalogue();

async function loadCatalogue(env: Env): Promise<Map<string, CatalogMetadata>> {
  if (!env.AIRTABLE_TOKEN) return FALLBACK_CATALOGUE;

  try {
    const airtable = new AirtableClient(env.AIRTABLE_TOKEN, env.AIRTABLE_BASE_ID);
    const [books, authors, classifications] = await Promise.all([
      airtable.list<BookRecordFields>(env.AIRTABLE_BOOKS_TABLE, {
        fields: ["Title", "Authors", "Classification", "Subjects", "Language", "Pages", "Date Added", "Slug", "Cover URL", "Status"],
        filterByFormula: "{Status}='Published'",
      }),
      airtable.list<AuthorRecordFields>(env.AIRTABLE_AUTHORS_TABLE, { fields: ["Name"] }),
      airtable.list<ClassificationRecordFields>(env.AIRTABLE_CLASSIFICATIONS_TABLE, { fields: ["Class"] }),
    ]);

    const authorNames = new Map(authors.map((record) => [record.id, record.fields.Name ?? ""]));
    const classNames = new Map(classifications.map((record) => [record.id, record.fields.Class ?? "Bibliotheca"]));
    const catalogue = new Map<string, CatalogMetadata>();

    for (const record of books) {
      const slug = record.fields.Slug?.trim();
      const title = record.fields.Title?.trim();
      if (!slug || !title) continue;

      const author = (record.fields.Authors ?? []).map((id) => authorNames.get(id)).filter(Boolean).join("; ");
      const classification = (record.fields.Classification ?? []).map((id) => classNames.get(id)).find(Boolean) ?? "Bibliotheca";
      catalogue.set(slug, {
        slug,
        title,
        author,
        classification,
        dateAdded: record.fields["Date Added"] ?? record.createdTime.slice(0, 10),
        subjects: record.fields.Subjects ?? [],
        language: record.fields.Language ?? "",
        pages: record.fields.Pages,
        coverUrl: record.fields["Cover URL"] ?? "",
      });
    }

    return catalogue;
  } catch (error: unknown) {
    console.error(JSON.stringify({
      message: "Airtable catalogue unavailable; serving the checked-in fallback",
      error: errorMessage(error),
    }));
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
