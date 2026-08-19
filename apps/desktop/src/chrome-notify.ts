/**
 * Renderer 请求的系统通知（Main-only；preload 不得 import）。
 *
 * 固定命名通道 + 载荷校验，模式与 titlebar-overlay 相同。仅展示
 * Renderer 组装好的固定文案，不读取文件系统 / Host 状态。
 */

import { Notification, ipcMain, type WebContents } from "electron";

import { CHROME_NOTIFY_CHANNEL, parseChromeNotifyInput } from "./chrome-notify-shared.js";

export function registerChromeNotifyIpc(options: {
  readonly isTrustedSender: (sender: Pick<WebContents, "isDestroyed" | "getURL">) => boolean;
}): () => void {
  ipcMain.removeHandler(CHROME_NOTIFY_CHANNEL);
  ipcMain.handle(CHROME_NOTIFY_CHANNEL, (event, payload: unknown) => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return;
    const input = parseChromeNotifyInput(payload);
    if (input === undefined) return;
    if (!Notification.isSupported()) return;
    new Notification({
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
    }).show();
  });
  return () => {
    ipcMain.removeHandler(CHROME_NOTIFY_CHANNEL);
  };
}
