/**
 * Renderer 请求一次进程内存采样（Main-only；preload 不得 import）。
 *
 * Electron-free：`app.getAppMetrics()` 由调用方注入，headless 测试不必加载 Electron。
 * 投影逻辑（去掉 pid / 路径、按工作集排序）在 `chrome-metrics-shared.ts` 里，
 * preload 与测试共用。
 */

import {
  CHROME_METRICS_CHANNELS,
  parseChromeMetricsPayload,
  projectProcessMemory,
  type ProcessMemorySample,
} from "./chrome-metrics-shared.js";

export interface ChromeMetricsSender {
  isDestroyed(): boolean;
  getURL(): string;
}

export interface ChromeMetricsIpcMain {
  handle(
    channel: string,
    listener: (event: { sender: ChromeMetricsSender }, payload?: unknown) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface ChromeMetricsActions {
  /** `app.getAppMetrics()`。返回值只被投影，不会原样外传。 */
  appMetrics(): ReadonlyArray<{
    readonly type?: unknown;
    readonly memory?: { readonly workingSetSize?: unknown; readonly peakWorkingSetSize?: unknown };
  }>;
  now(): Date;
}

export interface ChromeMetricsIpcOptions {
  readonly ipcMain: ChromeMetricsIpcMain;
  readonly isTrustedSender: (sender: ChromeMetricsSender) => boolean;
  readonly actions: ChromeMetricsActions;
}

export interface ChromeMetricsIpcHandle {
  dispose(): void;
}

export function registerChromeMetricsIpc(options: ChromeMetricsIpcOptions): ChromeMetricsIpcHandle {
  options.ipcMain.handle(CHROME_METRICS_CHANNELS.sample, (event, payload): ProcessMemorySample | null => {
    const sender = event.sender;
    // 与其余 chrome 面一致：不受信任的调用方或畸形载荷一律返回 null，不抛。
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) return null;
    if (!parseChromeMetricsPayload(payload)) return null;
    try {
      return projectProcessMemory(options.actions.appMetrics(), options.actions.now().toISOString());
    } catch {
      return null;
    }
  });
  return {
    dispose() {
      options.ipcMain.removeHandler(CHROME_METRICS_CHANNELS.sample);
    },
  };
}
