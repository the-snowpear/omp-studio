/**
 * Sandboxed preload bundle, shared by pack:win, pack:mac and preview. The
 * renderer's preload runs sandboxed, so it cannot `require` workspace packages
 * at runtime: esbuild inlines them into one CommonJS file.
 *
 * Uses esbuild's JS API: on macOS `esbuild/bin/esbuild` is the native binary,
 * not a script `node` can run.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { repositoryRoot } from "./omp-tooling.mjs";

export const PRELOAD_BUNDLE = join(repositoryRoot, "apps", "desktop", "dist", "preload.cjs");

function loadEsbuild() {
  try {
    return createRequire(join(repositoryRoot, "package.json"))("esbuild");
  } catch {
    throw new Error("esbuild is missing. Run npm install.");
  }
}

export function bundlePreload() {
  const result = loadEsbuild().buildSync({
    absWorkingDir: repositoryRoot,
    entryPoints: ["apps/desktop/src/preload.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    metafile: true,
    outfile: PRELOAD_BUNDLE,
    logLevel: "warning",
  });
  const unsupported = Object.values(result.metafile.outputs)
    .flatMap(output => output.imports)
    .filter(dependency => dependency.path !== "electron");
  if (unsupported.length) {
    throw new Error(`Sandboxed preload cannot load: ${unsupported.map(dependency => dependency.path).join(", ")}`);
  }
  if (!existsSync(PRELOAD_BUNDLE)) {
    throw new Error("Sandboxed preload was not emitted at apps/desktop/dist/preload.cjs");
  }
}
