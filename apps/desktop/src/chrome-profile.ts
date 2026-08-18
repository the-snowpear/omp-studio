/**
 * Renderer 请求的操作者头像读写（Main-only；preload 不得 import）。
 *
 * 固定命名通道 + 载荷校验，模式与 chrome-notify 相同。处理后的图片
 * 写入 `%APPDATA%\omp-studio\profile\`，不把路径回传给 Renderer。
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { app, ipcMain, type WebContents } from "electron";

import {
  CHROME_PROFILE_CHANNELS,
  parseAvatarSaveInput,
  type ChromeAvatarBytes,
} from "./chrome-profile-shared.js";
import {
  clearProfileAvatar,
  migrateProfileAvatar,
  readProfileAvatar,
  resolveLegacyInstallUserdataRoot,
  resolveProfilePersistRoot,
  writeProfileAvatar,
} from "./chrome-profile-store.js";

function userAppDataRoot(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
}

function persistRoot(): string {
  return resolveProfilePersistRoot(userAppDataRoot());
}

async function readyRoot(): Promise<string> {
  const root = persistRoot();
  await migrateProfileAvatar(root, [
    resolveLegacyInstallUserdataRoot({
      isPackaged: app.isPackaged,
      execPath: app.getPath("exe"),
      appPath: app.getAppPath(),
    }),
    app.getPath("userData"),
  ]);
  return root;
}

export function registerChromeProfileIpc(options: {
  readonly isTrustedSender: (sender: Pick<WebContents, "isDestroyed" | "getURL">) => boolean;
}): () => void {
  for (const channel of Object.values(CHROME_PROFILE_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle(CHROME_PROFILE_CHANNELS.saveAvatar, async (event, payload: unknown) => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) {
      return { ok: false, message: "不受信任的调用方。" };
    }
    const input = parseAvatarSaveInput(payload);
    if (input === undefined) return { ok: false, message: "头像数据无效。" };
    try {
      await writeProfileAvatar(await readyRoot(), input);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        return { ok: false, message: "无法写入头像文件（没有权限）。" };
      }
      throw error;
    }
    return { ok: true };
  });

  ipcMain.handle(CHROME_PROFILE_CHANNELS.loadAvatar, async (event): Promise<ChromeAvatarBytes | null> => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return null;
    return readProfileAvatar(await readyRoot());
  });

  ipcMain.handle(CHROME_PROFILE_CHANNELS.clearAvatar, async (event) => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return;
    await clearProfileAvatar(await readyRoot());
  });

  return () => {
    for (const channel of Object.values(CHROME_PROFILE_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
