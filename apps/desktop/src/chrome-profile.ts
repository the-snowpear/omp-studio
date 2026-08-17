/**
 * Renderer 请求的操作者头像读写（Main-only；preload 不得 import）。
 *
 * 固定命名通道 + 载荷校验，模式与 chrome-notify 相同。处理后的图片
 * 写入安装目录旁的 `userdata/profile/`，不把路径回传给 Renderer。
 */

import { app, ipcMain, type WebContents } from "electron";

import {
  CHROME_PROFILE_CHANNELS,
  parseAvatarSaveInput,
  type ChromeAvatarBytes,
} from "./chrome-profile-shared.js";
import {
  clearProfileAvatar,
  readProfileAvatar,
  resolveProfilePersistRoot,
  writeProfileAvatar,
} from "./chrome-profile-store.js";

function persistRoot(): string {
  return resolveProfilePersistRoot({
    isPackaged: app.isPackaged,
    execPath: app.getPath("exe"),
    appPath: app.getAppPath(),
  });
}

/** 若安装目录还没有头像，把上一版写在 Electron userData/profile 的文件迁过来。 */
async function migrateLegacyAvatar(root: string): Promise<void> {
  if (await readProfileAvatar(root) !== null) return;
  const legacy = await readProfileAvatar(app.getPath("userData"));
  if (legacy === null) return;
  await writeProfileAvatar(root, legacy);
  await clearProfileAvatar(app.getPath("userData"));
}

async function readyRoot(): Promise<string> {
  const root = persistRoot();
  await migrateLegacyAvatar(root);
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
        return { ok: false, message: "无法写入安装目录下的头像文件（没有权限）。" };
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
