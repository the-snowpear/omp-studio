/**
 * 把处理后的头像写进 `%APPDATA%\omp-studio\profile\`，不经过 Host / Studio Bridge。
 * 可注入目录与 fs，供无 Electron 的单测使用。
 *
 * 路径：{AppData}/omp-studio/profile/avatar.jpg（或 .png / .webp）
 * 同一时刻只保留一个文件：新上传先删旧文件再写。
 * 卸载时由 NSIS `customUnInstall` 删除该 profile 目录。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type AvatarMime,
  type ChromeAvatarBytes,
  isAvatarMime,
} from "./chrome-profile-shared.js";

export const APP_STATE_DIR_NAME = "omp-studio";
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

/** `%APPDATA%\omp-studio`（或传入的等价应用数据根）。 */
export function resolveProfilePersistRoot(appDataRoot: string): string {
  return path.join(appDataRoot, APP_STATE_DIR_NAME);
}

/** 旧版写在安装目录旁的 userdata，仅作迁移源。 */
export function resolveLegacyInstallUserdataRoot(input: {
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

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
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

/**
 * 把旧位置的头像迁到 AppData。目标已有文件时只清掉源，不保留第二份。
 */
export async function migrateProfileAvatar(
  destinationRoot: string,
  sourceRoots: readonly string[],
): Promise<void> {
  const existing = await readProfileAvatar(destinationRoot);
  if (existing !== null) {
    for (const source of sourceRoots) {
      if (samePath(source, destinationRoot)) continue;
      await clearProfileAvatar(source);
    }
    return;
  }
  for (const source of sourceRoots) {
    if (samePath(source, destinationRoot)) continue;
    const avatar = await readProfileAvatar(source);
    if (avatar === null) continue;
    await writeProfileAvatar(destinationRoot, avatar);
    await clearProfileAvatar(source);
    return;
  }
}
