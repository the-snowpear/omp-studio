// Build only the pi-natives addon for this host, for Runtime source tests
// (omp:verify:patches) on machines without a built Runtime artifact, such as CI.
// omp:build:host does the same as its first step; the output is git-ignored.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBun, ompSourceDirectory, run, toolingEnvironment } from "./omp-tooling.mjs";

const bun = findBun();
const env = toolingEnvironment({ CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4" });
// The upstream build regenerates this tracked declaration. Preserve the source
// input so patch verification can reverse the managed fork after compilation.
const declarationPath = join(ompSourceDirectory, "packages/natives/native/index.d.ts");
const declaration = readFileSync(declarationPath);
try {
  run(bun, ["--cwd=packages/natives", "run", "build"], { cwd: ompSourceDirectory, env });
} finally {
  writeFileSync(declarationPath, declaration);
}
