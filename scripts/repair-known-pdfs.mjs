import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const bucket = process.env.R2_BUCKET ?? "sacrum-assets";
const assetBase = (process.env.R2_PUBLIC_BASE_URL ?? "https://assets.sacrumflorilegium.com").replace(/\/+$/, "");
const work = await mkdtemp(join(tmpdir(), "librarium-pdf-recovery-"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const repairTargets = [
  { key: "pdfs/conversaciones-sobre-el-protestantismo-actual.pdf", minPages: 300 },
  { key: "pdfs/respuestas-claras-y-sencillas-a-las-objeciones-contra-la-religon.pdf", minPages: 200 },
];

// Revalidate known Archive.org recoveries whenever this workflow is retriggered.\nconst archiveTargets = [
  {
    key: "pdfs/al-soldado-en-tiempo-de-guerra.pdf",
    minPages: 10,
    identifier: "al-soldado-en-tiempo-de-guerra-mons.-louis-gaston-adrien-de-segur_202412",
    file: "Al soldado en tiempo de guerra - Mons. Louis Gastón Adrien de Segur.pdf",
  },
  {
    key: "pdfs/la-pasion-de-nuestro-senor-jesucristo.pdf",
    minPages: 10,
    identifier: "la-pasion-de-nuestro-senor-jesucristo-mons-louis-gaston-adrien-de",
    file: "La_Pasión_de_Nuestro_Señor_Jesucristo_Mons_Louis_Gastón_Adrien_de.pdf",
  },
  {
    key: "pdfs/el-infierno.pdf",
    minPages: 10,
    identifier: "el-infierno-monsenor-de-segur",
    file: "El infierno - Monseñor de Ségur.pdf",
  },
  {
    key: "pdfs/el-sagrado-corazon-de-jesus.pdf",
    minPages: 10,
    identifier: "el-sagrado-corazo-n-de-jesu-s-por-monsenor-segur",
    file: "EL SAGRADO CORAZÒN DE JESÙS por Monseñor Segur.pdf",
  },
  {
    key: "pdfs/las-maravillas-de-lourdes.pdf",
    minPages: 10,
    identifier: "las-maravillas-de-lourdes-mons.-louis-gaston-adrien-de-segur_202412",
    file: "Las maravillas de Lourdes - Mons. Louis Gastón Adrien de Segur.pdf",
  },
];

const results = [];

try {
  for (const target of repairTargets) {
    const existing = await downloadAsset(target.key, "existing");
    const currentPages = await usablePageCount(existing.path);
    if (currentPages && currentPages >= target.minPages) {
      console.log(`skip ${target.key}: already valid (${currentPages} pages)`);
      results.push({ key: target.key, status: "already-valid", pages: currentPages, bytes: existing.bytes });
      continue;
    }

    const repairedPath = join(work, `repaired-${basename(target.key)}`);
    await exec("mutool", ["clean", "-gg", existing.path, repairedPath], { maxBuffer: 20 * 1024 * 1024 });
    const pages = await requireUsablePdf(repairedPath, target.minPages, target.key);
    const backupKey = await backupAndReplace(target.key, existing.path, repairedPath);
    const verified = await verifyUploaded(target.key, pages);
    results.push({ key: target.key, status: "repaired", pages, bytes: verified.bytes, backupKey });
  }

  for (const target of archiveTargets) {
    const existing = await downloadAsset(target.key, "existing");
    const currentPages = await usablePageCount(existing.path);
    if (currentPages && currentPages >= target.minPages) {
      console.log(`skip ${target.key}: already valid (${currentPages} pages)`);
      results.push({ key: target.key, status: "already-valid", pages: currentPages, bytes: existing.bytes });
      continue;
    }

    const archiveUrl = `https://archive.org/download/${encodeURIComponent(target.identifier)}/${encodeURIComponent(target.file)}`;
    console.log(`recover ${target.key} from ${target.identifier}`);
    const archivePath = join(work, `archive-${basename(target.key)}`);
    const response = await fetchWithRetry(archiveUrl, 4);
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
    const pages = await requireUsablePdf(archivePath, target.minPages, target.key);

    const backupKey = await backupAndReplace(target.key, existing.path, archivePath);
    const verified = await verifyUploaded(target.key, pages);
    results.push({
      key: target.key,
      status: "recovered-from-internet-archive",
      pages,
      bytes: verified.bytes,
      backupKey,
      archiveIdentifier: target.identifier,
    });
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log("\n=== Recovery summary ===");
console.log(JSON.stringify(results, null, 2));

async function downloadAsset(key, prefix) {
  const path = join(work, `${prefix}-${basename(key)}`);
  const response = await fetch(`${assetBase}/${key}?pdf-recovery=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${key}: asset returned ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(path, body);
  return { path, bytes: body.length };
}

async function backupAndReplace(key, oldPath, newPath) {
  const backupKey = `repair-backups/${stamp}/${key}`;
  await wranglerPut(backupKey, oldPath);
  await wranglerPut(key, newPath);
  return backupKey;
}

async function verifyUploaded(key, expectedPages) {
  const verify = await downloadAsset(key, "verify");
  const pages = await requireUsablePdf(verify.path, Math.max(1, expectedPages), key);
  if (pages !== expectedPages) throw new Error(`${key}: uploaded copy has ${pages} pages; expected ${expectedPages}`);
  console.log(`verified ${key}: ${pages} pages, ${verify.bytes} bytes`);
  return { pages, bytes: verify.bytes };
}

async function requireUsablePdf(file, minPages, label) {
  const pages = await usablePageCount(file);
  if (!pages || pages < minPages) {
    throw new Error(`${label}: source is not a usable PDF with at least ${minPages} pages (found ${pages ?? 0})`);
  }
  return pages;
}

async function usablePageCount(file) {
  try {
    await qpdfCheck(file);
    return await pageCount(file);
  } catch {
    return null;
  }
}

async function pageCount(file) {
  const { stdout } = await exec("pdfinfo", [file], { maxBuffer: 10 * 1024 * 1024 });
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error(`Unable to determine page count for ${file}`);
  return Number(match[1]);
}

async function qpdfCheck(file) {
  try {
    await exec("qpdf", ["--check", file], { maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    if (error?.code === 3) return;
    throw error;
  }
}

async function wranglerPut(key, file) {
  await exec("npx", [
    "wrangler", "r2", "object", "put", `${bucket}/${key}`,
    "--remote", `--file=${file}`, "--content-type=application/pdf",
  ], { maxBuffer: 20 * 1024 * 1024 });
}


async function fetchWithRetry(url, attempts) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { "User-Agent": "Florilegium-Librarium/1.0" },
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      console.warn(`download attempt ${attempt}/${attempts} failed: ${error?.message || error}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError;
}
