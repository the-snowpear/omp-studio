/**
 * 把处理后的头像写进安装目录旁的 `userdata/profile/`，不经过 Host / Studio Bridge。
 * 可注入目录与 fs，供无 Electron 的单测使用。
 *
 * 打包后路径：{安装目录}/userdata/profile/avatar.jpg
 * 该目录不在 NSIS 安装清单里，升级时由 customRemoveFiles 保留。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type AvatarMime,
  type ChromeAvatarBytes,
  isAvatarMime,
} from "./chrome-profile-shared.js";

export const INSTALL_USERDATA_DIR_NAME = "userdata";
export const PROFILE_DIR_NAME = "profile";
export const AVATAR_FILE_STEM = "avatar";

const EXT: Record<AvatarMime, string> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/png": "png",
};

const MIME_BY_EXT: Record<string, AvatarMime> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  png: "image/png",
};

/** 安装包旁的可写根目录。打包后是 exe 所在目录下的 userdata，开发态是 desktop 应用根下的 userdata。 */
export function resolveProfilePersistRoot(input: {
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly appPath: string;
}): string {
  const base = input.isPackaged ? path.dirname(input.execPath) : input.appPath;
  return path.join(base, INSTALL_USERDATA_DIR_NAME);
}

export function profileDirectory(persistRoot: string): string {
  return path.join(persistRoot, PROFILE_DIR_NAME);
}

function avatarPath(persistRoot: string, mime: AvatarMime): string {
  return path.join(profileDirectory(persistRoot), `${AVATAR_FILE_STEM}.${EXT[mime]}`);
}

export async function writeProfileAvatar(
  persistRoot: string,
  avatar: ChromeAvatarBytes,
): Promise<void> {
  const dir = profileDirectory(persistRoot);
  await fs.mkdir(dir, { recursive: true });
  await clearProfileAvatar(persistRoot);
  await fs.writeFile(avatarPath(persistRoot, avatar.mime), avatar.bytes);
}

export async function readProfileAvatar(persistRoot: string): Promise<ChromeAvatarBytes | null> {
  const dir = profileDirectory(persistRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const name of names) {
    const match = name.match(/^avatar\.(jpg|jpeg|webp|png)$/u);
    if (match === null) continue;
    const ext = match[1]!;
    const mime = MIME_BY_EXT[ext];
    if (mime === undefined || !isAvatarMime(mime)) continue;
    const bytes = new Uint8Array(await fs.readFile(path.join(dir, name)));
    return { mime, bytes };
  }
  return null;
}

export async function clearProfileAvatar(persistRoot: string): Promise<void> {
  const dir = profileDirectory(persistRoot);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(names.map(async (name) => {
    if (!/^avatar\.(jpg|jpeg|webp|png)$/u.test(name)) return;
    await fs.unlink(path.join(dir, name));
  }));
}
