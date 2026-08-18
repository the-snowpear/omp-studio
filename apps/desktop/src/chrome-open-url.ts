/**
 * Renderer 请求用系统默认浏览器打开 https 链接（Main-only；preload 不得 import）。
 *
 * Electron-free：`openExternal` 由调用方注入，headless 测试不必加载 Electron。
 * 固定命名通道 + 载荷校验，模式与 chrome-image 相同。
 */

import { CHROME_OPEN_URL_CHANNEL, parseChromeOpenUrlInput } from "./chrome-open-url-shared.js";

export interface ChromeOpenUrlSender {
  isDestroyed(): boolean;
  getURL(): string;
}

export interface ChromeOpenUrlIpcMain {
  handle(
    channel: string,
    listener: (event: { sender: ChromeOpenUrlSender }, payload?: unknown) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface ChromeOpenUrlIpcOptions {
  readonly ipcMain: ChromeOpenUrlIpcMain;
  readonly isTrustedSender: (sender: ChromeOpenUrlSender) => boolean;
  readonly openExternal: (url: string) => Promise<void> | void;
}

export interface ChromeOpenUrlIpcHandle {
  dispose(): void;
}

export function registerChromeOpenUrlIpc(options: ChromeOpenUrlIpcOptions): ChromeOpenUrlIpcHandle {
  const ipc = options.ipcMain;
  ipc.removeHandler(CHROME_OPEN_URL_CHANNEL);
  ipc.handle(CHROME_OPEN_URL_CHANNEL, async (event, payload): Promise<void> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return;
    const input = parseChromeOpenUrlInput(payload);
    if (input === undefined) return;
    await options.openExternal(input.url);
  });
  return Object.freeze({
    dispose(): void {
      ipc.removeHandler(CHROME_OPEN_URL_CHANNEL);
    },
  });
}
