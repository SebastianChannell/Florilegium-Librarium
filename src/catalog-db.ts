// Server-only adapter used by Librarium's existing import and snapshot code.
// This is intentionally not exposed to the browser. A Supabase sb_secret_*
// credential must be configured as a Cloudflare Worker secret.

export interface CatalogRecord<TFields = Record<string, unknown>> {
  id: string;
  createdTime: string;
  fields: TFields;
}

type CatalogTable = "Books" | "Authors" | "Classifications";

type DatabaseRow = Record<string, unknown> & { id: string; created_at?: string; source_created_at?: string };

const BOOK_COLUMNS: Record<string, string> = {
  Title: "title",
  Slug: "slug",
  Status: "status",
  Subjects: "subjects",
  Language: "language",
  "Original Language": "original_language",
  "Edition Year": "edition_year",
  Publisher: "publisher",
  Source: "source",
  "Date Added": "date_added",
  Pages: "pages",
  "R2 Key": "r2_key",
  "Content Hash": "content_hash",
  "File Size": "file_size",
  "File Type": "file_type",
  "PDF Available": "pdf_available",
  "Local PDF": "local_pdf",
  "Cover URL": "cover_url",
  "Cover Page": "cover_page",
  "Searchable Text": "searchable_text",
  OCR: "ocr",
  "Ingest Status": "ingest_status",
  "Ingest Message": "ingest_message",
  "Last Ingested": "last_ingested",
  Notes: "notes",
};

function assertTable(table: string): CatalogTable {
  if (table === "Books" || table === "Authors" || table === "Classifications") return table;
  throw new Error(`Unsupported catalog table: ${table}`);
}

function toFields(table: CatalogTable, row: DatabaseRow): Record<string, unknown> {
  if (table === "Authors") {
    return { Name: row.name ?? undefined, "Sort Name": row.sort_name ?? undefined };
  }
  if (table === "Classifications") {
    return { Class: row.class ?? undefined };
  }

  const fields: Record<string, unknown> = {};
  for (const [friendly, database] of Object.entries(BOOK_COLUMNS)) {
    if (row[database] != null) fields[friendly] = row[database];
  }
  const bookAuthors = (Array.isArray(row.book_authors) ? row.book_authors : []) as Array<{ author_id: string; sort_order: number }>;
  const bookClasses = (Array.isArray(row.book_classifications) ? row.book_classifications : []) as Array<{ classification_id: string; sort_order: number }>;
  fields.Authors = bookAuthors.sort((a, b) => a.sort_order - b.sort_order).map((entry) => entry.author_id);
  fields.Classification = bookClasses.sort((a, b) => a.sort_order - b.sort_order).map((entry) => entry.classification_id);
  return fields;
}

function fromFields(table: CatalogTable, fields: Record<string, unknown>): Record<string, unknown> {
  if (table === "Authors") {
    const name = fields.Name;
    if (typeof name !== "string" || !name.trim()) throw new Error("Author name is required.");
    return { name: name.trim(), sort_name: fields["Sort Name"] ?? null };
  }
  if (table === "Classifications") {
    const name = fields.Class;
    if (typeof name !== "string" || !name.trim()) throw new Error("Classification name is required.");
    return { class: name.trim() };
  }
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "Authors" || key === "Classification") continue;
    const column = BOOK_COLUMNS[key];
    if (!column) throw new Error(`Unsupported book field: ${key}`);
    if (value !== undefined) values[column] = value;
  }
  return values;
}

function tableName(table: CatalogTable): string {
  return table === "Books" ? "books" : table === "Authors" ? "authors" : "classifications";
}

export class CatalogClient {
  private readonly root: string;

  constructor(
    private readonly token: string,
    projectUrl: string,
  ) {
    const root = new URL(projectUrl);
    if (root.protocol !== "https:" || !/^[-a-z0-9]+\.supabase\.co$/i.test(root.hostname) ||
        root.pathname !== "/" || root.search || root.hash) {
      throw new Error("Invalid Supabase project URL.");
    }
    if (!token.startsWith("sb_secret_")) {
      throw new Error("A server-only Supabase sb_secret_* key is required.");
    }
    this.root = root.origin;
  }

  private async request<T>(
    table: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    options: { params?: Record<string, string>; data?: unknown; prefer?: string } = {},
  ): Promise<T> {
    const url = new URL(`${this.root}/rest/v1/${table}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      method,
      headers: {
        apikey: this.token,
        "Content-Type": "application/json",
        ...(options.prefer ? { Prefer: options.prefer } : {}),
      },
      body: options.data === undefined ? undefined : JSON.stringify(options.data),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Supabase ${table} HTTP ${response.status}: ${detail.slice(0, 320)}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json<T>();
  }

  async list<TFields>(
    table: string,
    options: { fields?: string[]; maxRecords?: number } = {},
  ): Promise<Array<CatalogRecord<TFields>>> {
    const checked = assertTable(table);
    const databaseTable = tableName(checked);
    const results: CatalogRecord<TFields>[] = [];
    const pageSize = 500;
    let offset = 0;
    while (true) {
      const rows = await this.request<DatabaseRow[]>(databaseTable, "GET", {
        params: {
          select: checked === "Books"
            ? "*,book_authors(author_id,sort_order),book_classifications(classification_id,sort_order)"
            : "*",
          order: "id.asc",
          limit: String(pageSize),
          offset: String(offset),
        },
      });
      for (const row of rows) {
        results.push({
          id: row.id,
          createdTime: String(row.source_created_at ?? row.created_at ?? new Date(0).toISOString()),
          fields: toFields(checked, row) as TFields,
        });
      }
      if (rows.length < pageSize || (options.maxRecords && results.length >= options.maxRecords)) break;
      offset += rows.length;
    }
    return options.maxRecords ? results.slice(0, options.maxRecords) : results;
  }

  async findAuthorByName(name: string): Promise<CatalogRecord<{ Name?: string }> | undefined> {
    // Match exact names case-insensitively without PostgREST wildcard escaping.
    const people = await this.list<{ Name?: string }>("Authors");
    return people.find((person) => person.fields.Name?.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"));
  }

  async create<TFields>(
    table: string,
    fields: Record<string, unknown>,
  ): Promise<CatalogRecord<TFields>> {
    const checked = assertTable(table);
    const databaseTable = tableName(checked);
    const values = fromFields(checked, fields);
    const created = await this.request<DatabaseRow[]>(databaseTable, "POST", {
      params: { select: "*" },
      data: values,
      prefer: "return=representation",
    });
    if (!created[0]) throw new Error(`Supabase did not return a new ${checked} record.`);
    const row = created[0];

    if (checked === "Books") {
      try {
        const authors = fields.Authors;
        const classes = fields.Classification;
        if (Array.isArray(authors) && authors.length) {
          await this.request("book_authors", "POST", {
            data: authors.map((author_id, sort_order) => ({ book_id: row.id, author_id, sort_order })),
          });
        }
        if (Array.isArray(classes) && classes.length) {
          await this.request("book_classifications", "POST", {
            data: classes.map((classification_id, sort_order) => ({ book_id: row.id, classification_id, sort_order })),
          });
        }
      } catch (error) {
        // A half-created book must not be mistaken for a completed ingest
        // during the next scheduled scan. Undo via ON DELETE CASCADE.
        try {
          await this.request("books", "DELETE", { params: { id: `eq.${row.id}` } });
        } catch (cleanupError) {
          console.error("Failed to roll back an incomplete catalog creation.", cleanupError);
        }
        throw error;
      }
    }

    const resultFields = checked === "Books"
      ? { ...fields }
      : toFields(checked, row);
    return {
      id: row.id,
      createdTime: String(row.created_at ?? new Date().toISOString()),
      fields: resultFields as TFields,
    };
  }

  async update<TFields>(
    table: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<CatalogRecord<TFields>> {
    const checked = assertTable(table);
    if (fields.Authors !== undefined || fields.Classification !== undefined) {
      throw new Error("Linked records must be managed through relationship tables.");
    }
    const values = fromFields(checked, fields);
    const updated = await this.request<DatabaseRow[]>(tableName(checked), "PATCH", {
      params: { id: `eq.${recordId}`, select: "*" },
      data: values,
      prefer: "return=representation",
    });
    if (!updated[0]) throw new Error(`Supabase could not update ${checked} record ${recordId}.`);
    return {
      id: updated[0].id,
      createdTime: String(updated[0].source_created_at ?? updated[0].created_at ?? new Date().toISOString()),
      fields: toFields(checked, updated[0]) as TFields,
    };
  }
}
