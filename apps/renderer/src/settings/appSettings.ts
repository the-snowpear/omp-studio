/**
 * App 级设置持久化层（Phase 1 设置页 IA 重构）。
 *
 * 只覆盖渲染层 / 桌面壳自己消费的行为（主题、密度、布局记忆、启动行为、
 * 对话显示开关、通知偏好）。Runtime 级设置（审批、compact、memory、edit
 * mode 等）不在本层——它们等 settings contract 接入后走 Host 读模型。
 *
 * 存储介质是 localStorage（App 级偏好，无 Host 语义）；所有读写都容错，
 * 阻塞存储时静默退回默认值。多订阅者通过 useSyncExternalStore 保持同步。
 */

import { useCallback, useSyncExternalStore } from "react";

export type AppLanguage = "system" | "zh" | "en";
export type AppTheme = "light" | "dark";
export type InfoDensity = "compact" | "standard" | "cozy";
export type ToolActivityDetail = "full" | "concise" | "hidden";
export type StartupPage = "home" | "workbench" | "last";

export interface AppSettings {
  readonly language: AppLanguage;
  readonly theme: AppTheme;
  readonly density: InfoDensity;
  /** 关闭后助手消息不带流式光标（显示层行为）。运行状态仍在对话底部。 */
  readonly streaming: boolean;
  readonly toolActivity: ToolActivityDetail;
  readonly restoreLastProject: boolean;
  readonly restoreLastSession: boolean;
  readonly startupPage: StartupPage;
  readonly rememberLayout: boolean;
  readonly perProjectLayout: boolean;
  readonly notifyTaskDone: boolean;
  readonly notifyErrors: boolean;
  readonly notifyConfirmations: boolean;
  readonly notifyLongTasks: boolean;
  readonly showThinkingSummary: boolean;
  readonly showToolIntent: boolean;
  /** 预留：对话内 Token 用量视图尚未实现，控件显示「尚未接入」。 */
  readonly showTokenUsage: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  language: "system",
  theme: "light",
  density: "standard",
  streaming: true,
  toolActivity: "concise",
  restoreLastProject: true,
  restoreLastSession: true,
  startupPage: "workbench",
  rememberLayout: true,
  perProjectLayout: false,
  notifyTaskDone: true,
  notifyErrors: true,
  notifyConfirmations: true,
  notifyLongTasks: false,
  showThinkingSummary: true,
  showToolIntent: true,
  showTokenUsage: false,
};

const APP_SETTINGS_STORAGE_KEY = "omp.appSettings";

const LANGUAGES: ReadonlyArray<AppLanguage> = ["system", "zh", "en"];
const THEMES: ReadonlyArray<AppTheme> = ["light", "dark"];
const DENSITIES: ReadonlyArray<InfoDensity> = ["compact", "standard", "cozy"];
const TOOL_ACTIVITY: ReadonlyArray<ToolActivityDetail> = ["full", "concise", "hidden"];
const STARTUP_PAGES: ReadonlyArray<StartupPage> = ["home", "workbench", "last"];

function pick<T extends string>(value: unknown, allowed: ReadonlyArray<T>): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseStoredSettings(raw: string | null): AppSettings {
  if (!raw) return DEFAULT_APP_SETTINGS;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      language: pick(value.language, LANGUAGES) ?? DEFAULT_APP_SETTINGS.language,
      theme: pick(value.theme, THEMES) ?? DEFAULT_APP_SETTINGS.theme,
      density: pick(value.density, DENSITIES) ?? DEFAULT_APP_SETTINGS.density,
      streaming: pickBoolean(value.streaming) ?? DEFAULT_APP_SETTINGS.streaming,
      toolActivity: pick(value.toolActivity, TOOL_ACTIVITY) ?? DEFAULT_APP_SETTINGS.toolActivity,
      restoreLastProject: pickBoolean(value.restoreLastProject) ?? DEFAULT_APP_SETTINGS.restoreLastProject,
      restoreLastSession: pickBoolean(value.restoreLastSession) ?? DEFAULT_APP_SETTINGS.restoreLastSession,
      startupPage: pick(value.startupPage, STARTUP_PAGES) ?? DEFAULT_APP_SETTINGS.startupPage,
      rememberLayout: pickBoolean(value.rememberLayout) ?? DEFAULT_APP_SETTINGS.rememberLayout,
      perProjectLayout: pickBoolean(value.perProjectLayout) ?? DEFAULT_APP_SETTINGS.perProjectLayout,
      notifyTaskDone: pickBoolean(value.notifyTaskDone) ?? DEFAULT_APP_SETTINGS.notifyTaskDone,
      notifyErrors: pickBoolean(value.notifyErrors) ?? DEFAULT_APP_SETTINGS.notifyErrors,
      notifyConfirmations: pickBoolean(value.notifyConfirmations) ?? DEFAULT_APP_SETTINGS.notifyConfirmations,
      notifyLongTasks: pickBoolean(value.notifyLongTasks) ?? DEFAULT_APP_SETTINGS.notifyLongTasks,
      showThinkingSummary: pickBoolean(value.showThinkingSummary) ?? DEFAULT_APP_SETTINGS.showThinkingSummary,
      showToolIntent: pickBoolean(value.showToolIntent) ?? DEFAULT_APP_SETTINGS.showToolIntent,
      showTokenUsage: pickBoolean(value.showTokenUsage) ?? DEFAULT_APP_SETTINGS.showTokenUsage,
    };
  } catch {
    return DEFAULT_APP_SETTINGS;
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

let currentSettings: AppSettings = parseStoredSettings(readStorage(APP_SETTINGS_STORAGE_KEY));
const listeners = new Set<() => void>();

export function getAppSettings(): AppSettings {
  return currentSettings;
}

export function updateAppSettings(patch: Partial<AppSettings>): void {
  currentSettings = { ...currentSettings, ...patch };
  writeStorage(APP_SETTINGS_STORAGE_KEY, JSON.stringify(currentSettings));
  for (const listener of listeners) listener();
}

/** 按键恢复默认；供各标签的「恢复默认值」按作用域粒度调用。 */
export function resetAppSettings(keys: readonly (keyof AppSettings)[]): void {
  const patch: Partial<AppSettings> = {};
  for (const key of keys) {
    (patch as Record<string, unknown>)[key] = DEFAULT_APP_SETTINGS[key];
  }
  updateAppSettings(patch);
}

function subscribeAppSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试辅助：把存储与内存状态复位后重建。 */
export function __resetAppSettingsForTests(stored: string | null): void {
  try {
    if (stored === null) globalThis.localStorage?.removeItem(APP_SETTINGS_STORAGE_KEY);
    else globalThis.localStorage?.setItem(APP_SETTINGS_STORAGE_KEY, stored);
  } catch {
    /* ignore */
  }
  currentSettings = parseStoredSettings(stored);
  for (const listener of listeners) listener();
}

export function useAppSettings(): {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reset: (keys: readonly (keyof AppSettings)[]) => void;
} {
  const settings = useSyncExternalStore(subscribeAppSettings, getAppSettings, getAppSettings);
  const update = useCallback((patch: Partial<AppSettings>) => updateAppSettings(patch), []);
  const reset = useCallback((keys: readonly (keyof AppSettings)[]) => resetAppSettings(keys), []);
  return { settings, update, reset };
}

/* ---------------------------------------------------------------
 * 布局记忆：侧栏 / 面板布局的本地持久化，与 AppSettings 同介质但
 * 独立键。scope 为 "global" 或 "project:<id>"（按项目保存布局时）。
 * --------------------------------------------------------------- */

export interface LayoutMemory {
  readonly collapsed: boolean;
  readonly sidebarWidth: number;
  readonly splitRatio: number;
  readonly sideOpen: boolean;
  readonly bottomOpen: boolean;
  /** Entire bottom tab strip on screen; independent of `bottomOpen` (tab body). */
  readonly bottomVisible: boolean;
  readonly sideTab: string;
  readonly bottomTab: string;
  readonly explorerOpen: boolean;
  readonly panelWidth: number;
  readonly bottomHeight: number;
  /** BTW 浮窗：placement、是否打开与几何。字段扁平，与本结构其他项一致。 */
  readonly btwOpen: boolean;
  readonly btwPlacement: string;
  readonly btwMinimized: boolean;
  readonly btwX: number;
  readonly btwY: number;
  readonly btwW: number;
  readonly btwH: number;
  readonly btwCapX: number;
  readonly btwCapY: number;
}

const LAYOUT_MEMORY_PREFIX = "omp.layoutMemory.";

function layoutScopeKey(scope: string): string | undefined {
  return /^[\w:.-]{1,96}$/u.test(scope) ? `${LAYOUT_MEMORY_PREFIX}${scope}` : undefined;
}

export function readLayoutMemory(scope: string): Partial<LayoutMemory> | undefined {
  const key = layoutScopeKey(scope);
  if (key === undefined) return undefined;
  try {
    const raw = readStorage(key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const memory = {
      ...(typeof value.collapsed === "boolean" ? { collapsed: value.collapsed } : {}),
      ...(typeof value.sidebarWidth === "number" && Number.isFinite(value.sidebarWidth) ? { sidebarWidth: value.sidebarWidth } : {}),
      ...(typeof value.splitRatio === "number" && Number.isFinite(value.splitRatio) ? { splitRatio: value.splitRatio } : {}),
      ...(typeof value.sideOpen === "boolean" ? { sideOpen: value.sideOpen } : {}),
      ...(typeof value.bottomOpen === "boolean" ? { bottomOpen: value.bottomOpen } : {}),
      ...(typeof value.bottomVisible === "boolean" ? { bottomVisible: value.bottomVisible } : {}),
      ...(typeof value.sideTab === "string" ? { sideTab: value.sideTab } : {}),
      ...(typeof value.bottomTab === "string" ? { bottomTab: value.bottomTab } : {}),
      ...(typeof value.explorerOpen === "boolean" ? { explorerOpen: value.explorerOpen } : {}),
      ...(typeof value.panelWidth === "number" && Number.isFinite(value.panelWidth) ? { panelWidth: value.panelWidth } : {}),
      ...(typeof value.bottomHeight === "number" && Number.isFinite(value.bottomHeight) ? { bottomHeight: value.bottomHeight } : {}),
      ...(typeof value.btwOpen === "boolean" ? { btwOpen: value.btwOpen } : {}),
      ...(typeof value.btwPlacement === "string" ? { btwPlacement: value.btwPlacement } : {}),
      ...(typeof value.btwMinimized === "boolean" ? { btwMinimized: value.btwMinimized } : {}),
      ...(typeof value.btwX === "number" && Number.isFinite(value.btwX) ? { btwX: value.btwX } : {}),
      ...(typeof value.btwY === "number" && Number.isFinite(value.btwY) ? { btwY: value.btwY } : {}),
      ...(typeof value.btwW === "number" && Number.isFinite(value.btwW) ? { btwW: value.btwW } : {}),
      ...(typeof value.btwH === "number" && Number.isFinite(value.btwH) ? { btwH: value.btwH } : {}),
      ...(typeof value.btwCapX === "number" && Number.isFinite(value.btwCapX) ? { btwCapX: value.btwCapX } : {}),
      ...(typeof value.btwCapY === "number" && Number.isFinite(value.btwCapY) ? { btwCapY: value.btwCapY } : {}),
    };
    return Object.keys(memory).length > 0 ? memory as Partial<LayoutMemory> : undefined;
  } catch {
    return undefined;
  }
}

export function writeLayoutMemory(scope: string, memory: LayoutMemory): void {
  const key = layoutScopeKey(scope);
  if (key === undefined) return;
  writeStorage(key, JSON.stringify(memory));
}

/* ---------------------------------------------------------------
 * 启动行为辅助：上次访问页面（startupPage = "last" 时读取）。
 * --------------------------------------------------------------- */

const LAST_ROUTE_STORAGE_KEY = "omp.lastRoute";

export function readLastRoute(): string | undefined {
  const value = readStorage(LAST_ROUTE_STORAGE_KEY);
  return typeof value === "string" && value.length > 0 && value.length <= 32 ? value : undefined;
}

export function writeLastRoute(route: string): void {
  writeStorage(LAST_ROUTE_STORAGE_KEY, route);
}
