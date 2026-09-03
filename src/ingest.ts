import { getDocumentProxy, getMeta } from "unpdf";
import { AirtableClient, escapeFormula } from "./airtable";

const PDF_EXTENSION = /\.pdf$/i;
const MAX_INSPECTION_BYTES = 25 * 1024 * 1024;
const MAX_INSPECTION_PAGES = 6;
const MAX_CHANGED_FILES_PER_RUN = 1;
const SMALL_WORDS = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"]);

interface IngestConfig {
  prefix: string;
  publicBaseUrl: string;
  baseId: string;
  booksTable: string;
  authorsTable: string;
  classificationsTable: string;
}

interface BookFields {
  Slug?: string;
  "R2 Key"?: string;
  "Content Hash"?: string;
  Status?: string;
}

interface NamedFields {
  Name?: string;
  Class?: string;
}

export interface IngestSummary {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  deferred: number;
}

export async function ingestLibrary(
  bucket: R2Bucket,
  token: string,
  config: IngestConfig,
): Promise<IngestSummary> {
  const airtable = new AirtableClient(token, config.baseId);
  const [books, authors, classifications, objects] = await Promise.all([
    airtable.list<BookFields>(config.booksTable, {
      fields: ["Slug", "R2 Key", "Content Hash", "Status"],
    }),
    airtable.list<NamedFields>(config.authorsTable, { fields: ["Name"] }),
    airtable.list<NamedFields>(config.classificationsTable, {
      fields: ["Class"],
    }),
    listPdfObjects(bucket, config.prefix),
  ]);

  const bookByKey = new Map(
    books
      .filter((record) => record.fields["R2 Key"])
      .map((record) => [record.fields["R2 Key"]!, record]),
  );
  const bookBySlug = new Map(
    books
      .filter((record) => record.fields.Slug)
      .map((record) => [record.fields.Slug!, record]),
  );
  const authorByName = new Map(
    authors
      .filter((record) => record.fields.Name)
      .map((record) => [normalize(record.fields.Name!), record.id]),
  );
  const classificationByName = new Map(
    classifications
      .filter((record) => record.fields.Class)
      .map((record) => [normalize(record.fields.Class!), record.id]),
  );

  const summary: IngestSummary = {
    scanned: objects.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    deferred: 0,
  };

  let changedFilesProcessed = 0;

  // Sequential processing stays comfortably below Airtable's per-base rate limit.
  for (const object of objects) {
    const slug = slugFromKey(object.key);
    const existing = bookByKey.get(object.key) ?? bookBySlug.get(slug);
    const fingerprint = object.etag || `${object.size}:${object.uploaded.toISOString()}`;

    if (existing?.fields["Content Hash"] === fingerprint) {
      summary.unchanged += 1;
      continue;
    }

    if (changedFilesProcessed >= MAX_CHANGED_FILES_PER_RUN) {
      summary.deferred += 1;
      continue;
    }
    changedFilesProcessed += 1;

    try {
      let fields: Record<string, unknown>;
      try {
        fields = await inspectPdf(bucket, object, slug, config, {
          airtable,
          authorByName,
          classificationByName,
        }, !existing);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        fields = baseFields(object, slug, config, {
          Title: titleFromObjectKey(object.key),
          "Ingest Status": "Review Needed",
          "Ingest Message": `Basic file data was imported, but PDF inspection could not be completed: ${message}`.slice(0, 5000),
        });
      }

      if (existing) {
        // A changed file refreshes only operational/file-derived fields. Curated
        // catalogue choices and Published status are never silently overwritten.
        const { Title: _title, Authors: _authors, Classification: _class, Status: _status, ...safeFields } = fields;
        if (existing.fields.Status === "Published") {
          safeFields["Ingest Status"] = "Ready";
          safeFields["Ingest Message"] = "File data refreshed. Published catalogue metadata was preserved.";
        }
        await airtable.update(config.booksTable, existing.id, safeFields);
        summary.updated += 1;
      } else {
        await airtable.create(config.booksTable, fields);
        summary.created += 1;
      }
    } catch (error: unknown) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (existing) {
        await airtable.update(config.booksTable, existing.id, {
          "Ingest Status": "Failed",
          "Ingest Message": message.slice(0, 5000),
          "Last Ingested": new Date().toISOString(),
        });
      }
      console.error(JSON.stringify({ message: "PDF ingest failed", key: object.key, error: message }));
    }
  }

  return summary;
}

async function inspectPdf(
  bucket: R2Bucket,
  object: R2Object,
  slug: string,
  config: IngestConfig,
  lookup: {
    airtable: AirtableClient;
    authorByName: Map<string, string>;
    classificationByName: Map<string, string>;
  },
  createLinks: boolean,
): Promise<Record<string, unknown>> {
  if (object.size > MAX_INSPECTION_BYTES) {
    return baseFields(object, slug, config, {
      Title: titleFromObjectKey(object.key),
      "Ingest Status": "Review Needed",
      "Ingest Message": "The PDF is larger than 25 MB. Basic file data was imported; bibliographic fields require review.",
    });
  }

  const stored = await bucket.get(object.key);
  if (!stored) {
    throw new Error("The R2 object disappeared before it could be processed.");
  }

  const bytes = new Uint8Array(await stored.arrayBuffer());
  const pdf = await getDocumentProxy(bytes);
  const meta = await getMeta(pdf, { parseDates: true });
  const totalPages = pdf.numPages;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= Math.min(totalPages, MAX_INSPECTION_PAGES); pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" "));
    page.cleanup();
  }
  const sample = pages.slice(0, 12).join("\n").slice(0, 80_000);
  const info = meta.info ?? {};
  const metadata = (meta.metadata ?? {}) as unknown as Record<string, unknown>;
  const rawTitle = firstUsefulString(info.Title, metadata.title);
  const rawAuthor = firstUsefulString(info.Author, metadata.author);
  const title = isUsefulTitle(rawTitle) ? rawTitle!.trim() : titleFromObjectKey(object.key);
  const authorName = cleanAuthor(rawAuthor);
  const authorId = authorName && createLinks
    ? await ensureAuthor(lookup.airtable, config.authorsTable, authorName, lookup.authorByName)
    : undefined;
  const classification = chooseClassification(`${title}\n${sample}`, lookup.classificationByName);
  const language = detectLanguage(sample);
  const searchable = sample.replace(/\s/g, "").length >= 80;
  const coverPage = chooseCoverPage(pages, title, authorName);
  const messages: string[] = [];

  if (!authorId) messages.push("Confirm and link the author.");
  if (!classification) messages.push("Choose the classification.");
  if (!rawTitle) messages.push("Title was formed from the filename; verify it against the title page.");
  messages.push("Verify subjects, source, edition year, publisher, original language, and OCR before publishing.");

  return baseFields(object, slug, config, {
    Title: title,
    ...(authorId ? { Authors: [authorId] } : {}),
    ...(classification ? { Classification: [classification] } : {}),
    ...(language ? { Language: language } : {}),
    Pages: totalPages,
    "Searchable Text": searchable,
    OCR: false,
    "Cover Page": coverPage,
    "Ingest Status": "Review Needed",
    "Ingest Message": messages.join(" "),
  });
}

function baseFields(
  object: R2Object,
  slug: string,
  config: IngestConfig,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    Slug: slug,
    "R2 Key": object.key,
    "Content Hash": object.etag || `${object.size}:${object.uploaded.toISOString()}`,
    "File Size": object.size,
    "File Type": "PDF",
    "PDF Available": true,
    "Local PDF": `${base}/${object.key.split("/").map(encodeURIComponent).join("/")}`,
    "Cover URL": `${base}/covers/${encodeURIComponent(slug)}.webp`,
    "Date Added": object.uploaded.toISOString().slice(0, 10),
    "Last Ingested": new Date().toISOString(),
    Status: "Draft",
    ...extra,
  };
}

async function ensureAuthor(
  airtable: AirtableClient,
  table: string,
  name: string,
  authorByName: Map<string, string>,
): Promise<string> {
  const key = normalize(name);
  const existing = authorByName.get(key);
  if (existing) return existing;

  // Recheck Airtable to avoid duplicates if simultaneous ingest runs overlap.
  const matches = await airtable.list<NamedFields>(table, {
    fields: ["Name"],
    filterByFormula: `LOWER({Name})='${escapeFormula(name.toLocaleLowerCase("en-US"))}'`,
    maxRecords: 1,
  });
  if (matches[0]) {
    authorByName.set(key, matches[0].id);
    return matches[0].id;
  }

  const created = await airtable.create<NamedFields>(table, {
    Name: name,
    "Sort Name": sortName(name),
  });
  authorByName.set(key, created.id);
  return created.id;
}

function chooseClassification(text: string, classes: Map<string, string>): string | undefined {
  const lower = normalize(text);
  const candidates: Array<[string, string[]]> = [
    ["liturgia", ["missal", "breviary", "office", "liturgy", "liturgical", "antiphon", "gradual", "misal", "breviario"]],
    ["theologia", ["catechism", "catecismo", "dogmatic", "theology", "theologia", "doctrine"]],
    ["spiritualia", ["prayer", "devotion", "meditation", "spiritual", "oración", "oraciones", "devoción", "saint", "martyr"]],
    ["auctores", ["sophocles", "virgil", "homer", "tragedy", "poetry", "classics"]],
  ];

  for (const [name, terms] of candidates) {
    const id = classes.get(name);
    if (id && terms.some((term) => lower.includes(term))) return id;
  }
  return undefined;
}

function detectLanguage(text: string): string | undefined {
  const words = ` ${normalize(text)} `;
  const scores = {
    English: [" the ", " and ", " of ", " that ", " with "].filter((word) => words.includes(word)).length,
    Spanish: [" el ", " la ", " de ", " que ", " para "].filter((word) => words.includes(word)).length,
    Latin: [" et ", " deus ", " dominus ", " qui ", " ad "].filter((word) => words.includes(word)).length,
  };
  const [language, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return score >= 3 ? language : undefined;
}

function chooseCoverPage(pages: string[], title: string, author?: string): number {
  const titleWords = normalize(title).split(" ").filter((word) => word.length > 3);
  const authorWords = normalize(author ?? "").split(" ").filter((word) => word.length > 3);
  let best = { page: 1, score: -1 };

  pages.slice(0, 10).forEach((page, index) => {
    const normalized = normalize(page.slice(0, 4000));
    const score =
      titleWords.filter((word) => normalized.includes(word)).length * 3 +
      authorWords.filter((word) => normalized.includes(word)).length * 2 -
      Math.min(normalized.length / 3000, 2);
    if (score > best.score) best = { page: index + 1, score };
  });
  return best.page;
}

function cleanAuthor(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned || /unknown|anonymous|microsoft word|acrobat/i.test(cleaned)) return undefined;
  return cleaned.slice(0, 200);
}

function isUsefulTitle(value?: string): boolean {
  return Boolean(value && value.trim().length > 2 && !/untitled|microsoft word|document\d*/i.test(value));
}

function firstUsefulString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function sortName(name: string): string {
  const withoutHonorific = name.replace(/^(st\.?|saint|bl\.?|blessed|fr\.?|father|pope)\s+/i, "");
  const withoutOrder = withoutHonorific.replace(/,?\s+(?:[A-Z]\.){1,5}$/i, "").trim();
  const parts = withoutOrder.split(/\s+/);
  if (parts.length < 2) return withoutOrder;
  const surname = parts.pop();
  return `${surname}, ${parts.join(" ")}`;
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugFromKey(key: string): string {
  const filename = key.split("/").at(-1) ?? key;
  return filename.replace(PDF_EXTENSION, "").toLocaleLowerCase("en-US").replace(/[_\s]+/g, "-");
}

function titleFromObjectKey(key: string): string {
  const filename = key.split("/").at(-1) ?? key;
  const words = filename.replace(PDF_EXTENSION, "").replace(/[_-]+/g, " ").trim().split(/\s+/);
  return words.map((word, index) => {
    const lower = word.toLocaleLowerCase("en-US");
    if (SMALL_WORDS.has(lower) && index > 0 && index < words.length - 1) return lower;
    return lower.charAt(0).toLocaleUpperCase("en-US") + lower.slice(1);
  }).join(" ") || "Untitled Book";
}

async function listPdfObjects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects.filter((object) => PDF_EXTENSION.test(object.key)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
