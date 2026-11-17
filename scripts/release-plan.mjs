import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseNotePlatforms } from "./release-assets.mjs";
import { readGitHubApi } from "./release-github.mjs";

const runners = [
  { target: "win32-x64", os: "windows-latest" },
  { target: "win32-arm64", os: "windows-11-arm" },
  { target: "linux-x64", os: "ubuntu-24.04" },
  { target: "linux-arm64", os: "ubuntu-24.04-arm" },
  { target: "darwin-x64", os: "macos-15-intel" },
  { target: "darwin-arm64", os: "macos-15" },
];

export function releasePlan({ kind = "desktop", arch = "both", includeMacos = false, includeLinux = true, platforms } = {}) {
  const desktop = kind === "desktop";
  const windows = runners.filter(row => row.target.startsWith("win32-") && (desktop || arch === "both" || row.target.endsWith(`-${arch}`)));
  const linux = desktop || includeLinux ? runners.filter(row => row.target === "linux-x64") : [];
  const desktopPlatforms = [...windows.map(row => row.target), ...(desktop || includeMacos ? ["darwin-arm64"] : []), ...linux.map(row => row.target)];
  const targets = platforms && platforms !== "all" ? platforms.split(",")
    : kind === "desktop" ? runners.map(row => row.target)
    : desktopPlatforms;
  return {
    kind,
    matrix: { include: windows.map(row => ({ arch: row.target.slice(6), os: row.os })) },
    linux_matrix: { include: linux.map(row => ({ ...row, arch: "x64" })) },
    desktop_platforms: desktopPlatforms.join(","),
    runtime_platforms: targets.join(","),
    runtime_matrix: { include: runners.filter(row => targets.includes(row.target)) },
    release_matrix: { include: runners.filter(row => targets.includes(row.target)).map(row => ({
      ...row, desktop: desktopPlatforms.includes(row.target),
    })) },
  };
}

export async function checkReleaseAvailable({ kind, version, channel = "stable", refType, refName, repo }, readApi = readGitHubApi) {
  const tag = kind === "desktop" ? `v${version}` : refType === "tag" ? refName : undefined;
  if (kind === "desktop" && (channel !== "stable" || version.includes("-"))) throw new Error("Desktop releases must be stable");
  if (tag && refType === "tag" && refName !== tag) throw new Error("Release tag mismatch");
  if (!tag) return;
  const pages = JSON.parse(await readApi(["--paginate", "--slurp", `repos/${repo}/releases?per_page=100`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  if (pages.flat().some(release => release.tag_name === tag && !release.draft)) throw new Error(`Refusing to overwrite published release ${tag}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const includeMacos = process.env.INCLUDE_MACOS === "true";
  const includeLinux = process.env.INCLUDE_LINUX !== "false";
  const plan = releasePlan({ kind: process.env.REQUEST_KIND || "desktop", arch: process.env.TARGET_ARCH || "both", includeMacos, includeLinux, platforms: process.env.RUNTIME_PLATFORMS });
  // Runtime preparation/cache warming also uses this CLI, without desktop publication.
  if (process.env.CHECK_RELEASE === "true") {
    const root = join(import.meta.dirname, "..");
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    await checkReleaseAvailable({ kind: plan.kind, version, channel: process.env.RUNTIME_CHANNEL || "stable", refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME, repo: process.env.GITHUB_REPOSITORY });
    if (plan.kind === "desktop") {
      let notes;
      try { notes = readFileSync(join(root, "docs", "releases", `v${version}.md`), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (notes !== undefined) {
        const platforms = plan.desktop_platforms.split(",");
        assertReleaseNotePlatforms(notes, process.env.GITHUB_REPOSITORY, `v${version}`, version, platforms);
      }
    }
  }
  for (const [name, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}
