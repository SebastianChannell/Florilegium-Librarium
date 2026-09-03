const AIRTABLE_API = "https://api.airtable.com/v0";

export interface AirtableRecord<TFields = Record<string, unknown>> {
  id: string;
  createdTime: string;
  fields: TFields;
}

interface RecordPage<TFields> {
  records: Array<AirtableRecord<TFields>>;
  offset?: string;
}

export class AirtableClient {
  constructor(
    private readonly token: string,
    private readonly baseId: string,
  ) {}

  async list<TFields>(
    table: string,
    options: {
      fields?: string[];
      filterByFormula?: string;
      maxRecords?: number;
    } = {},
  ): Promise<Array<AirtableRecord<TFields>>> {
    const records: Array<AirtableRecord<TFields>> = [];
    let offset: string | undefined;

    do {
      const url = this.tableUrl(table);
      url.searchParams.set("pageSize", "100");
      if (options.filterByFormula) {
        url.searchParams.set("filterByFormula", options.filterByFormula);
      }
      if (options.maxRecords) {
        url.searchParams.set("maxRecords", String(options.maxRecords));
      }
      for (const field of options.fields ?? []) {
        url.searchParams.append("fields[]", field);
      }
      if (offset) {
        url.searchParams.set("offset", offset);
      }

      const page = await this.request<RecordPage<TFields>>(url);
      records.push(...page.records);
      offset = page.offset;
    } while (offset && (!options.maxRecords || records.length < options.maxRecords));

    return options.maxRecords ? records.slice(0, options.maxRecords) : records;
  }

  async create<TFields>(
    table: string,
    fields: Record<string, unknown>,
  ): Promise<AirtableRecord<TFields>> {
    return this.request<AirtableRecord<TFields>>(this.tableUrl(table), {
      method: "POST",
      body: JSON.stringify({ fields, typecast: true }),
    });
  }

  async update<TFields>(
    table: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<AirtableRecord<TFields>> {
    const url = this.tableUrl(table);
    url.pathname += `/${encodeURIComponent(recordId)}`;
    return this.request<AirtableRecord<TFields>>(url, {
      method: "PATCH",
      body: JSON.stringify({ fields, typecast: true }),
    });
  }

  private tableUrl(table: string): URL {
    return new URL(
      `${AIRTABLE_API}/${encodeURIComponent(this.baseId)}/${encodeURIComponent(table)}`,
    );
  }

  private async request<T>(url: URL, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Airtable ${response.status}: ${detail.slice(0, 500)}`);
    }

    return response.json<T>();
  }
}

export function escapeFormula(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
