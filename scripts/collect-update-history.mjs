import { execFileSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { releaseKeys } from "./build-update-assets-v2.mjs";
import { verifyUpdateManifest } from "@omp-studio/runtime-installer";

const root = resolve("."), repo = process.env.GITHUB_REPOSITORY ?? "the-snowpear/omp-studio";
const arch = process.env.OMP_TARGET_ARCH ?? "x64", platform = `win32-${arch}`;
const dest = join(process.env.RUNNER_TEMP ?? join(root, "outputs"), `update-history-${arch}`);
await mkdir(dest, { recursive: true });
const catalogs = join(dest, "catalogs");
await mkdir(catalogs, { recursive: true });
const keys = await releaseKeys(root);
const pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const releases = pages.flat().filter(r => !r.draft).sort((a, b) => b.id - a.id);
const legacyName = arch === "x64" ? "update-index" : `update-index-${platform}`;
let legacy;
for (const release of releases) {
  const catalog = release.assets.find(a => a.name === `updates-${platform}.json`);
  if (catalog) {
    const bytes = execFileSync("gh", ["api", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${catalog.id}`], { maxBuffer: 1024 * 1024 });
    verifyUpdateManifest(JSON.parse(bytes.toString("utf8")), keys, repo, platform);
    await writeFile(join(catalogs, `${release.id}.json`), bytes);
  }
  if (!legacy && !release.prerelease && !release.tag_name.startsWith("runtime-v")) {
    const index = release.assets.find(a => a.name === `${legacyName}.json`), sig = release.assets.find(a => a.name === `${legacyName}.sig.json`);
    if (index && sig) {
      for (const asset of [index, sig]) await writeFile(join(dest, asset.name), execFileSync("gh", ["api", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${asset.id}`], { maxBuffer: 1024 * 1024 }));
      legacy = join(dest, `${legacyName}.json`);
    }
  }
}
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `OMP_PREVIOUS_CATALOG_DIR=${catalogs}\n${legacy ? `OMP_PREVIOUS_UPDATE_INDEX=${legacy}\n` : ""}`);
console.log(`Verified ${releases.length} release records; history stored in ${dest}`);
