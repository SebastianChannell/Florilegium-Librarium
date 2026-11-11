import { CatalogClient } from "./catalog-db";
import { listPdfObjects, slugFromKey } from "./ingest";

interface BookKeyFields {
  Slug?: string;
  "R2 Key"?: string;
}

export interface R2CatalogAudit {
  checkedAt: string;
  r2PdfCount: number;
  supabaseBookCount: number;
  matchingKeys: number;
  missingFromSupabase: Array<{
    key: string;
    normalizedSlug: string;
    collidesWithSlug?: string;
  }>;
  missingFromR2: Array<{ key: string; slug: string }>;
}

/**
 * Read-only, authenticated reconciliation. Not exposed on public catalog routes:
 * new/unpublished PDF filenames are considered private until manually approved.
 */
export async function auditR2Catalog(
  bucket: R2Bucket,
  token: string,
  projectUrl: string,
  prefix: string,
): Promise<R2CatalogAudit> {
  const client = new CatalogClient(token, projectUrl);
  const [objects, books] = await Promise.all([
    listPdfObjects(bucket, prefix),
    client.list<BookKeyFields>("Books"),
  ]);
  const keysInR2 = new Set(objects.map((object) => object.key));
  const keysInSupabase = new Map(
    books.filter((book) => book.fields["R2 Key"])
      .map((book) => [book.fields["R2 Key"]!, book]),
  );
  const booksBySlug = new Map(
    books.filter((book) => book.fields.Slug)
      .map((book) => [book.fields.Slug!, book]),
  );

  const missingFromSupabase = objects
    .filter((object) => !keysInSupabase.has(object.key))
    .map((object) => {
      const normalizedSlug = slugFromKey(object.key);
      const collision = booksBySlug.get(normalizedSlug);
      return {
        key: object.key,
        normalizedSlug,
        ...(collision ? { collidesWithSlug: collision.fields.Slug } : {}),
      };
    });
  const missingFromR2 = books
    .filter((book) => book.fields["R2 Key"] && !keysInR2.has(book.fields["R2 Key"]!))
    .map((book) => ({
      key: book.fields["R2 Key"]!,
      slug: book.fields.Slug ?? "",
    }));

  return {
    checkedAt: new Date().toISOString(),
    r2PdfCount: objects.length,
    supabaseBookCount: books.length,
    matchingKeys: objects.length - missingFromSupabase.length,
    missingFromSupabase,
    missingFromR2,
  };
}
