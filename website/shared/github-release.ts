// What a GitHub release says about this site's installers, and nothing else.
// No imports and no runtime-only syntax, so the page bundle and the build step
// (tools/sync-release.mjs, plain Node) read the same file.

export type Platform = "win-x64" | "win-arm64" | "mac-arm64" | "linux-x64" | "linux-x64-deb";

export const REPO = "the-snowpear/omp-studio";

/** Which file in a release is the installer for each platform. The order is the order they are listed in. */
export const INSTALLER: Record<Platform, RegExp> = {
  "win-x64": /Setup-.*windows-x64\.exe$/,
  "win-arm64": /Setup-.*windows-arm64\.exe$/,
  "mac-arm64": /macos-arm64\.dmg$/,
  "linux-x64": /^OMP-Studio-.*-linux-x64\.AppImage$/,
  "linux-x64-deb": /^OMP-Studio-.*-linux-x64\.deb$/,
};

/** The part of a release that changes with each publish; kept in the snapshot file and in the visitor's cache. */
export interface StoredRelease {
  version: string;
  /** ISO time from GitHub. Shown in the visitor's own time zone. */
  published: string;
  page: string;
  assets: { platform: Platform; file: string; url: string; bytes: number }[];
}

export interface GithubRelease {
  tag_name: string;
  published_at: string;
  html_url: string;
  assets: { name: string; size: number; browser_download_url: string }[];
}

/** Null when the release carries none of the installers. */
export function fromGithub(data: GithubRelease): StoredRelease | null {
  const assets = (Object.keys(INSTALLER) as Platform[]).flatMap((platform) => {
    const hit = data.assets.find((a) => INSTALLER[platform].test(a.name));
    return hit ? [{ platform, file: hit.name, url: hit.browser_download_url, bytes: hit.size }] : [];
  });
  return assets.length ? { version: data.tag_name.replace(/^v/, ""), published: data.published_at, page: data.html_url, assets } : null;
}
