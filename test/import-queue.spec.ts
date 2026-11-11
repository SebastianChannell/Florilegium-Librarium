import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startImportJob, processImportBatch, getImportJob } from "../src/import-queue";
import { ingestLibrary, type IngestSummary } from "../src/ingest";
import { buildAndSaveSnapshot } from "../src/snapshot";

vi.mock("../src/ingest", () => ({ ingestLibrary: vi.fn() }));
vi.mock("../src/snapshot", () => ({ buildAndSaveSnapshot: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(buildAndSaveSnapshot).mockResolvedValue({
    version: 1, generatedAt: new Date().toISOString(),
    publishedBooks: [], covers: [], census: {} as never,
  });
});
afterEach(() => vi.unstubAllGlobals());

function makeBucket() {
  let serial = 0;
  const records = new Map<string, { value: string; etag: string }>();
  const bucket = {
    async get(key: string) {
      const item = records.get(key);
      return item ? {
        etag: item.etag,
        json: async () => JSON.parse(item.value),
      } : null;
    },
    async put(key: string, value: string, options?: R2PutOptions) {
      const current = records.get(key);
      if (options?.onlyIf) {
        const cond = options.onlyIf as R2Conditional;
        if (cond.etagMatches && cond.etagMatches !== current?.etag) return null;
        if (cond.etagDoesNotMatch === "*" && current) return null;
      }
      serial += 1;
      const etag = "etag-" + serial;
      records.set(key, { value, etag });
      return { etag };
    },
  } as unknown as R2Bucket;
  return { bucket, records };
}

function makeEnv(bucket: R2Bucket): Env {
  return {
    LIBRARY_BUCKET: bucket,
    SUPABASE_SECRET_KEY: "sb_secret_vitest_only",
    SUPABASE_URL: "https://gqqzogtrywuvomzmapgf.supabase.co",
    R2_PREFIX: "pdfs/",
    R2_PUBLIC_BASE_URL: "https://assets.sacrumflorilegium.com/",
    PDFJS_BASE_URL: "https://reader.sacrumflorilegium.com/web/viewer.html",
  } as Env;
}

function result(values: Partial<IngestSummary> = {}): IngestSummary {
  return {
    scanned: 24, previouslyKnown: 10, newCandidates: 14,
    created: 0, updated: 0, unchanged: 10,
    failed: 0, deferred: 0, skippedFailures: 0,
    failures: [], deferredKeys: [],
    ...values,
  };
}

describe("resumable R2 to Supabase queue", () => {
  it("one click starts a job; subsequent scheduled ticks drain all files", async () => {
    const { bucket } = makeBucket();
    const env = makeEnv(bucket);
    vi.mocked(ingestLibrary)
      .mockResolvedValueOnce(result({
        created: 2, failed: 1, deferred: 11,
        failures: [{
          key: "pdfs/bad.pdf", reason: "Supabase rejected the write (HTTP 403)",
          fingerprintId: "failed-fingerprint-id",
        }],
      }))
      .mockResolvedValueOnce(result({
        created: 2, deferred: 9, skippedFailures: 1,
      }))
      .mockResolvedValueOnce(result({
        created: 2, deferred: 7, skippedFailures: 1,
      }))
      .mockResolvedValueOnce(result({
        created: 2, deferred: 5, skippedFailures: 1,
      }))
      .mockResolvedValueOnce(result({
        created: 2, deferred: 3, skippedFailures: 1,
      }))
      .mockResolvedValueOnce(result({
        created: 2, deferred: 1, skippedFailures: 1,
      }))
      .mockResolvedValueOnce(result({
        created: 1, deferred: 0, skippedFailures: 1,
      }));

    const start = await startImportJob(bucket, "manual");
    expect(start).toMatchObject({ active: true, status: "queued", created: 0 });
    const joined = await startImportJob(bucket, "manual");
    expect(joined.id).toBe(start.id);

    let state = await processImportBatch(env);
    expect(state).toMatchObject({
      status: "queued", active: true, created: 2, failed: 1, pending: 11,
    });
    expect(vi.mocked(buildAndSaveSnapshot)).not.toHaveBeenCalled();
    expect(vi.mocked(ingestLibrary).mock.calls[0][2]).toMatchObject({
      maxChangedFilesPerRun: 2, skipFailureIds: [],
    });

    state = await processImportBatch(env);
    expect(vi.mocked(ingestLibrary).mock.calls[1][2].skipFailureIds)
      .toContain("failed-fingerprint-id");
    for (let i = 0; i < 5; i++) state = await processImportBatch(env);

    expect(state).toMatchObject({
      status: "complete", active: false,
      created: 13, failed: 1, pending: 0, skippedFailures: 1,
    });
    expect(vi.mocked(ingestLibrary)).toHaveBeenCalledTimes(7);
    expect(vi.mocked(buildAndSaveSnapshot)).toHaveBeenCalledTimes(1);

    const publicStatus = await getImportJob(bucket);
    expect(publicStatus).toMatchObject({ id: start.id, status: "complete" });
    expect(JSON.stringify(publicStatus)).not.toContain("pdfs/bad.pdf");
    expect(JSON.stringify(publicStatus)).not.toContain("failed-fingerprint-id");
    const next = await startImportJob(bucket, "daily");
    expect(next.id).not.toBe(start.id);
    expect(next).toMatchObject({ source: "daily", status: "queued", created: 0 });
  });

  it("only one cron invocation can claim a job concurrently", async () => {
    const { bucket } = makeBucket();
    const env = makeEnv(bucket);
    await startImportJob(bucket, "manual");
    vi.mocked(ingestLibrary).mockResolvedValue(result({ deferred: 2 }));
    const [first, second] = await Promise.all([
      processImportBatch(env), processImportBatch(env),
    ]);
    expect(vi.mocked(ingestLibrary)).toHaveBeenCalledTimes(1);
    expect([first, second].some((x) => x?.status === "queued")).toBe(true);
    expect(vi.mocked(buildAndSaveSnapshot)).not.toHaveBeenCalled();
  });

  it("retries recoverable batch errors, then stops rather than looping forever", async () => {
    const { bucket } = makeBucket();
    const env = makeEnv(bucket);
    await startImportJob(bucket, "manual");
    vi.mocked(ingestLibrary).mockRejectedValue(new Error("Supabase temporarily unavailable"));

    let state = await processImportBatch(env);
    expect(state).toMatchObject({ active: true, status: "queued" });
    state = await processImportBatch(env);
    expect(state).toMatchObject({ active: true, status: "queued" });
    state = await processImportBatch(env);
    expect(state).toMatchObject({ active: false, status: "failed" });
    expect(state?.lastError).not.toContain("Supabase temporarily unavailable");

    const restarted = await startImportJob(bucket, "manual");
    expect(restarted).toMatchObject({ active: true, status: "queued" });
  });

  it("does not count work twice if the final R2 snapshot fails once", async () => {
    const { bucket } = makeBucket();
    const env = makeEnv(bucket);
    const start = await startImportJob(bucket, "manual");
    vi.mocked(ingestLibrary).mockResolvedValue(result({
      created: 1, deferred: 0,
    }));
    vi.mocked(buildAndSaveSnapshot)
      .mockRejectedValueOnce(new Error("Snapshot writer temporarily offline"))
      .mockResolvedValueOnce({ version: 1, generatedAt: "", publishedBooks: [], covers: [], census: {} as never });

    const retry = await processImportBatch(env);
    expect(retry).toMatchObject({ active: true, status: "queued", created: 1 });
    vi.mocked(ingestLibrary).mockResolvedValueOnce(result({ unchanged: 11 }));
    const done = await processImportBatch(env);
    expect(done).toMatchObject({ id: start.id, status: "complete", created: 1 });
    expect(vi.mocked(buildAndSaveSnapshot)).toHaveBeenCalledTimes(2);
  });
});
