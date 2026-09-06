/**
 * Desktop-chrome 应用更新实现（GitHub Releases 只读兼容检查）。
 *
 * Electron-free 设计，保留旧只读检查；下载和执行统一使用签名更新通道。
 */

import {
  CHROME_APP_UPDATE_CHANNELS,
  RETIRED_APP_UPDATE_CHANNELS,
  type AppUpdateInfo,
} from "./chrome-app-update-shared.js";

export const DEFAULT_GITHUB_REPO = "the-snowpear/omp-studio";

export interface SemverVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string | undefined;
}

export function parseSemver(raw: string): SemverVersion | undefined {
  const clean = raw.trim().replace(/^v/iu, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(clean);
  if (!match) return undefined;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    ...(match[4] !== undefined ? { prerelease: match[4] } : {}),
  };
}

/**
 * 比较两个语义化版本号。
 * 返回值：> 0 表示 a > b，< 0 表示 a < b，0 表示相等。
 */
export function compareSemver(aStr: string, bStr: string): number {
  const a = parseSemver(aStr);
  const b = parseSemver(bStr);
  if (!a || !b) {
    return aStr.localeCompare(bStr, undefined, { numeric: true, sensitivity: "base" });
  }
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === undefined && b.prerelease !== undefined) return 1;
  if (a.prerelease !== undefined && b.prerelease === undefined) return -1;
  if (a.prerelease !== undefined && b.prerelease !== undefined) {
    return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
  }
  return 0;
}

export interface GitHubReleaseAsset {
  readonly name?: string | undefined;
  readonly browser_download_url?: string | undefined;
  readonly size?: number | undefined;
}

export interface GitHubReleaseResponse {
  readonly tag_name?: string | undefined;
  readonly name?: string | undefined;
  readonly body?: string | undefined;
  readonly html_url?: string | undefined;
  readonly published_at?: string | undefined;
  readonly draft?: boolean | undefined;
  readonly prerelease?: boolean | undefined;
  readonly assets?: readonly GitHubReleaseAsset[] | undefined;
}

export function findWindowsInstallerAsset(
  assets: readonly GitHubReleaseAsset[] = [],
): { name: string; downloadUrl: string; size?: number | undefined } | undefined {
  const exeAssets = assets.filter((asset) => {
    if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") return false;
    return asset.name.toLowerCase().endsWith(".exe");
  });
  if (exeAssets.length === 0) return undefined;

  // 优先匹配 OMP-Studio-Setup 或 Setup
  const setupAsset =
    exeAssets.find((a) => /setup/iu.test(a.name!)) ??
    exeAssets.find((a) => /omp/iu.test(a.name!)) ??
    exeAssets[0]!;

  return {
    name: setupAsset.name!,
    downloadUrl: setupAsset.browser_download_url!,
    ...(typeof setupAsset.size === "number" ? { size: setupAsset.size } : {}),
  };
}

export async function checkGitHubReleaseUpdate(options: {
  readonly repo?: string | undefined;
  readonly currentVersion: string;
  readonly fetcher?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<AppUpdateInfo> {
  const repo = options.repo ?? DEFAULT_GITHUB_REPO;
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const fetchFn = options.fetcher ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `OMP-Studio/${options.currentVersion}`,
      },
    });
    if (!res.ok) {
      return {
        available: false,
        currentVersion: options.currentVersion,
      };
    }
    const data = (await res.json()) as GitHubReleaseResponse;
    if (typeof data.tag_name !== "string") {
      return {
        available: false,
        currentVersion: options.currentVersion,
      };
    }

    const latestVersion = data.tag_name.replace(/^v/iu, "").trim();
    const hasUpdate = compareSemver(latestVersion, options.currentVersion) > 0;
    const asset = findWindowsInstallerAsset(data.assets ?? []);

    return {
      available: hasUpdate,
      currentVersion: options.currentVersion,
      version: latestVersion,
      name: data.name ?? `OMP Studio ${latestVersion}`,
      releaseNotes: data.body ?? "",
      publishedAt: data.published_at,
      htmlUrl: data.html_url,
      ...(asset !== undefined
        ? {
            downloadUrl: asset.downloadUrl,
            assetName: asset.name,
            assetSize: asset.size,
          }
        : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ChromeAppUpdateSender {
  isDestroyed(): boolean;
  getURL(): string;
}

export interface ChromeAppUpdateIpcMain {
  handle(
    channel: string,
    listener: (event: { sender: ChromeAppUpdateSender }, payload?: unknown) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface ChromeAppUpdateIpcOptions {
  readonly ipcMain: ChromeAppUpdateIpcMain;
  readonly isTrustedSender: (sender: ChromeAppUpdateSender) => boolean;
  readonly currentVersion: string;
  readonly repo?: string | undefined;
  readonly fetcher?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
}

export interface ChromeAppUpdateIpcHandle {
  dispose(): void;
}

export function registerChromeAppUpdateIpc(options: ChromeAppUpdateIpcOptions): ChromeAppUpdateIpcHandle {
  const ipc = options.ipcMain;
  ipc.removeHandler(CHROME_APP_UPDATE_CHANNELS.check);
  for (const channel of RETIRED_APP_UPDATE_CHANNELS) ipc.removeHandler(channel);

  ipc.handle(CHROME_APP_UPDATE_CHANNELS.check, async (event): Promise<AppUpdateInfo | null> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return null;
    try {
      return await checkGitHubReleaseUpdate({
        ...(options.repo !== undefined ? { repo: options.repo } : {}),
        currentVersion: options.currentVersion,
        ...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
      });
    } catch {
      return {
        available: false,
        currentVersion: options.currentVersion,
      };
    }
  });

  return Object.freeze({
    dispose(): void {
      ipc.removeHandler(CHROME_APP_UPDATE_CHANNELS.check);
    },
  });
}
