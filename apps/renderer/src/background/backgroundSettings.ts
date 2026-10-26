/**
 * 背景（图片 / 动图 / 视频）的本地偏好与边界。
 *
 * 这是 App 级显示设置，与主题 / 密度同类：不进 Host、不进 client-contract、
 * 不走 Studio Bridge。偏好存 localStorage（`omp.background`），媒体文件存
 * IndexedDB（见 `backgroundLibrary.ts`）。
 *
 * 读取全部容错：坏 JSON、越界数字、未知枚举一律回落默认值并夹取，保证
 * 一个坏记录不会把设置页或背景层打崩。
 */

export type BackgroundScope = "workbench" | "app";
export type BackgroundFit = "cover" | "contain" | "tile";
export type BackgroundFocus = "center" | "top" | "bottom" | "left" | "right";
export type BackgroundMotion = "auto" | "on" | "off";

export interface BackgroundSettings {
  readonly version: 1;
  readonly enabled: boolean;
  /** `preset:<id>` 或上传资产的 id；空字符串表示还没有选择。 */
  readonly activeId: string;
  readonly scope: BackgroundScope;
  /** 背景媒体自身的不透明度，5–100。 */
  readonly opacity: number;
  /** 结构壳透出强度，0–100；0 表示结构壳完全不透明。 */
  readonly strength: number;
  readonly scrimAuto: boolean;
  /** 手动遮罩浓度，0–95；自动模式下由平均亮度计算。 */
  readonly scrim: number;
  /** 只模糊背景媒体本身，0–60 px。 */
  readonly blur: number;
  readonly fit: BackgroundFit;
  readonly focus: BackgroundFocus;
  readonly motion: BackgroundMotion;
}

export const BACKGROUND_STORAGE_KEY = "omp.background";

/** 内置预设 id；默认启用时用它，保证「打开即有效果」。 */
export const DEFAULT_BACKGROUND_PRESET_ID = "preset:aurora";

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  version: 1,
  enabled: false,
  activeId: DEFAULT_BACKGROUND_PRESET_ID,
  scope: "app",
  opacity: 70,
  strength: 65,
  scrimAuto: true,
  scrim: 45,
  blur: 8,
  fit: "cover",
  focus: "center",
  motion: "auto",
};

/**
 * 图库上限。图片按原始字节、视频按原始字节计；总量上限保护 IndexedDB 配额，
 * 也避免一次启动把几十个大视频的解码器排进内存。
 */
export const BACKGROUND_LIMITS = {
  imageBytes: 25 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  totalBytes: 500 * 1024 * 1024,
  count: 30,
  /** 静态图超过这个长边时重编码，避免一张 100MP 图常驻解码位图。 */
  maxImageEdge: 4096,
  /** 图库缩略图长边。 */
  thumbEdge: 480,
} as const;

const SCOPES: readonly BackgroundScope[] = ["workbench", "app"];
const FITS: readonly BackgroundFit[] = ["cover", "contain", "tile"];
const FOCUSES: readonly BackgroundFocus[] = ["center", "top", "bottom", "left", "right"];
const MOTIONS: readonly BackgroundMotion[] = ["auto", "on", "off"];

function pickOne<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** 接受任意来源（localStorage、测试、patch 合并结果），返回一份合法设置。 */
export function normalizeBackgroundSettings(input: unknown): BackgroundSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const activeId = typeof raw.activeId === "string" && raw.activeId.length <= 160 ? raw.activeId : DEFAULT_BACKGROUND_SETTINGS.activeId;
  return {
    version: 1,
    enabled: pickBoolean(raw.enabled, DEFAULT_BACKGROUND_SETTINGS.enabled),
    activeId,
    scope: pickOne(raw.scope, SCOPES, DEFAULT_BACKGROUND_SETTINGS.scope),
    opacity: pickNumber(raw.opacity, 5, 100, DEFAULT_BACKGROUND_SETTINGS.opacity),
    strength: pickNumber(raw.strength, 0, 100, DEFAULT_BACKGROUND_SETTINGS.strength),
    scrimAuto: pickBoolean(raw.scrimAuto, DEFAULT_BACKGROUND_SETTINGS.scrimAuto),
    scrim: pickNumber(raw.scrim, 0, 95, DEFAULT_BACKGROUND_SETTINGS.scrim),
    blur: pickNumber(raw.blur, 0, 60, DEFAULT_BACKGROUND_SETTINGS.blur),
    fit: pickOne(raw.fit, FITS, DEFAULT_BACKGROUND_SETTINGS.fit),
    focus: pickOne(raw.focus, FOCUSES, DEFAULT_BACKGROUND_SETTINGS.focus),
    motion: pickOne(raw.motion, MOTIONS, DEFAULT_BACKGROUND_SETTINGS.motion),
  };
}

export function mergeBackgroundSettings(
  current: BackgroundSettings,
  patch: Partial<BackgroundSettings>,
): BackgroundSettings {
  return normalizeBackgroundSettings({ ...current, ...patch });
}

export function parseBackgroundSettings(raw: string | null): BackgroundSettings {
  if (!raw) return DEFAULT_BACKGROUND_SETTINGS;
  try {
    return normalizeBackgroundSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_BACKGROUND_SETTINGS;
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
    /* 存储被阻塞时，设置只活在本次会话内存里。 */
  }
}

export function readBackgroundSettings(): BackgroundSettings {
  return parseBackgroundSettings(readStorage(BACKGROUND_STORAGE_KEY));
}

export function writeBackgroundSettings(settings: BackgroundSettings): void {
  writeStorage(BACKGROUND_STORAGE_KEY, JSON.stringify(settings));
}

/** 测试辅助：复位持久层，避免用例之间串味。 */
export function __resetBackgroundSettingsForTests(stored: string | null): void {
  try {
    if (stored === null) globalThis.localStorage?.removeItem(BACKGROUND_STORAGE_KEY);
    else globalThis.localStorage?.setItem(BACKGROUND_STORAGE_KEY, stored);
  } catch {
    /* ignore */
  }
}

/** 恢复默认值时不重置「当前背景」与启用状态，只重置表现参数。 */
export const BACKGROUND_RESET_KEYS = [
  "scope",
  "opacity",
  "strength",
  "scrimAuto",
  "scrim",
  "blur",
  "fit",
  "focus",
  "motion",
] as const satisfies readonly (keyof BackgroundSettings)[];
