/**
 * Release facts and download routing, shared by all three concepts.
 * The snapshot below is v0.1.17 as published on GitHub; `loadRelease()` refreshes it
 * from the API at runtime and silently keeps the snapshot when that fails (rate limit,
 * offline), so download buttons are real links either way.
 */
export type Platform = "win-x64" | "win-arm64" | "mac-arm64";
export type Asset = { platform: Platform; label: string; detail: string; file: string; url: string; bytes: number };
export type Release = { version: string; publishedAt: string; assets: Asset[]; notesUrl: string; stars: number | null };

const REPO = "the-snowpear/omp-studio";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;
export const DOCS_URL = `${REPO_URL}/blob/main/docs/README.md`;
export const SOURCE_URL = `${REPO_URL}/blob/main/docs/getting-started.md`;
export const UPSTREAM_URL = "https://github.com/can1357/oh-my-pi";

const META: Record<Platform, { label: string; detail: string; match: RegExp }> = {
  "win-x64": { label: "Windows x64", detail: "Intel 或 AMD 处理器", match: /^OMP-Studio-Setup-.*-windows-x64\.exe$/ },
  "win-arm64": { label: "Windows ARM64", detail: "Windows on Arm", match: /^OMP-Studio-Setup-.*-windows-arm64\.exe$/ },
  "mac-arm64": { label: "macOS Apple Silicon", detail: "M 系列芯片, macOS 13+", match: /^OMP-Studio-.*-macos-arm64\.dmg$/ },
};
const ORDER: Platform[] = ["win-x64", "win-arm64", "mac-arm64"];

const asset = (platform: Platform, file: string, bytes: number, version = "0.1.17"): Asset => ({
  platform,
  label: META[platform].label,
  detail: META[platform].detail,
  file,
  bytes,
  url: `${REPO_URL}/releases/download/v${version}/${file}`,
});

export const SNAPSHOT: Release = {
  version: "0.1.17",
  publishedAt: "2026-10-29",
  notesUrl: `${REPO_URL}/releases/tag/v0.1.17`,
  stars: null,
  assets: [
    asset("win-x64", "OMP-Studio-Setup-0.1.17-windows-x64.exe", 221068034),
    asset("win-arm64", "OMP-Studio-Setup-0.1.17-windows-arm64.exe", 209474548),
    asset("mac-arm64", "OMP-Studio-0.1.17-macos-arm64.dmg", 252853023),
  ],
};

/** Honest install caveats; show them next to the download, not in fine print elsewhere. */
export const INSTALL_NOTES: Record<"win" | "mac", string> = {
  win: "安装包暂无 Authenticode 签名，SmartScreen 可能提示，选择「仍要运行」即可。Runtime 与更新清单用 Ed25519 验签。",
  mac: "ad hoc 签名，尚未经 Apple 公证。首次打开被拦截时，到「系统设置 › 隐私与安全性」选择「仍要打开」。",
};

export const formatSize = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`;

/** Best guess for this visitor. null: no desktop build for this device (Linux, phones). */
export async function detectPlatform(): Promise<Platform | null> {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; mobile?: boolean; getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> };
  };
  const ua = navigator.userAgent;
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(ua)) return null;
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
  if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) {
    // There is no Intel Mac build, and every Mac UA says "Intel". Ask the browser, then the GPU.
    try {
      const hints = await nav.userAgentData?.getHighEntropyValues?.(["architecture"]);
      if (hints?.architecture === "x86") return null;
    } catch {
      /* fall through to the GPU check */
    }
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && info && /Intel|AMD|Radeon/i.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)))) return null;
    return "mac-arm64";
  }
  if (/Win/i.test(platform) || /Windows/i.test(ua)) {
    if (/ARM64|aarch64/i.test(ua)) return "win-arm64";
    try {
      const hints = await nav.userAgentData?.getHighEntropyValues?.(["architecture"]);
      if (hints?.architecture === "arm") return "win-arm64";
    } catch {
      /* hint refused: x64 is the common case */
    }
    return "win-x64";
  }
  return null;
}

export async function loadRelease(): Promise<Release> {
  try {
    const [rel, repo] = await Promise.all([
      fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } }),
      fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: "application/vnd.github+json" } }),
    ]);
    if (!rel.ok) return SNAPSHOT;
    const data = (await rel.json()) as { tag_name: string; published_at: string; html_url: string; assets: { name: string; size: number; browser_download_url: string }[] };
    const assets = ORDER.flatMap((platform): Asset[] => {
      const hit = data.assets.find((a) => META[platform].match.test(a.name));
      return hit ? [{ platform, label: META[platform].label, detail: META[platform].detail, file: hit.name, url: hit.browser_download_url, bytes: hit.size }] : [];
    });
    if (assets.length === 0) return SNAPSHOT;
    const stars = repo.ok ? ((await repo.json()) as { stargazers_count: number }).stargazers_count : null;
    return { version: data.tag_name.replace(/^v/, ""), publishedAt: data.published_at.slice(0, 10), notesUrl: data.html_url, assets, stars };
  } catch {
    return SNAPSHOT;
  }
}
