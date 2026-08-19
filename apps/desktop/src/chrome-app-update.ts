/**
 * Desktop-chrome 应用更新实现（GitHub Releases 全量安装包）。
 *
 * Electron-free 设计：`shell.openPath` / `app.quit` / `fetch` 等由调用方注入，
 * 纯业务逻辑与网络协议在 headless 测试中全覆盖。
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import {
  CHROME_APP_UPDATE_CHANNELS,
  parseChromeAppUpdateDownloadInput,
  parseChromeAppUpdateInstallInput,
  type AppUpdateInfo,
  type ChromeAppUpdateDownloadResult,
  type ChromeAppUpdateInstallResult,
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

export async function downloadInstallerFile(options: {
  readonly url: string;
  readonly targetDirectory: string;
  readonly fetcher?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
}): Promise<string> {
  const fetchFn = options.fetcher ?? globalThis.fetch;
  await mkdir(options.targetDirectory, { recursive: true });

  const urlObj = new URL(options.url);
  const rawFilename = basename(urlObj.pathname);
  const filename = rawFilename.length > 0 && rawFilename.endsWith(".exe") ? rawFilename : "OMP-Studio-Update-Setup.exe";
  const destinationPath = join(options.targetDirectory, filename);

  const res = await fetchFn(options.url, {
    headers: {
      "User-Agent": "OMP-Studio-Updater",
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败: HTTP ${res.status} ${res.statusText}`);
  }

  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  const fileStream = createWriteStream(destinationPath);
  await pipeline(nodeStream, fileStream);

  return destinationPath;
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
  readonly updatesDirectory: string;
  readonly fetcher?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  readonly openPath: (filePath: string) => Promise<string> | string;
  readonly quitApp?: (() => void) | undefined;
}

export interface ChromeAppUpdateIpcHandle {
  dispose(): void;
}

export function registerChromeAppUpdateIpc(options: ChromeAppUpdateIpcOptions): ChromeAppUpdateIpcHandle {
  const ipc = options.ipcMain;
  ipc.removeHandler(CHROME_APP_UPDATE_CHANNELS.check);
  ipc.removeHandler(CHROME_APP_UPDATE_CHANNELS.download);
  ipc.removeHandler(CHROME_APP_UPDATE_CHANNELS.install);

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

  ipc.handle(
    CHROME_APP_UPDATE_CHANNELS.download,
    async (event, payload): Promise<ChromeAppUpdateDownloadResult> => {
      if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
        return { ok: false, message: "Untrusted sender" };
      }
      const input = parseChromeAppUpdateDownloadInput(payload);
      if (input === undefined) {
        return { ok: false, message: "无效的下载地址" };
      }
      try {
        const filePath = await downloadInstallerFile({
          url: input.url,
          targetDirectory: options.updatesDirectory,
          ...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
        });
        return { ok: true, filePath };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipc.handle(
    CHROME_APP_UPDATE_CHANNELS.install,
    async (event, payload): Promise<ChromeAppUpdateInstallResult> => {
      if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
        return { ok: false, message: "Untrusted sender" };
      }
      const input = parseChromeAppUpdateInstallInput(payload);
      if (input === undefined) {
        return { ok: false, message: "无效的安装包路径" };
      }
      try {
        const openErr = await options.openPath(input.filePath);
        if (openErr && openErr.length > 0) {
          return { ok: false, message: openErr };
        }
        if (options.quitApp) {
          setTimeout(() => options.quitApp?.(), 1000);
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  return Object.freeze({
    dispose(): void {
      ipc.removeHandler(CHROME_APP_UPDATE_CHANNELS.check);
      ipc.removeHandler(CHROME_APP_UPDATE_CHANNELS.download);
      ipc.removeHandler(CHROME_APP_UPDATE_CHANNELS.install);
    },
  });
}
