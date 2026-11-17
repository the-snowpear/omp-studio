import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readGitHubApi } from "./release-github.mjs";

export function obsoleteReleaseCaches(caches) {
  const newest = new Set();
  return [...caches].sort((a, b) => b.created_at.localeCompare(a.created_at)).filter(cache => {
    // Retired Cargo release caches are no longer read. Source-test caches have
    // different prefixes and remain owned by CI.
    if (cache.key.startsWith("v1-release-rust-") || cache.key.startsWith("desktop-tools-v1-")) return true;
    const family = /^(bazel-native-v1-(?:win32|linux|darwin)-(?:x64|arm64)-|(?:npm-v1|bun-v1|desktop-tools-v2|electron-native-v1)-(?:Windows|Linux|macOS)-(?:X64|ARM64)-)/u.exec(cache.key)?.[1];
    if (!family) return false;
    if (cache.ref !== "refs/heads/main") return true;
    if (newest.has(family)) return true;
    newest.add(family);
    return false;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Shared release caches are maintained on main only");
  const repo = process.env.GITHUB_REPOSITORY;
  const pages = JSON.parse(await readGitHubApi(["--paginate", "--slurp", `repos/${repo}/actions/caches?per_page=100`], { encoding: "utf8" }));
  const obsolete = obsoleteReleaseCaches(pages.flatMap(page => page.actions_caches));
  for (const cache of obsolete) {
    console.log(`Remove obsolete build cache: ${cache.key} (${cache.ref})`);
    execFileSync("gh", ["api", "--method", "DELETE", `repos/${repo}/actions/caches/${cache.id}`], { stdio: "inherit", windowsHide: true });
  }
  console.log(`Removed ${obsolete.length} obsolete release caches`);
}
