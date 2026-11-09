import { CatalogClient, type CatalogRecord } from "./catalog-db";

// The bucket may also have a public asset origin. Do not put entire draft records
// or database credentials into this snapshot.
export const CATALOG_SNAPSHOT_KEY = "system/librarium/catalog-snapshot-v1.json";

interface BookFields {
  Title?: string;
  Slug?: string;
  Status?: string;
  Authors?: string[];
  Classification?: string[];
  Subjects?: string[];
  Language?: string;
  Pages?: number;
  "Date Added"?: string;
  "Cover URL"?: string;
  "Cover Page"?: number;
  "R2 Key"?: string;
  "Searchable Text"?: boolean;
  OCR?: boolean;
  "Edition Year"?: number | string;
  Publisher?: string;
}

interface AuthorFields {
  Name?: string;
}

interface ClassificationFields {
  Class?: string;
}

export interface PublishedBook {
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

export interface CoverManifestEntry {
  title: string;
  slug: string;
  pdfKey: string;
  coverUrl: string;
  page: number;
}

export interface CatalogSnapshot {
  version: 1;
  generatedAt: string;
  publishedBooks: PublishedBook[];
  covers: CoverManifestEntry[];
  census: ReturnType<typeof calculateCensusStats>;
}

interface SnapshotConfig {
  projectUrl: string;
  booksTable: string;
  authorsTable: string;
  classificationsTable: string;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function countBy(groups: string[][]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const name of group) {
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function calculateCensusStats(
  booksRaw: Array<CatalogRecord<BookFields>>,
  authorsRaw: Array<CatalogRecord<AuthorFields>>,
  classesRaw: Array<CatalogRecord<ClassificationFields>>,
) {
  const authorMap = new Map(authorsRaw.map((r) => [r.id, asText(r.fields.Name) || r.id]));
  const classMap = new Map(classesRaw.map((r) => [r.id, asText(r.fields.Class) || r.id]));
  const books = booksRaw.map((r) => ({ id: r.id, ...r.fields }));
  const linked = (value: unknown, map: Map<string, string>) =>
    textList(value).map((id) => map.get(id) || id).filter(Boolean);
  const classifications = countBy(books.map((b) => linked(b.Classification, classMap)));
  const subjects = countBy(books.map((b) => textList(b.Subjects)));
  const languages = countBy(books.map((b) => [asText(b.Language)].filter(Boolean)));
  const authors = countBy(books.map((b) => linked(b.Authors, authorMap)));
  const complete = (name: string, test: (book: (typeof books)[number]) => boolean) => {
    const missing = books
      .filter((b) => !test(b))
      .map((b) => asText(b.Title) || "Untitled")
      .sort((a, b) => a.localeCompare(b));
    const n = books.length - missing.length;
    return {
      name,
      complete: n,
      percent: books.length ? Math.round((n / books.length) * 100) : 0,
      missing,
    };
  };
  const status = books.map((b) => asText(b.Status));
  return {
    totalBooks: books.length,
    publishedBooks: status.filter((x) => x === "Published").length,
    draftBooks: status.filter((x) => x === "Draft").length,
    totalAuthors: authors.length,
    totalSubjects: subjects.length,
    totalLanguages: languages.length,
    classifications,
    topSubjects: subjects.slice(0, 5),
    languages,
    topAuthors: authors.slice(0, 5),
    health: [
      complete("Searchable text", (b) => !!b["Searchable Text"]),
      complete("OCR", (b) => !!b.OCR),
      complete("Cover available", (b) => !!b["Cover URL"]),
      complete("Author identified", (b) => linked(b.Authors, authorMap).length > 0),
      complete("Classification", (b) => linked(b.Classification, classMap).length > 0),
      complete("Subjects", (b) => textList(b.Subjects).length > 0),
      complete("Edition year", (b) => !!b["Edition Year"]),
      complete("Publisher", (b) => !!b.Publisher),
    ],
    recent: books
      .slice()
      .sort((a, b) =>
        asText(b["Date Added"]).localeCompare(asText(a["Date Added"])) ||
        b.id.localeCompare(a.id)
      )
      .slice(0, 6)
      .map((b) => ({
        title: asText(b.Title) || "Untitled",
        author: linked(b.Authors, authorMap).join(", "),
        language: asText(b.Language),
        dateAdded: asText(b["Date Added"]),
      })),
  };
}

export async function buildAndSaveSnapshot(
  bucket: R2Bucket,
  airtableToken: string,
  config: SnapshotConfig,
): Promise<CatalogSnapshot> {
  const airtable = new CatalogClient(airtableToken, config.projectUrl);
  const [books, authors, classifications] = await Promise.all([
    airtable.list<BookFields>(config.booksTable),
    airtable.list<AuthorFields>(config.authorsTable),
    airtable.list<ClassificationFields>(config.classificationsTable),
  ]);
  // Never replace a previously good snapshot with an accidentally empty database response.
  if (books.length === 0) throw new Error("Supabase returned no books; snapshot not replaced.");

  const authorNames = new Map(authors.map((r) => [r.id, asText(r.fields.Name)]));
  const classificationNames = new Map(classifications.map((r) => [r.id, asText(r.fields.Class)]));

  const publishedBooks: PublishedBook[] = books.flatMap((record) => {
    const f = record.fields;
    if (f.Status !== "Published") return [];
    const slug = asText(f.Slug);
    const title = asText(f.Title);
    if (!slug || !title) return [];
    return [{
      slug,
      title,
      author: textList(f.Authors).map((id) => authorNames.get(id)).filter(Boolean).join("; "),
      classification: textList(f.Classification).map((id) => classificationNames.get(id)).find(Boolean) ?? "",
      dateAdded: asText(f["Date Added"]) || record.createdTime.slice(0, 10),
      subjects: textList(f.Subjects),
      language: asText(f.Language),
      pages: f.Pages,
      coverUrl: asText(f["Cover URL"]),
    }];
  });

  // The cover manifest exposes only the fields the existing endpoint already returned.
  const covers: CoverManifestEntry[] = books.flatMap((record) => {
    const f = record.fields;
    const slug = asText(f.Slug);
    const pdfKey = asText(f["R2 Key"]);
    const coverUrl = asText(f["Cover URL"]);
    const page = f["Cover Page"];
    if (!slug || !pdfKey || !coverUrl || !page || page < 1) return [];
    return {
      title: asText(f.Title) || slug,
      slug,
      pdfKey,
      coverUrl,
      page: Math.floor(page),
    };
  });

  const snapshot: CatalogSnapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    publishedBooks,
    covers,
    census: calculateCensusStats(books, authors, classifications),
  };

  await bucket.put(CATALOG_SNAPSHOT_KEY, JSON.stringify(snapshot), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return snapshot;
}

export async function readSnapshot(bucket: R2Bucket): Promise<CatalogSnapshot | null> {
  const object = await bucket.get(CATALOG_SNAPSHOT_KEY);
  if (!object) return null;
  const data: unknown = await object.json();
  if (!data || typeof data !== "object") throw new Error("Invalid Librarium snapshot.");
  const candidate = data as Partial<CatalogSnapshot>;
  if (candidate.version !== 1 || !Array.isArray(candidate.publishedBooks) ||
      !Array.isArray(candidate.covers) || !candidate.census ||
      typeof candidate.generatedAt !== "string") {
    throw new Error("Unsupported Librarium snapshot format.");
  }
  return candidate as CatalogSnapshot;
}
