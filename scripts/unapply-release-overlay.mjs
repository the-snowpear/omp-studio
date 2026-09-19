// CI build jobs reuse one checkout for build and patch verification. Undo only
// the exact managed seams/overlay; never reset or clean unrelated changes.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertForkApplied, removeOverlay } from "./omp-overlay.mjs";
import { ompSourceDirectory, repositoryRoot, run } from "./omp-tooling.mjs";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Release checkout preparation is CI-only");
await assertForkApplied();
const series = JSON.parse(await readFile(join(repositoryRoot, "omp-patch/patches/series.json"), "utf8"));
for (const name of [...series.patches].reverse()) {
  if (!/^[A-Za-z0-9._-]+\.patch$/.test(name)) throw new Error("Unsafe patch name");
  const path = join(repositoryRoot, "omp-patch/patches", name);
  run("git", ["-C", ompSourceDirectory, "apply", "-R", "--check", path]);
  run("git", ["-C", ompSourceDirectory, "apply", "-R", path]);
}
await removeOverlay();
if (run("git", ["-C", ompSourceDirectory, "status", "--porcelain"], { capture: true }) !== "") throw new Error("Unexpected vendor changes after reversing managed build inputs");
