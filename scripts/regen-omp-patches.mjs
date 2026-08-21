// Capture the vendor working tree back into the two-layer patch model.
//
//   1. overlay files (Studio-owned, absent upstream) are copied into
//      omp-patch/overlay/
//   2. seam patches are regenerated from `git diff` over the path lists in
//      scripts/omp-seam.mjs
//   3. series.json is rewritten, and patchsetVersion is bumped whenever the
//      captured content digest changed
//
// Run this after editing inside omp-patch/vendor/oh-my-pi. It is the only
// supported way to produce a .patch file — hand-written patches drift from the
// group definition and reintroduce the ordering problems this model removes.

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertOverlayPresent, captureOverlay, overlayHash, overlayRoot } from "./omp-overlay.mjs";
import { PATCHSET_VERSION_FILE, SEAM_EXCLUDED, SEAM_GROUPS, withPatchsetVersionConstant } from "./omp-seam.mjs";
import { ompSourceDirectory, repositoryRoot, run } from "./omp-tooling.mjs";
import {
  PATCHES_DIRECTORY,
  computePatchHashes,
  nextPatchsetVersion,
  readPatchSeries,
  seriesDigest,
  writePatchSeries,
} from "./runtime-artifact.mjs";

const series = await readPatchSeries();

await assertOverlayPresent();
const capture = await captureOverlay();
if (capture.missing.length > 0) {
  throw new Error(
    `Overlay files are missing from the vendor tree; run npm run omp:overlay:apply first:\n  ${capture.missing.join("\n  ")}`,
  );
}
console.log(
  capture.changed.length === 0
    ? `Overlay already current (${capture.total} files)`
    : `Captured ${capture.changed.length}/${capture.total} overlay file(s):\n  ${capture.changed.join("\n  ")}`,
);

const tracked = run("git", ["-C", ompSourceDirectory, "diff", "--name-only"], { capture: true })
  .split(/\r?\n/u)
  .filter(Boolean);
const grouped = new Set(SEAM_GROUPS.flatMap(group => group.paths));
const excluded = new Set(SEAM_EXCLUDED);
const ungrouped = tracked.filter(path => !grouped.has(path) && !excluded.has(path));
if (ungrouped.length > 0) {
  throw new Error(
    `Vendor tree changes these upstream files, but no seam group claims them. Add each to a group in scripts/omp-seam.mjs:\n  ${ungrouped.join("\n  ")}`,
  );
}

const written = [];
for (const group of SEAM_GROUPS) {
  const present = group.paths.filter(path => tracked.includes(path));
  const target = join(PATCHES_DIRECTORY, group.file);
  if (present.length === 0) {
    await rm(target, { force: true });
    console.log(`No changes for ${group.file}; removed`);
    continue;
  }
  const diff = run("git", ["-C", ompSourceDirectory, "diff", "--", ...present], { capture: true });
  await writeFile(target, `${diff}\n`, "utf8");
  written.push(group.file);
  console.log(`Wrote ${group.file} (${present.length} file(s))`);
}

const stale = SEAM_GROUPS.map(group => group.file).filter(file => !written.includes(file));
const patchHashes = await computePatchHashes(PATCHES_DIRECTORY, written);
const digest = seriesDigest({ overlayHash: await overlayHash(), patchHashes });
const patchsetVersion =
  digest === series.patchsetDigest ? series.patchsetVersion : nextPatchsetVersion(series.patchsetVersion);

await writePatchSeries({
  upstreamCommit: series.upstreamCommit,
  patchsetVersion,
  patchsetDigest: digest,
  patches: written,
});

// The Runtime reports `${VERSION}-${PATCHSET_VERSION}` in its Studio Hello, and
// packaging refuses to sign an artifact whose probed identity disagrees with the
// series. Writing the derived version here means a bump can never be discovered
// only at the end of a ~10-minute native build. The digest deliberately ignores
// this literal (see digestibleOverlaySource), so rewriting it does not demand
// another bump on the next run.
const versionFilePaths = [
  join(overlayRoot, ...PATCHSET_VERSION_FILE.split("/")),
  join(ompSourceDirectory, ...PATCHSET_VERSION_FILE.split("/")),
];
let rewroteVersionConstant = false;
for (const path of versionFilePaths) {
  const source = await readFile(path, "utf8");
  const next = withPatchsetVersionConstant(source, patchsetVersion);
  if (next === source) continue;
  await writeFile(path, next, "utf8");
  rewroteVersionConstant = true;
}
if (rewroteVersionConstant) {
  console.log(`Synced PATCHSET_VERSION to ${patchsetVersion} in ${PATCHSET_VERSION_FILE}`);
}

console.log(
  `series.json: ${written.length} seam patch(es), patchsetVersion=${patchsetVersion}` +
    (patchsetVersion === series.patchsetVersion ? " (unchanged)" : ` (was ${series.patchsetVersion})`),
);
if (stale.length > 0) console.log(`Empty group(s): ${stale.join(", ")}`);

// Leave a breadcrumb for the reviewer: the repo diff now carries everything.
const overlayStatus = run("git", ["status", "--porcelain", "--", "omp-patch"], {
  cwd: repositoryRoot,
  capture: true,
});
console.log(overlayStatus === "" ? "omp-patch is unchanged" : `omp-patch changes:\n${overlayStatus}`);
