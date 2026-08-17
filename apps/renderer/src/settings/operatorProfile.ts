/**
 * 首页 / 侧栏展示的操作者资料（显示名 + 头像）。
 *
 * 显示名走 localStorage（与主题一样，不进 Host）。头像经裁切压缩后
 * 由桌面壳写入安装目录旁的 `userdata/profile/`；Renderer 只持有用于
 * 展示的 data URL，不把路径写进存储。
 */

import { useCallback, useSyncExternalStore } from "react";
import { cropSourceRect, initialCropView } from "./avatarCrop";

export type AvatarMime = "image/jpeg" | "image/webp" | "image/png";

export interface ProcessedAvatar {
  readonly mime: AvatarMime;
  readonly bytes: Uint8Array;
}

export interface LoadedAvatarImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}

const AVATAR_NAME_RE = /\.(gif|jpe?g|png|webp)$/iu;

export interface OperatorProfile {
  readonly displayName: string;
  /** 仅用于 <img src>；来自应用目录里的头像文件，不进 localStorage。 */
  readonly avatarSrc: string;
}

export const DEFAULT_OPERATOR_PROFILE: OperatorProfile = {
  displayName: "Studio",
  avatarSrc: "",
};

export const OPERATOR_PROFILE_STORAGE_KEY = "omp.operatorProfile";
export const DISPLAY_NAME_MAX = 32;
export const AVATAR_INPUT_MAX_BYTES = 8 * 1024 * 1024;
export const AVATAR_PIXEL_SIZE = 192;
export const AVATAR_FILE_MAX_BYTES = 200_000;

const AVATAR_DATA_URL_RE = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/]+=*)$/u;

export function normalizeDisplayName(value: string): string {
  const trimmed = value.replace(/\s+/gu, " ").trim();
  if (!trimmed) return DEFAULT_OPERATOR_PROFILE.displayName;
  return trimmed.slice(0, DISPLAY_NAME_MAX);
}

export function avatarInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "S";
  return Array.from(trimmed)[0]!.toLocaleUpperCase();
}

export function parseOperatorProfile(raw: string | null): Pick<OperatorProfile, "displayName"> {
  if (!raw) return { displayName: DEFAULT_OPERATOR_PROFILE.displayName };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const displayName = typeof value.displayName === "string"
      ? normalizeDisplayName(value.displayName)
      : DEFAULT_OPERATOR_PROFILE.displayName;
    return { displayName };
  } catch {
    return { displayName: DEFAULT_OPERATOR_PROFILE.displayName };
  }
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 存储被阻塞时设置只活在本次会话内存里。 */
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function writeName(displayName: string): void {
  writeStorage(OPERATOR_PROFILE_STORAGE_KEY, JSON.stringify({ displayName }));
}

export function avatarSrcFromBytes(avatar: ProcessedAvatar): string {
  const bytes = avatar.bytes;
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return `data:${avatar.mime};base64,${btoa(binary)}`;
}

function dataUrlToAvatar(dataUrl: string): ProcessedAvatar | undefined {
  const match = AVATAR_DATA_URL_RE.exec(dataUrl);
  if (match === null) return undefined;
  const rawMime = match[1] === "image/jpg" ? "image/jpeg" : match[1]!;
  const mime: AvatarMime = rawMime === "image/png" || rawMime === "image/webp" || rawMime === "image/jpeg"
    ? rawMime
    : "image/jpeg";
  try {
    const binary = atob(match[2]!);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_FILE_MAX_BYTES) return undefined;
    return { mime, bytes };
  } catch {
    return undefined;
  }
}

let currentProfile: OperatorProfile = {
  displayName: parseOperatorProfile(readStorage(OPERATOR_PROFILE_STORAGE_KEY)).displayName,
  avatarSrc: "",
};
const listeners = new Set<() => void>();
let avatarHydrate: Promise<void> | undefined;

type AvatarDisk = {
  saveAvatar(input: ProcessedAvatar): Promise<{ ok: true } | { ok: false; message: string }>;
  loadAvatar(): Promise<ProcessedAvatar | null>;
  clearAvatar(): Promise<void>;
};

function diskFromChrome(): AvatarDisk | undefined {
  const chrome = globalThis.ompStudioChrome;
  if (chrome?.saveAvatar === undefined || chrome.loadAvatar === undefined || chrome.clearAvatar === undefined) {
    return undefined;
  }
  return {
    saveAvatar: (input) => chrome.saveAvatar(input),
    loadAvatar: () => chrome.loadAvatar(),
    clearAvatar: () => chrome.clearAvatar(),
  };
}

let testDisk: AvatarDisk | undefined;

function avatarDisk(): AvatarDisk | undefined {
  return testDisk ?? diskFromChrome();
}

/** 测试辅助：注入头像磁盘，或传 null 清掉。 */
export function __setAvatarDiskForTests(disk: AvatarDisk | null): void {
  testDisk = disk ?? undefined;
  avatarHydrate = undefined;
}

async function hydrateAvatarFromDisk(): Promise<void> {
  const disk = avatarDisk();
  if (disk !== undefined) {
    const stored = await disk.loadAvatar();
    if (stored !== null) {
      currentProfile = { ...currentProfile, avatarSrc: avatarSrcFromBytes(stored) };
      notify();
      return;
    }
  }
  const legacy = readStorage(OPERATOR_PROFILE_STORAGE_KEY);
  if (!legacy) return;
  try {
    const value = JSON.parse(legacy) as Record<string, unknown>;
    if (typeof value.avatarDataUrl !== "string") return;
    const migrated = dataUrlToAvatar(value.avatarDataUrl);
    if (migrated === undefined) {
      writeName(currentProfile.displayName);
      return;
    }
    if (disk !== undefined) {
      const result = await disk.saveAvatar(migrated);
      if (result.ok === false) return;
    }
    currentProfile = { ...currentProfile, avatarSrc: avatarSrcFromBytes(migrated) };
    writeName(currentProfile.displayName);
    notify();
  } catch {
    /* ignore corrupt legacy rows */
  }
}

function ensureAvatarHydrated(): void {
  if (avatarHydrate !== undefined) return;
  avatarHydrate = hydrateAvatarFromDisk().catch(() => undefined);
}

export function getOperatorProfile(): OperatorProfile {
  return currentProfile;
}

export function updateOperatorProfile(patch: { readonly displayName?: string }): void {
  const displayName = patch.displayName === undefined
    ? currentProfile.displayName
    : normalizeDisplayName(patch.displayName);
  currentProfile = { ...currentProfile, displayName };
  writeName(displayName);
  notify();
}

export async function persistOperatorAvatar(avatar: ProcessedAvatar | null): Promise<void> {
  const disk = avatarDisk();
  if (avatar === null) {
    await disk?.clearAvatar();
    currentProfile = { ...currentProfile, avatarSrc: "" };
    notify();
    return;
  }
  if (avatar.bytes.byteLength === 0 || avatar.bytes.byteLength > AVATAR_FILE_MAX_BYTES) {
    throw new Error("处理后的头像仍然过大，请换一张更小的图片。");
  }
  if (disk !== undefined) {
    const result = await disk.saveAvatar(avatar);
    if (result.ok === false) throw new Error(result.message);
  }
  currentProfile = { ...currentProfile, avatarSrc: avatarSrcFromBytes(avatar) };
  notify();
}

function subscribeOperatorProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试辅助：把存储与内存状态复位后重建。 */
export function __resetOperatorProfileForTests(stored: string | null, avatarSrc = ""): void {
  try {
    if (stored === null) globalThis.localStorage?.removeItem(OPERATOR_PROFILE_STORAGE_KEY);
    else globalThis.localStorage?.setItem(OPERATOR_PROFILE_STORAGE_KEY, stored);
  } catch {
    /* ignore */
  }
  avatarHydrate = undefined;
  currentProfile = {
    displayName: parseOperatorProfile(stored).displayName,
    avatarSrc,
  };
  notify();
}

export function useOperatorProfile(): {
  profile: OperatorProfile;
  update: (patch: { readonly displayName?: string }) => void;
  persistAvatar: (avatar: ProcessedAvatar | null) => Promise<void>;
} {
  ensureAvatarHydrated();
  const profile = useSyncExternalStore(subscribeOperatorProfile, getOperatorProfile, getOperatorProfile);
  const update = useCallback((patch: { readonly displayName?: string }) => updateOperatorProfile(patch), []);
  const persistAvatar = useCallback((avatar: ProcessedAvatar | null) => persistOperatorAvatar(avatar), []);
  return { profile, update, persistAvatar };
}

export function assertAvatarImageFile(file: File): void {
  const named = AVATAR_NAME_RE.test(file.name);
  if (!file.type.startsWith("image/") && !(file.type === "" && named)) {
    throw new Error("请选择图片文件。");
  }
  if (file.size > AVATAR_INPUT_MAX_BYTES) throw new Error("图片太大，请选择 8MB 以内的文件。");
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("无法读取这张图片。"));
    };
    reader.onerror = () => reject(new Error("无法读取这张图片。"));
    reader.readAsDataURL(file);
  });
}

function loadImageFromSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取这张图片。"));
    image.src = src;
  });
}

async function loadViaBitmap(file: File): Promise<LoadedAvatarImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  if (!bitmap.width || !bitmap.height) {
    bitmap.close();
    throw new Error("无法读取这张图片。");
  }
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    close: () => {
      try {
        bitmap.close();
      } catch {
        /* already detached */
      }
    },
  };
}

async function loadViaDataUrl(file: File): Promise<LoadedAvatarImage> {
  const src = await readFileAsDataUrl(file);
  const image = await loadImageFromSrc(src);
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("无法读取这张图片。");
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close() {},
  };
}

/**
 * 解码本地图片。优先 createImageBitmap（不受 img-src 禁 blob: 的 CSP 影响），
 * 没有该 API 时再走 data URL。
 */
export async function loadAvatarImageFile(file: File): Promise<LoadedAvatarImage> {
  assertAvatarImageFile(file);
  if (typeof createImageBitmap === "function") {
    try {
      return await loadViaBitmap(file);
    } catch {
      /* 个别格式 bitmap 解不出时再走 data URL（CSP 允许 data:） */
    }
  }
  try {
    return await loadViaDataUrl(file);
  } catch {
    throw new Error("无法读取这张图片。");
  }
}

function blobToAvatar(blob: Blob): Promise<ProcessedAvatar> {
  return blob.arrayBuffer().then((buffer) => {
    const mime = blob.type === "image/webp" || blob.type === "image/png" || blob.type === "image/jpeg"
      ? blob.type
      : undefined;
    if (mime === undefined) throw new Error("无法处理图片。");
    if (blob.size > AVATAR_FILE_MAX_BYTES) throw new Error("处理后的头像仍然过大，请换一张更小的图片。");
    return { mime, bytes: new Uint8Array(buffer) };
  });
}

function encodeCanvas(canvas: HTMLCanvasElement, mime: "image/webp" | "image/jpeg", quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

export async function encodeAvatarCrop(
  source: CanvasImageSource,
  crop: { readonly sx: number; readonly sy: number; readonly size: number },
): Promise<ProcessedAvatar> {
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_PIXEL_SIZE;
  canvas.height = AVATAR_PIXEL_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法处理图片。");
  ctx.fillStyle = "#111318";
  ctx.fillRect(0, 0, AVATAR_PIXEL_SIZE, AVATAR_PIXEL_SIZE);
  ctx.drawImage(source, crop.sx, crop.sy, crop.size, crop.size, 0, 0, AVATAR_PIXEL_SIZE, AVATAR_PIXEL_SIZE);
  const webp = await encodeCanvas(canvas, "image/webp", 0.86);
  if (webp && webp.type === "image/webp" && webp.size <= AVATAR_FILE_MAX_BYTES) return blobToAvatar(webp);
  const jpeg = await encodeCanvas(canvas, "image/jpeg", 0.86);
  if (jpeg && jpeg.type === "image/jpeg" && jpeg.size <= AVATAR_FILE_MAX_BYTES) return blobToAvatar(jpeg);
  throw new Error("处理后的头像仍然过大，请换一张更小的图片。");
}

/** 把用户选择的图片按居中覆盖裁成方形并压缩（无交互裁切时的路径）。 */
export async function processAvatarFile(file: File): Promise<ProcessedAvatar> {
  const loaded = await loadAvatarImageFile(file);
  try {
    const view = initialCropView(loaded.width, loaded.height, AVATAR_PIXEL_SIZE, AVATAR_PIXEL_SIZE);
    return await encodeAvatarCrop(loaded.source, cropSourceRect(view));
  } finally {
    loaded.close();
  }
}
