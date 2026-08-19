/**
 * Renderer 请求打开 Host 日志目录或导出近期日志（Main-only；preload 不得 import）。
 *
 * Electron-free：目录打开 / 另存为 / 读盘由调用方注入，headless 测试不必加载 Electron。
 */

import {
  CHROME_LOGS_CHANNELS,
  composeHostLogExport,
  isHostLogBasename,
  parseChromeLogsPayload,
  type ChromeLogsResult,
} from "./chrome-logs-shared.js";

export interface ChromeLogsSender {
  isDestroyed(): boolean;
  getURL(): string;
}

export interface ChromeLogsIpcMain {
  handle(
    channel: string,
    listener: (event: { sender: ChromeLogsSender }, payload?: unknown) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface ChromeLogsActions {
  readonly logsDirectory: string;
  mkdirLogs(): Promise<void>;
  openDirectory(): Promise<string>;
  listBasenames(): Promise<readonly string[]>;
  readFile(basename: string): Promise<string>;
  showSaveDialog(
    sender: ChromeLogsSender,
    options: { readonly defaultPath: string },
  ): Promise<{ readonly canceled: boolean; readonly filePath?: string }>;
  writeFile(filePath: string, text: string): Promise<void>;
}

export interface ChromeLogsIpcOptions {
  readonly ipcMain: ChromeLogsIpcMain;
  readonly isTrustedSender: (sender: ChromeLogsSender) => boolean;
  readonly actions: ChromeLogsActions;
}

export interface ChromeLogsIpcHandle {
  dispose(): void;
}

function fail(message: string): ChromeLogsResult {
  return { ok: false, message };
}

function deny(options: ChromeLogsIpcOptions, sender: ChromeLogsSender): ChromeLogsResult | undefined {
  if (sender.isDestroyed() || !options.isTrustedSender(sender)) {
    return fail("不受信任的调用方。");
  }
  return undefined;
}

export function registerChromeLogsIpc(options: ChromeLogsIpcOptions): ChromeLogsIpcHandle {
  const ipc = options.ipcMain;

  ipc.removeHandler(CHROME_LOGS_CHANNELS.openDir);
  ipc.removeHandler(CHROME_LOGS_CHANNELS.exportLogs);

  ipc.handle(CHROME_LOGS_CHANNELS.openDir, async (event, payload): Promise<ChromeLogsResult> => {
    const denied = deny(options, event.sender);
    if (denied) return denied;
    if (!parseChromeLogsPayload(payload)) return fail("请求无效。");
    try {
      await options.actions.mkdirLogs();
      const error = await options.actions.openDirectory();
      if (error.length > 0) return fail("无法打开日志目录。");
      return { ok: true };
    } catch {
      return fail("无法打开日志目录。");
    }
  });

  ipc.handle(CHROME_LOGS_CHANNELS.exportLogs, async (event, payload): Promise<ChromeLogsResult> => {
    const denied = deny(options, event.sender);
    if (denied) return denied;
    if (!parseChromeLogsPayload(payload)) return fail("请求无效。");
    try {
      await options.actions.mkdirLogs();
      const names = (await options.actions.listBasenames()).filter(isHostLogBasename).sort();
      const recent = names.slice(-7);
      const files: Array<{ name: string; text: string }> = [];
      for (const name of recent) {
        try {
          files.push({ name, text: await options.actions.readFile(name) });
        } catch {
          // Skip a missing day; export the rest.
        }
      }
      const text = composeHostLogExport(files);
      if (text.trim().length === 0) return fail("没有可导出的日志。");
      const day = new Date().toISOString().slice(0, 10);
      const picked = await options.actions.showSaveDialog(event.sender, {
        defaultPath: `omp-studio-host-logs-${day}.txt`,
      });
      if (picked.canceled || picked.filePath === undefined || picked.filePath.length === 0) {
        return { ok: false, cancelled: true };
      }
      await options.actions.writeFile(picked.filePath, text);
      return { ok: true };
    } catch {
      return fail("导出失败。");
    }
  });

  return Object.freeze({
    dispose(): void {
      ipc.removeHandler(CHROME_LOGS_CHANNELS.openDir);
      ipc.removeHandler(CHROME_LOGS_CHANNELS.exportLogs);
    },
  });
}
