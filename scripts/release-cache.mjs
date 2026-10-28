import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmInvocation, repositoryRoot } from "./omp-tooling.mjs";

// npm ci still uses the complete lockfile. Only the download/native cache
// identity omits workspace versions, which change on every Studio release.
export function dependencyFingerprint(lockfile) {
  const external = Object.entries(lockfile.packages)
    .filter(([path, pkg]) => path.includes("node_modules/") && !pkg.link)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(external)).digest("hex");
}

export function writeReleaseCacheOutputs() {
  const lockfile = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8"));
  const npm = npmInvocation();
  const npmCache = execFileSync(npm.command, [...npm.prefix, "config", "get", "cache"], { encoding: "utf8", windowsHide: true }).trim();
  const home = homedir();
  const cacheRoot = process.platform === "win32" ? process.env.LOCALAPPDATA
    : process.platform === "darwin" ? join(home, "Library", "Caches")
    : process.env.XDG_CACHE_HOME || join(home, ".cache");
  const cacheFor = name => join(cacheRoot, name, ...(process.platform === "win32" ? ["Cache"] : []));
  const outputs = {
    dependencies: dependencyFingerprint(lockfile),
    node: process.versions.node.split(".")[0],
    npm: npmCache,
    tools: [
      cacheFor("electron"),
      cacheFor("electron-builder"),
      join(home, ".electron-gyp"),
      join(repositoryRoot, "packaging", "installer-host", ".cache"),
    ].join("\n"),
  };
  for (const [name, value] of Object.entries(outputs)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<OMP_RELEASE_CACHE\n${value.replaceAll("\\", "/")}\nOMP_RELEASE_CACHE\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) writeReleaseCacheOutputs();
