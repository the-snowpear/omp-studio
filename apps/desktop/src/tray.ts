/**
 * 系统托盘（close-to-tray 行为内核，Main-only；preload 不得 import）。
 *
 * Electron-free：Main 注入 `Tray` / `Menu` / `nativeImage`（生产为真实
 * Electron，测试为假实现），因此本模块可被无头单测直接覆盖。
 *
 * 行为：窗口 close 在 main.ts 被拦截为 hide；托盘左键/菜单「打开页面」
 * 重新显示窗口，菜单「退出」走 composition 的 requestQuit（会话仍在
 * 流式输出时先弹原生确认框，文案与选项也在本模块）。首次隐藏到托盘弹
 * 一次 Windows 气泡，标记文件持久化在 `%APPDATA%\omp-studio\tray-hint-shown`，
 * 写失败静默容忍（下个进程再提示一次）。
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { DesktopTray } from "./types.js";

export const TRAY_HINT_FILE_NAME = "tray-hint-shown";

export interface TrayStrings {
  readonly tooltip: string;
  readonly open: string;
  readonly quit: string;
}

export interface QuitBusyStrings {
  readonly title: string;
  readonly message: string;
  readonly cancel: string;
  readonly quit: string;
}

export interface BalloonStrings {
  readonly title: string;
  readonly content: string;
}

/** Structural stand-in for Electron `NativeImage`. */
export interface NativeImageLike {
  isEmpty(): boolean;
}

/** Structural stand-in for Electron `Menu` (opaque handle). */
export type MenuLike = object;

/** One context-menu entry; mirrors the subset of Electron's MenuItem. */
export interface MenuItemTemplate {
  readonly label?: string;
  readonly type?: "separator";
  readonly click?: () => void;
}

/** Structural stand-in for Electron `Tray`. */
export interface TrayLike {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: MenuLike): void;
  on(event: "click", listener: () => void): void;
  displayBalloon(options: { icon?: NativeImageLike; title: string; content: string }): void;
  isDestroyed(): boolean;
  destroy(): void;
}

/** The Electron surface Main injects; fakes substitute it in headless tests. */
export interface TrayElectronSurface {
  /** Wraps `nativeImage.createFromPath`. */
  createImageFromPath(iconPath: string): NativeImageLike;
  /** Wraps `Menu.buildFromTemplate` for the tray context menu. */
  buildMenu(template: readonly MenuItemTemplate[]): MenuLike;
  /** Wraps `new Tray(image)`. */
  createTrayFromImage(image: NativeImageLike): TrayLike;
}

const isZh = (locale: string): boolean => locale.toLowerCase().startsWith("zh");

export function trayStrings(locale: string): TrayStrings {
  return isZh(locale)
    ? { tooltip: "OMP Studio", open: "打开页面", quit: "退出" }
    : { tooltip: "OMP Studio", open: "Open", quit: "Quit" };
}

export function quitBusyDialogStrings(locale: string): QuitBusyStrings {
  return isZh(locale)
    ? {
      title: "退出 OMP Studio",
      message: "当前会话正在流式输出，退出将中止输出并关闭 Host。确定要退出吗？",
      cancel: "取消",
      quit: "退出",
    }
    : {
      title: "Quit OMP Studio",
      message: "A session is still streaming. Quitting will abort the output and shut down the Host. Quit anyway?",
      cancel: "Cancel",
      quit: "Quit",
    };
}

export function firstHideBalloonStrings(locale: string): BalloonStrings {
  return isZh(locale)
    ? {
      title: "OMP Studio 仍在运行",
      content: "已最小化到系统托盘，后台任务将继续；点击托盘图标可重新打开窗口。",
    }
    : {
      title: "OMP Studio is still running",
      content: "Minimized to the tray; background tasks keep running. Click the tray icon to reopen the window.",
    };
}

/** 纯模板构造，供单测与 `Menu.buildFromTemplate` 共用。 */
export function trayMenuTemplate(
  strings: TrayStrings,
  actions: { open(): void; quit(): void },
): Array<{ label: string; click(): void } | { type: "separator" }> {
  return [
    { label: strings.open, click: actions.open },
    { type: "separator" as const },
    { label: strings.quit, click: actions.quit },
  ];
}

/** 原生退出确认框的选项；取消为默认按钮，退出必须显式点击。 */
export function quitBusyMessageBoxOptions(strings: QuitBusyStrings): {
  type: "warning";
  title: string;
  message: string;
  buttons: [string, string];
  defaultId: 0;
  cancelId: 0;
  noLink: true;
} {
  return {
    type: "warning",
    title: strings.title,
    message: strings.message,
    buttons: [strings.cancel, strings.quit],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/** 气泡提示是否已经展示过（标记文件存在即视为展示过）。 */
export function trayHintShown(persistRoot: string): boolean {
  return existsSync(path.join(persistRoot, TRAY_HINT_FILE_NAME));
}

/** 标记气泡已展示；失败静默（下个进程还有机会再提示一次）。 */
export async function markTrayHintShown(persistRoot: string): Promise<void> {
  await fs.mkdir(persistRoot, { recursive: true });
  await fs.writeFile(path.join(persistRoot, TRAY_HINT_FILE_NAME), new Date().toISOString(), "utf8");
}

/**
 * 创建托盘；图标不可用时返回 undefined，调用方保持「关窗即退出」的
 * 原行为，绝不留下无窗无托盘的僵尸进程。
 */
export function createAppTray(options: {
  readonly electron: TrayElectronSurface;
  /** `resolveAppIconPath` 的结果；win32 优先 .ico。 */
  readonly iconPath: string | undefined;
  /** 气泡标记所在目录（`%APPDATA%\omp-studio`）。 */
  readonly persistRoot: string;
  /** `app.getLocale()`；zh* 用中文文案，其余用英文。 */
  readonly locale: string;
  /** 默认 `process.platform`；仅影响气泡（displayBalloon 仅 Windows）。 */
  readonly platform?: NodeJS.Platform;
  readonly onOpen: () => void;
  readonly onQuit: () => void;
}): DesktopTray | undefined {
  if (options.iconPath === undefined) return undefined;
  const icon = options.electron.createImageFromPath(options.iconPath);
  if (icon.isEmpty()) return undefined;
  const platform = options.platform ?? process.platform;
  const strings = trayStrings(options.locale);

  const tray = options.electron.createTrayFromImage(icon);
  tray.setToolTip(strings.tooltip);
  tray.setContextMenu(options.electron.buildMenu(trayMenuTemplate(strings, {
    open: options.onOpen,
    quit: options.onQuit,
  })));
  tray.on("click", () => options.onOpen());

  // In-process latch: the marker write is async, so without it a second
  // hide within the same tick would balloon twice. The file covers the
  // cross-run "only once ever" semantics.
  let hintPending = !trayHintShown(options.persistRoot);

  return {
    // displayBalloon 仅 Windows 提供；其他平台静默跳过。
    notifyHiddenToTray() {
      if (platform !== "win32") return;
      if (!hintPending || tray.isDestroyed()) return;
      hintPending = false;
      const balloon = firstHideBalloonStrings(options.locale);
      tray.displayBalloon({ icon, title: balloon.title, content: balloon.content });
      void markTrayHintShown(options.persistRoot).catch(() => undefined);
    },
    dispose() {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
