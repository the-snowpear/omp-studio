// Downloads. Nothing here is edited for a release.
//  - release.snapshot.json is rewritten from GitHub on every `npm run build`
//    (tools/sync-release.mjs); it is what shows first and what stays if GitHub
//    can't be reached from the visitor's network.
//  - On load the page asks GitHub for the latest release, keeps the answer for
//    half an hour so reloads and shared networks don't hit the anonymous rate
//    limit, and swaps it in only if it differs from what is already on screen.
import { REPO, fromGithub, type GithubRelease, type Platform, type StoredRelease } from "./github-release";
import snapshotFile from "./release.snapshot.json";

export type { Platform };

export interface Asset {
  platform: Platform;
  /** What the visitor reads on the button. */
  label: string;
  /** The operating system's group in the list, and this package's name inside it. */
  os: "Windows" | "macOS" | "Linux";
  variant: string;
  /** Hardware and system requirement, shown under the button. */
  requires: string;
  file: string;
  url: string;
  bytes: number;
}

export interface Release {
  version: string;
  /** ISO time; format it with formatDate. */
  published: string;
  page: string;
  assets: Asset[];
}

const ABOUT: Record<Platform, Pick<Asset, "label" | "os" | "variant" | "requires">> = {
  "win-x64": { label: "Windows", os: "Windows", variant: "x64", requires: "Windows 10 或更新" },
  "win-arm64": { label: "Windows ARM", os: "Windows", variant: "ARM64", requires: "Windows 11，骁龙等 ARM 机型" },
  "mac-arm64": { label: "macOS", os: "macOS", variant: "Apple Silicon", requires: "macOS 13 或更新" },
  "linux-x64": { label: "Linux AppImage", os: "Linux", variant: "AppImage", requires: "x64（AVX2），glibc 2.39+，FUSE 2" },
  "linux-x64-deb": { label: "Linux deb", os: "Linux", variant: "deb", requires: "Ubuntu 24.04+ / Debian 13+，x64（AVX2）" },
};

/** The stored numbers plus the wording that belongs to this site, so copy edits apply to old snapshots and caches too. */
const describe = (stored: StoredRelease): Release => ({
  ...stored,
  assets: stored.assets.map((a) => ({ ...ABOUT[a.platform], ...a })),
});

const SNAPSHOT = snapshotFile as StoredRelease;

const CACHE_KEY = "omp-site-release-1";
const FRESH_MS = 30 * 60_000;

interface Cached {
  at: number;
  release: StoredRelease;
}

/** The last answer from GitHub, unless this build already carries a newer release. */
function cached(): Cached | null {
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Cached | null;
    return hit && Date.parse(hit.release.published) >= Date.parse(SNAPSHOT.published) ? hit : null;
  } catch {
    return null;
  }
}

/** The newest release known without waiting for the network. */
export const knownRelease = (): Release => describe(cached()?.release ?? SNAPSHOT);

let pending: Promise<Release | null> | undefined;

/** The latest published release, or null when GitHub can't be reached (the caller keeps what it already shows). */
export function loadRelease(): Promise<Release | null> {
  pending ??= (async () => {
    const hit = cached();
    if (hit && Date.now() - hit.at < FRESH_MS) return describe(hit.release);
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const release = fromGithub((await res.json()) as GithubRelease);
      if (!release) return null;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release } satisfies Cached)); } catch { /* Private mode or a full store: just don't cache. */ }
      return describe(release);
    } catch {
      return null;
    }
  })();
  return pending;
}

/** YYYY-MM-DD in the visitor's own time zone. */
export function formatDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

export const SOURCE_COMMANDS = [
  "git clone --recurse-submodules https://github.com/the-snowpear/omp-studio.git",
  "cd omp-studio",
  "npm install",
  "npm run omp:overlay:apply",
  "npm run preview",
];

export const MAC_QUARANTINE_COMMAND = 'xattr -dr com.apple.quarantine "/Applications/OMP Studio.app"';
