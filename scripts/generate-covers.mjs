import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const manifestUrl = process.env.COVER_MANIFEST_URL ??
  "https://librarium.sacrumflorilegium.com/api/cover-manifest";
const bucket = process.env.R2_BUCKET ?? "sacrum-assets";
const force = process.env.FORCE_COVERS === "true";

const response = await fetch(manifestUrl, { headers: { Accept: "application/json" } });
if (!response.ok) throw new Error(`Cover manifest returned ${response.status}.`);
const { covers } = await response.json();
if (!Array.isArray(covers)) throw new Error("Cover manifest is invalid.");

const work = await mkdtemp(join(tmpdir(), "librarium-covers-"));
let created = 0;
let skipped = 0;

try {
  for (const cover of covers) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cover.slug) || !Number.isInteger(cover.page) || cover.page < 1) {
      throw new Error(`Unsafe or invalid cover entry: ${JSON.stringify(cover)}`);
    }
    if (!force) {
      const existing = await fetch(`${cover.coverUrl}?cover-check=${Date.now()}`, { method: "HEAD" });
      if (existing.ok) {
        console.log(`skip ${cover.slug}: cover already exists`);
        skipped += 1;
        continue;
      }
    }

    console.log(`render ${cover.slug}: PDF page ${cover.page}`);
    const pdfResponse = await fetch(cover.pdfUrl);
    if (!pdfResponse.ok) throw new Error(`${cover.slug}: PDF returned ${pdfResponse.status}.`);
    const pdfPath = join(work, `${cover.slug}.pdf`);
    const imageBase = join(work, cover.slug);
    const ppmPath = `${imageBase}.ppm`;
    const webpPath = `${imageBase}.webp`;
    await writeFile(pdfPath, Buffer.from(await pdfResponse.arrayBuffer()));
    await exec("pdftoppm", ["-f", String(cover.page), "-l", String(cover.page), "-singlefile", "-r", "180", pdfPath, imageBase]);
    await exec("cwebp", ["-quiet", "-q", "82", ppmPath, "-o", webpPath]);
    await exec("npx", ["wrangler", "r2", "object", "put", `${bucket}/covers/${cover.slug}.webp`, "--remote", `--file=${webpPath}`, "--content-type=image/webp"], { maxBuffer: 10 * 1024 * 1024 });
    created += 1;
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log(JSON.stringify({ covers: covers.length, created, skipped }));
