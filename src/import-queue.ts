import { ingestLibrary } from "./ingest";
import { buildAndSaveSnapshot } from "./snapshot";

/**
 * A private-to-the-Worker durable import checkpoint in R2. No unpublished
 * titles, PDF paths or secrets are persisted here: failed object versions are
 * represented by SHA-256 fingerprints. The published catalog is a different R2 key.
 */
const STATE_KEY = "system/librarium/import-queue-v1.json";
const LEASE_MS = 16 * 60 * 1000;
const BATCH_SIZE = 2;
const MAX_CONSECUTIVE_ERRORS = 3;

export type ImportJobStatus = "queued" | "running" | "complete" | "failed";

interface ImportJob {
  version: 1;
  id: string;
  source: "manual" | "daily";
  status: ImportJobStatus;
  active: boolean;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  leaseId?: string;
  leaseUntil?: string;
  scanned: number;
  created: number;
  updated: number;
  failed: number;
  pending: number;
  skippedFailures: number;
  errorStreak: number;
  lastError?: string;
  /** Hashed file-version IDs, never raw PDF keys. */
  failureIds: string[];
}

export interface PublicImportJob {
  id: string;
  source: "manual" | "daily";
  status: ImportJobStatus;
  active: boolean;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  scanned: number;
  created: number;
  updated: number;
  failed: number;
  pending: number;
  skippedFailures: number;
  lastError?: string;
}

type Stored = { job: ImportJob; etag: string };

function toPublic(job: ImportJob): PublicImportJob {
  const {
    id, source, status, active, startedAt, updatedAt, finishedAt,
    scanned, created, updated, failed, pending, skippedFailures, lastError,
  } = job;
  return {
    id, source, status, active, startedAt, updatedAt, finishedAt,
    scanned, created, updated, failed, pending, skippedFailures, lastError,
  };
}

async function load(bucket: R2Bucket): Promise<Stored | null> {
  const obj = await bucket.get(STATE_KEY);
  if (!obj) return null;
  if (!("json" in obj)) throw new Error("Import queue state cannot be read.");
  const data = await obj.json<ImportJob>();
  if (data?.version !== 1 || typeof data.id !== "string" ||
      !Array.isArray(data.failureIds) || typeof data.active !== "boolean") {
    throw new Error("Unsupported import queue state.");
  }
  return { job: data, etag: obj.etag };
}

/** ETag compare-and-swap prevents two cron triggers from claiming a job. */
async function save(bucket: R2Bucket, job: ImportJob, previousEtag?: string): Promise<Stored | null> {
  const stored = await bucket.put(STATE_KEY, JSON.stringify(job), {
    onlyIf: previousEtag
      ? { etagMatches: previousEtag }
      : { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return stored ? { job, etag: stored.etag } : null;
}

export async function getImportJob(bucket: R2Bucket): Promise<PublicImportJob | null> {
  const current = await load(bucket);
  return current ? toPublic(current.job) : null;
}

/** Idempotently start an import. Another click rejoins the existing active job. */
export async function startImportJob(
  bucket: R2Bucket,
  source: "manual" | "daily",
): Promise<PublicImportJob> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await load(bucket);
    if (current?.job.active) return toPublic(current.job);
    const now = new Date().toISOString();
    const next: ImportJob = {
      version: 1,
      id: crypto.randomUUID(),
      source,
      status: "queued",
      active: true,
      startedAt: now,
      updatedAt: now,
      scanned: 0,
      created: 0,
      updated: 0,
      failed: 0,
      pending: 0,
      skippedFailures: 0,
      errorStreak: 0,
      failureIds: [],
    };
    const saved = await save(bucket, next, current?.etag);
    if (saved) return toPublic(saved.job);
  }
  throw new Error("The import queue was updated concurrently. Retry the request.");
}

/** Runs one bounded batch from cron; next minute resumes until fully drained. */
export async function processImportBatch(env: Env): Promise<PublicImportJob | null> {
  if (!env.SUPABASE_SECRET_KEY) {
    console.error("Queued import skipped: SUPABASE_SECRET_KEY is missing.");
    return null;
  }

  const initial = await load(env.LIBRARY_BUCKET);
  if (!initial?.job.active) return initial ? toPublic(initial.job) : null;
  if (initial.job.leaseUntil && Date.parse(initial.job.leaseUntil) > Date.now()) {
    return toPublic(initial.job);
  }

  const leaseId = crypto.randomUUID();
  const leased: ImportJob = {
    ...initial.job,
    status: "running",
    updatedAt: new Date().toISOString(),
    leaseId,
    leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
  };
  const claimed = await save(env.LIBRARY_BUCKET, leased, initial.etag);
  if (!claimed) return null; // Another cron invocation already claimed it.

  try {
    const summary = await ingestLibrary(env.LIBRARY_BUCKET, env.SUPABASE_SECRET_KEY, {
      prefix: env.R2_PREFIX,
      publicBaseUrl: env.R2_PUBLIC_BASE_URL,
      projectUrl: env.SUPABASE_URL,
      booksTable: "Books",
      authorsTable: "Authors",
      classificationsTable: "Classifications",
      maxChangedFilesPerRun: BATCH_SIZE,
      skipFailureIds: leased.failureIds,
    });

    const failureIds = [...new Set([
      ...leased.failureIds,
      ...summary.failures.map((failure) => failure.fingerprintId),
    ])];

    // Checkpoint *before* snapshot generation, so retries do not lose counts.
    const checkpoint: ImportJob = {
      ...leased,
      scanned: summary.scanned,
      created: leased.created + summary.created,
      updated: leased.updated + summary.updated,
      failed: leased.failed + summary.failed,
      pending: summary.deferred,
      skippedFailures: summary.skippedFailures,
      failureIds,
      errorStreak: 0,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    };
    const savedCheckpoint = await save(env.LIBRARY_BUCKET, checkpoint, claimed.etag);
    if (!savedCheckpoint) throw new Error("Import queue checkpoint was modified concurrently.");

    if (summary.deferred > 0) {
      const next: ImportJob = {
        ...checkpoint,
        status: "queued",
        leaseId: undefined,
        leaseUntil: undefined,
        updatedAt: new Date().toISOString(),
      };
      const savedNext = await save(env.LIBRARY_BUCKET, next, savedCheckpoint.etag);
      if (!savedNext) throw new Error("Import queue could not release its lease.");
      console.log(JSON.stringify({
        message: "Librarium queued import batch completed",
        jobId: next.id,
        created: summary.created,
        updated: summary.updated,
        failed: summary.failed,
        deferred: summary.deferred,
      }));
      return toPublic(savedNext.job);
    }

    // The job is only complete once the published-only R2 snapshot is saved.
    await buildAndSaveSnapshot(env.LIBRARY_BUCKET, env.SUPABASE_SECRET_KEY, {
      projectUrl: env.SUPABASE_URL,
      booksTable: "Books",
      authorsTable: "Authors",
      classificationsTable: "Classifications",
    });
    const finished: ImportJob = {
      ...checkpoint,
      status: "complete",
      active: false,
      pending: 0,
      leaseId: undefined,
      leaseUntil: undefined,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const savedFinished = await save(env.LIBRARY_BUCKET, finished, savedCheckpoint.etag);
    if (!savedFinished) throw new Error("Import finished, but queue completion could not be saved.");
    console.log(JSON.stringify({
      message: "Librarium queued import finished",
      jobId: finished.id,
      created: finished.created,
      updated: finished.updated,
      failed: finished.failed,
    }));
    return toPublic(savedFinished.job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "Librarium queued import batch failed", error: message }));
    const current = await load(env.LIBRARY_BUCKET);
    if (!current || current.job.id !== leased.id || current.job.leaseId !== leaseId) {
      return current ? toPublic(current.job) : null;
    }
    const streak = current.job.errorStreak + 1;
    const permanentlyFailed = streak >= MAX_CONSECUTIVE_ERRORS;
    const fallback: ImportJob = {
      ...current.job,
      active: !permanentlyFailed,
      status: permanentlyFailed ? "failed" : "queued",
      errorStreak: streak,
      leaseId: undefined,
      leaseUntil: undefined,
      updatedAt: new Date().toISOString(),
      finishedAt: permanentlyFailed ? new Date().toISOString() : undefined,
      lastError: permanentlyFailed
        ? "Import paused after repeated errors. Check Cloudflare logs, then start Import & refresh again."
        : "Temporary import error; retrying automatically.",
    };
    const savedFallback = await save(env.LIBRARY_BUCKET, fallback, current.etag);
    return savedFallback ? toPublic(savedFallback.job) : null;
  }
}
