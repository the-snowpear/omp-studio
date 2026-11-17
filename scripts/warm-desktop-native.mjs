import { rebuild } from "@electron/rebuild";
import { join } from "node:path";
import { repositoryRoot } from "./omp-tooling.mjs";
import { assertLockedElectronVersion } from "./release-cache.mjs";
import { resolveTargetArch } from "./windows-architecture.mjs";

await rebuild({
  buildPath: join(repositoryRoot, "apps", "desktop"),
  projectRootPath: repositoryRoot,
  electronVersion: assertLockedElectronVersion(),
  arch: resolveTargetArch(),
  platform: process.platform,
});
