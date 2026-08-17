// Put the vendor tree into its working state: overlay copied in, seam patches
// applied. This is the dev-loop entry point — edit inside the vendor tree, then
// run `npm run omp:patches:regen` to capture the result back.
//
// Unlike `omp:verify:patches` this leaves the tree patched instead of restoring
// it, and it is idempotent: an already-patched tree is reported and left alone.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyOverlay, assertOverlayPresent } from "./omp-overlay.mjs";
import { ompSourceDirectory, repositoryRoot, run } from "./omp-tooling.mjs";

const upstream = JSON.parse(await readFile(join(repositoryRoot, "omp-patch", "upstream.json"), "utf8"));
const series = JSON.parse(
  await readFile(join(repositoryRoot, "omp-patch", "patches", "series.json"), "utf8"),
);

const head = run("git", ["-C", ompSourceDirectory, "rev-parse", "HEAD"], { capture: true });
if (head !== upstream.commit || series.upstreamCommit !== upstream.commit) {
  throw new Error(`OMP pin mismatch: source=${head}, upstream=${upstream.commit}, series=${series.upstreamCommit}`);
}

await assertOverlayPresent();
const overlayFiles = await applyOverlay();
console.log(`Applied ${overlayFiles.length} overlay file(s)`);

for (const name of series.patches) {
  const patchFile = join(repositoryRoot, "omp-patch", "patches", name);
  try {
    run("git", ["-C", ompSourceDirectory, "apply", "--check", patchFile], { capture: true });
  } catch (forward) {
    try {
      run("git", ["-C", ompSourceDirectory, "apply", "--check", "-R", patchFile], { capture: true });
    } catch {
      // Neither direction is clean, so the tree sits somewhere in between —
      // usually a half-reverted file or a hand edit on a seam path. Say that
      // instead of surfacing two raw git rejects.
      throw new Error(
        `${name} neither applies nor reverses cleanly; the vendor tree is partially forked. Capture it with npm run omp:patches:regen, or reset the submodule working tree and rerun.`,
        { cause: forward },
      );
    }
    console.log(`Already applied: ${name}`);
    continue;
  }
  run("git", ["-C", ompSourceDirectory, "apply", patchFile]);
  console.log(`Applied ${name}`);
}

console.log(`Vendor tree ready at ${upstream.commit}`);
