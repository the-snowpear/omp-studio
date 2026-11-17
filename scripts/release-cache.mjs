import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmInvocation, repositoryRoot } from "./omp-tooling.mjs";
import { releasePlan } from "./release-plan.mjs";

const nativeInputs = [
  "omp-patch/vendor/oh-my-pi", "omp-patch/upstream.json",
  "scripts/build-omp-host.mjs", "scripts/build-omp-natives.mjs", "scripts/install-omp-deps.mjs",
  "scripts/omp-tooling.mjs", "scripts/omp-overlay.mjs", "scripts/omp-seam.mjs",
  "scripts/apply-omp-overlay.mjs", "scripts/release-cache.mjs",
  ".github/actions/cache-runtime-build", ".github/workflows/runtime-artifacts.yml",
  "scripts/native-artifact.mjs", ".github/actions/setup-native-build", ".github/workflows/runtime-platform.yml",
];
const desktopInputs = [
  "scripts/pack-win.mjs", "scripts/pack-mac.mjs", "scripts/mac-bundle.mjs",
  "scripts/pack-linux.mjs", "scripts/linux-bundle.mjs", "scripts/build-installer-host.mjs",
  "scripts/warm-release-tools.mjs", "scripts/warm-desktop-native.mjs", "scripts/release-cache.mjs", "packaging/electron-builder.yml",
  ".github/actions/cache-release-downloads", ".github/actions/cache-desktop-native",
];

function gitOutput(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
}

function treeEntries(root, ref, paths) {
  return gitOutput(root, ["ls-tree", "-r", ref, "--", ...paths]);
}

export function nativeBuildFingerprint(root = repositoryRoot, ref = "HEAD") {
  const hash = createHash("sha256").update(treeEntries(root, ref, nativeInputs));
  // Seam files group many TS and Rust changes together. Only native hunks
  // should schedule six native warmers for a Studio-only change.
  for (const entry of treeEntries(root, ref, ["omp-patch/patches"]).trim().split("\n")) {
    const path = entry.split("\t")[1];
    if (!path?.endsWith(".patch")) continue;
    const patch = gitOutput(root, ["show", `${ref}:${path}`]);
    for (const section of patch.split(/(?=^diff --git )/mu)) {
      if (/^diff --git a\/(?:crates\/|bazel\/|\.cargo\/|Cargo\.|MODULE\.bazel|BUILD\.bazel|\.bazel|rust-toolchain|scripts\/(?:bazel-natives|stamp-native-version|host-detect))/u.test(section)) hash.update(section);
    }
  }
  return hash.digest("hex");
}

function desktopBuildFingerprint(root, ref) {
  const lockfile = JSON.parse(gitOutput(root, ["show", `${ref}:package-lock.json`]));
  return dependencyFingerprint(lockfile) + treeEntries(root, ref, desktopInputs);
}

export function releaseWarmPlan(before, root = repositoryRoot, after = "HEAD") {
  if (!before || /^0+$/u.test(before)) return { native: true, desktop: true };
  return {
    native: nativeBuildFingerprint(root, before) !== nativeBuildFingerprint(root, after),
    desktop: desktopBuildFingerprint(root, before) !== desktopBuildFingerprint(root, after),
  };
}

export function releaseWarmMatrix({ native, desktop }) {
  return { include: releasePlan().release_matrix.include.filter(row => native || (desktop && row.desktop)).map(row => ({
    target: row.target, os: row.os,
    platform: row.target.split("-")[0], arch: row.target.split("-")[1],
    desktop: desktop && row.desktop, runtime: native,
  })) };
}

// npm ci still uses the complete lockfile. Only the download/native cache
// identity omits workspace versions, which change on every Studio release.
export function dependencyFingerprint(lockfile) {
  const external = Object.entries(lockfile.packages)
    .filter(([path, pkg]) => path.includes("node_modules/") && !pkg.link)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(external)).digest("hex");
}

/** A stale local install must not silently select an older Electron for a release package. */
export function assertLockedElectronVersion(root = repositoryRoot) {
  const expected = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages["node_modules/electron"].version;
  const installed = JSON.parse(readFileSync(join(root, "node_modules", "electron", "package.json"), "utf8")).version;
  if (installed !== expected) throw new Error(`Electron dependency is ${installed}; package-lock requires ${expected}. Run npm ci before packaging.`);
  return expected;
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
      // actions/cache versions include the literal path list. Keep workspace
      // paths relative so C:/a and D:/a runners can share the same archive.
      "packaging/installer-host/.cache",
    ].join("\n"),
  };
  writeCacheOutputs(outputs);
}

function writeCacheOutputs(outputs) {
  for (const [name, value] of Object.entries(outputs)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<OMP_RELEASE_CACHE\n${String(value).replaceAll("\\", "/")}\nOMP_RELEASE_CACHE\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  if (process.argv.includes("--warm-plan")) {
    const { before } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (before && !/^0+$/u.test(before)) gitOutput(repositoryRoot, ["fetch", "--no-tags", "--depth=1", "origin", before]);
    const plan = releaseWarmPlan(before);
    writeCacheOutputs({ ...plan, warm_matrix: JSON.stringify(releaseWarmMatrix(plan)) });
    console.log(`Warm native compilation: ${plan.native}; desktop tools: ${plan.desktop}`);
  } else {
    writeReleaseCacheOutputs();
  }
}
