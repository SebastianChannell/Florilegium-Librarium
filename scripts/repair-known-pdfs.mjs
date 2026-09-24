import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const bucket = process.env.R2_BUCKET ?? "sacrum-assets";
const assetBase = (process.env.R2_PUBLIC_BASE_URL ?? "https://assets.sacrumflorilegium.com").replace(/\/+$/, "");
const targets = [
  { key: "pdfs/conversaciones-sobre-el-protestantismo-actual.pdf", minPages: 300 },
  { key: "pdfs/respuestas-claras-y-sencillas-a-las-objeciones-contra-la-religon.pdf", minPages: 200 },
];

const work = await mkdtemp(join(tmpdir(), "librarium-safe-repair-"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const results = [];

try {
  for (const target of targets) {
    const name = basename(target.key);
    const sourcePath = join(work, `source-${name}`);
    const repairedPath = join(work, `repaired-${name}`);
    const verifyPath = join(work, `verify-${name}`);
    const url = `${assetBase}/${target.key}?repair-source=${Date.now()}`;

    console.log(`download ${target.key}`);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${target.key}: asset returned ${response.status}`);
    await writeFile(sourcePath, Buffer.from(await response.arrayBuffer()));

    await exec("mutool", ["clean", "-gg", sourcePath, repairedPath], { maxBuffer: 20 * 1024 * 1024 });
    const pages = await pageCount(repairedPath);
    await exec("qpdf", ["--check", repairedPath], { maxBuffer: 20 * 1024 * 1024 });
    if (pages < target.minPages) {
      throw new Error(`${target.key}: repaired output has only ${pages} pages; expected at least ${target.minPages}`);
    }

    const backupKey = `repair-backups/${stamp}/${target.key}`;
    await wranglerPut(backupKey, sourcePath);
    await wranglerPut(target.key, repairedPath);

    const verifyResponse = await fetch(`${assetBase}/${target.key}?repair-verify=${Date.now()}`, { cache: "no-store" });
    if (!verifyResponse.ok) throw new Error(`${target.key}: verification fetch returned ${verifyResponse.status}`);
    await writeFile(verifyPath, Buffer.from(await verifyResponse.arrayBuffer()));
    const verifiedPages = await pageCount(verifyPath);
    await exec("qpdf", ["--check", verifyPath], { maxBuffer: 20 * 1024 * 1024 });
    if (verifiedPages !== pages) throw new Error(`${target.key}: uploaded copy has ${verifiedPages} pages, repaired copy has ${pages}`);

    const bytes = (await readFile(repairedPath)).length;
    results.push({ key: target.key, pages, bytes, backupKey });
    console.log(`repaired ${target.key}: ${pages} pages, ${bytes} bytes`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));

async function pageCount(file) {
  const { stdout } = await exec("pdfinfo", [file], { maxBuffer: 10 * 1024 * 1024 });
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error(`Unable to determine page count for ${file}`);
  return Number(match[1]);
}

async function wranglerPut(key, file) {
  await exec("npx", [
    "wrangler", "r2", "object", "put", `${bucket}/${key}`,
    "--remote", `--file=${file}`, "--content-type=application/pdf",
  ], { maxBuffer: 20 * 1024 * 1024 });
}
