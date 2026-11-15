/**
 * Renderer 请求的图片复制 / 另存为（Main-only；preload 不得 import）。
 *
 * Electron-free：clipboard / 另存为对话框 / 写盘由调用方注入，headless
 * 测试不必加载 Electron。固定命名通道 + 载荷校验，模式与 workspace-shell 相同。
 */

import {
  CHROME_IMAGE_CHANNELS,
  parseChromeImageInput,
  type ChromeImageMime,
  type ChromeImageResult,
} from "./chrome-image-shared.js";
import { desktopText } from "./desktop-language-shared.js";

export interface ChromeImageSender {
  isDestroyed(): boolean;
  getURL(): string;
}

export interface ChromeImageIpcMain {
  handle(
    channel: string,
    listener: (event: { sender: ChromeImageSender }, payload?: unknown) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface ChromeImageSaveDialogOptions {
  readonly defaultPath: string;
  readonly filters: ReadonlyArray<{ readonly name: string; readonly extensions: readonly string[] }>;
}

export interface ChromeImageActions {
  copyImageToClipboard(bytes: Uint8Array): boolean | Promise<boolean>;
  showSaveDialog(
    sender: ChromeImageSender,
    options: ChromeImageSaveDialogOptions,
  ): Promise<{ readonly canceled: boolean; readonly filePath?: string }>;
  writeFile(filePath: string, bytes: Uint8Array): Promise<void>;
}

export interface ChromeImageIpcOptions {
  readonly ipcMain: ChromeImageIpcMain;
  readonly isTrustedSender: (sender: ChromeImageSender) => boolean;
  readonly actions: ChromeImageActions;
}

export interface ChromeImageIpcHandle {
  dispose(): void;
}

function saveFilters(mime: ChromeImageMime): ChromeImageSaveDialogOptions["filters"] {
  if (mime === "image/jpeg") return [{ name: desktopText("JPEG 图片", "JPEG Image"), extensions: ["jpg", "jpeg"] }];
  if (mime === "image/gif") return [{ name: desktopText("GIF 图片", "GIF Image"), extensions: ["gif"] }];
  if (mime === "image/webp") return [{ name: desktopText("WebP 图片", "WebP Image"), extensions: ["webp"] }];
  if (mime === "image/svg+xml") return [{ name: desktopText("SVG 图片", "SVG Image"), extensions: ["svg"] }];
  return [{ name: desktopText("PNG 图片", "PNG Image"), extensions: ["png"] }];
}

function fail(message: string): ChromeImageResult {
  return { ok: false, message };
}

export function registerChromeImageIpc(options: ChromeImageIpcOptions): ChromeImageIpcHandle {
  const ipc = options.ipcMain;

  function deny(sender: ChromeImageSender): ChromeImageResult | undefined {
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) {
      return fail(desktopText("不受信任的调用方。", "Untrusted caller."));
    }
    return undefined;
  }

  ipc.removeHandler(CHROME_IMAGE_CHANNELS.copyImage);
  ipc.removeHandler(CHROME_IMAGE_CHANNELS.saveImage);

  ipc.handle(CHROME_IMAGE_CHANNELS.copyImage, async (event, payload): Promise<ChromeImageResult> => {
    const denied = deny(event.sender);
    if (denied) return denied;
    const input = parseChromeImageInput(payload);
    if (input === undefined) return fail(desktopText("图片数据无效。", "Invalid image data."));
    const copied = await options.actions.copyImageToClipboard(input.bytes);
    if (!copied) return fail(desktopText("无法把这张图片写入剪贴板。", "Could not copy this image to the clipboard."));
    return { ok: true };
  });

  ipc.handle(CHROME_IMAGE_CHANNELS.saveImage, async (event, payload): Promise<ChromeImageResult> => {
    const denied = deny(event.sender);
    if (denied) return denied;
    const input = parseChromeImageInput(payload);
    if (input === undefined) return fail(desktopText("图片数据无效。", "Invalid image data."));
    const picked = await options.actions.showSaveDialog(event.sender, {
      defaultPath: input.suggestedName,
      filters: saveFilters(input.mime),
    });
    const filePath = picked.filePath?.trim() ?? "";
    if (picked.canceled || filePath.length === 0) return { ok: false, cancelled: true };
    try {
      await options.actions.writeFile(filePath, input.bytes);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") return fail(desktopText("没有权限写入所选位置。", "Permission denied writing to the selected location."));
      return fail(desktopText("保存图片失败。", "Failed to save image."));
    }
    return { ok: true };
  });

  return Object.freeze({
    dispose(): void {
      ipc.removeHandler(CHROME_IMAGE_CHANNELS.copyImage);
      ipc.removeHandler(CHROME_IMAGE_CHANNELS.saveImage);
    },
  });
}
