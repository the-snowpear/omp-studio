// Downloads. The page asks GitHub for the latest release when it loads and
// falls back to the snapshot below, so the buttons always lead somewhere real.
// After a release, update SNAPSHOT so the offline fallback stays current.

export type Platform = "win-x64" | "win-arm64" | "mac-arm64" | "linux-x64" | "linux-x64-deb";

export interface Asset {
  platform: Platform;
  /** What the visitor reads on the button. */
  label: string;
  /** Hardware and system requirement, shown under the button. */
  requires: string;
  file: string;
  url: string;
  bytes: number;
}

export interface Release {
  version: string;
  date: string;
  page: string;
  assets: Asset[];
  /** True when the numbers came from GitHub just now rather than the snapshot. */
  live: boolean;
}

const REPO = "the-snowpear/omp-studio";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
/** The windowed workbench this site describes ships in this version. */
export const WORKBENCH_VERSION = "0.2.0";

const META: Record<Platform, { label: string; requires: string; match: RegExp }> = {
  "win-x64": { label: "Windows", requires: "Windows 10 或更新，x64", match: /Setup-.*windows-x64\.exe$/ },
  "win-arm64": { label: "Windows ARM", requires: "Windows 11，ARM64（骁龙等）", match: /Setup-.*windows-arm64\.exe$/ },
  "mac-arm64": { label: "macOS", requires: "macOS 13 或更新，Apple Silicon", match: /macos-arm64\.dmg$/ },
  "linux-x64": { label: "Linux · AppImage", requires: "x64，glibc 2.39+，FUSE 2", match: /^OMP-Studio-.*-linux-x64\.AppImage$/ },
  "linux-x64-deb": { label: "Linux · deb", requires: "Ubuntu 24.04+ / Debian 13+，x64", match: /^OMP-Studio-.*-linux-x64\.deb$/ },
};
export const PLATFORMS = Object.keys(META) as Platform[];

const snapshotAsset = (platform: Platform, file: string, bytes: number): Asset => ({
  platform,
  label: META[platform].label,
  requires: META[platform].requires,
  file,
  url: `${RELEASES_URL}/download/v0.1.17/${file}`,
  bytes,
});

const SNAPSHOT: Release = {
  version: "0.1.17",
  date: "2026-10-29",
  page: `${RELEASES_URL}/tag/v0.1.17`,
  live: false,
  assets: [
    snapshotAsset("win-x64", "OMP-Studio-Setup-0.1.17-windows-x64.exe", 221068034),
    snapshotAsset("win-arm64", "OMP-Studio-Setup-0.1.17-windows-arm64.exe", 209474548),
    snapshotAsset("mac-arm64", "OMP-Studio-0.1.17-macos-arm64.dmg", 252853023),
  ],
};

interface GithubRelease {
  tag_name: string;
  published_at: string;
  html_url: string;
  assets: { name: string; size: number; browser_download_url: string }[];
}

let pending: Promise<Release> | undefined;

/** Latest published release. Never rejects: any failure yields the snapshot. */
export function loadRelease(): Promise<Release> {
  pending ??= (async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return SNAPSHOT;
      const data = (await res.json()) as GithubRelease;
      const assets = PLATFORMS.flatMap((platform): Asset[] => {
        const hit = data.assets.find((a) => META[platform].match.test(a.name));
        return hit
          ? [{ platform, label: META[platform].label, requires: META[platform].requires, file: hit.name, url: hit.browser_download_url, bytes: hit.size }]
          : [];
      });
      if (!assets.length) return SNAPSHOT;
      return { version: data.tag_name.replace(/^v/, ""), date: data.published_at.slice(0, 10), page: data.html_url, assets, live: true };
    } catch {
      return SNAPSHOT;
    }
  })();
  return pending;
}

/** A matching installer; ARM Linux and mobile visitors choose from the available downloads. */
export async function detectPlatform(): Promise<Platform | null> {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad/.test(ua)) return null;
  const uaData = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> };
  }).userAgentData;
  if (/Linux/.test(ua)) {
    let architecture: string | undefined;
    try { architecture = (await uaData?.getHighEntropyValues(["architecture"]))?.architecture; } catch { /* Use an explicit x64 user agent when hints are unavailable. */ }
    if (architecture === "arm" || /aarch64|armv\d|arm64/iu.test(ua)) return null;
    if (architecture !== "x86" && !/x86_64|x64|amd64/iu.test(ua)) return null;
    return /Ubuntu|Debian/iu.test(ua) ? "linux-x64-deb" : "linux-x64";
  }
  if (/Windows/.test(ua)) {
    try {
      const { architecture } = (await uaData?.getHighEntropyValues(["architecture"])) ?? {};
      return architecture === "arm" ? "win-arm64" : "win-x64";
    } catch {
      return "win-x64";
    }
  }
  return /Macintosh/.test(ua) ? "mac-arm64" : null;
}

export const formatSize = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

/** True while the latest published installer predates the windowed workbench. */
export function predatesWorkbench(release: Release): boolean {
  const [a = 0, b = 0, c = 0] = release.version.split(".").map(Number);
  const [x = 0, y = 0, z = 0] = WORKBENCH_VERSION.split(".").map(Number);
  return a !== x ? a < x : b !== y ? b < y : c < z;
}

export const SOURCE_COMMANDS = [
  "git clone --recurse-submodules https://github.com/the-snowpear/omp-studio.git",
  "cd omp-studio",
  "npm install",
  "npm run omp:overlay:apply",
  "npm run preview",
];

export const MAC_QUARANTINE_COMMAND = 'xattr -dr com.apple.quarantine "/Applications/OMP Studio.app"';
