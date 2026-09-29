/**
 * Sandboxed preload bundle, shared by pack:win and pack:mac. The renderer's
 * preload runs sandboxed, so it cannot `require` workspace packages at
 * runtime: esbuild inlines them into one CommonJS file.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { repositoryRoot, run } from "./omp-tooling.mjs";

const esbuildCli = join(repositoryRoot, "node_modules", "esbuild", "bin", "esbuild");

export const PRELOAD_BUNDLE = join(repositoryRoot, "apps", "desktop", "dist", "preload.cjs");

export function bundlePreload() {
  if (!existsSync(esbuildCli)) {
    throw new Error("esbuild is missing. Run npm install.");
  }
  run(process.execPath, [
    esbuildCli,
    "apps/desktop/src/preload.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=apps/desktop/dist/preload.cjs",
  ]);
  if (!existsSync(PRELOAD_BUNDLE)) {
    throw new Error("Sandboxed preload was not emitted at apps/desktop/dist/preload.cjs");
  }
}
