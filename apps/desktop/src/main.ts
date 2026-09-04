/**
 * Electron Main entry for the OMP Studio Windows Desktop shell
 * (FRONTEND_INTEGRATION.md §9.2).
 *
 * Thin production wiring only: the lifecycle is composed by
 * `createDesktopApplication` (src/composition.ts) over injected Electron
 * seams; the Host composition and the IPC layer are injected from
 * src/host-factory.ts and src/ipc.ts. This module imports Electron and
 * must not be imported by headless tests.
 *
 * Secrets policy: Main may hold secrets internally, but nothing here (and
 * nothing passed to the Renderer) ever carries Bridge tokens, private
 * endpoints, PIDs, process handles or session/workspace paths — the window
 * context is just a transport plus a coarse availability status.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell, Tray, type NativeImage, type WebContents } from "electron";
import {
  TITLEBAR_OVERLAY,
  TITLEBAR_OVERLAY_HEIGHT,
  applyTitleBarOverlay,
  registerTitleBarOverlayIpc,
} from "./titlebar-overlay.js";
import { APP_USER_MODEL_ID, resolveAppIconPath } from "./app-icon.js";
import { registerChromeImageIpc } from "./chrome-image.js";
import { registerChromeNotifyIpc } from "./chrome-notify.js";
import { registerChromeOpenUrlIpc } from "./chrome-open-url.js";
import { registerChromeLogsIpc } from "./chrome-logs.js";
import { registerChromeMetricsIpc } from "./chrome-metrics.js";
import { registerChromeProfileIpc } from "./chrome-profile.js";
import { resolveProfilePersistRoot } from "./chrome-profile-store.js";
import { registerChromeAppUpdateIpc } from "./chrome-app-update.js";
import { createAppTray, quitBusyDialogStrings, quitBusyMessageBoxOptions } from "./tray.js";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import { createDesktopApplication } from "./composition.js";
import { registerDesktopIpc } from "./ipc.js";
import {
  RENDERER_CSP,
  createSecureWindow,
  installCspHeaders,
  isTrustedRendererUrl,
  rendererOriginFor,
  resolveRendererEntry,
  loadRendererTarget,
  rendererCspFor,
  rendererDevServerUrl,
} from "./security.js";
import type { DesktopTray, DesktopWindowFactory, DesktopWindowSurface } from "./types.js";
import { createProductionHostFactory } from "./host-factory.js";
import { defaultHostLogsDirectory } from "./host-log.js";
import {
  externalEditorCommandForPath,
  launchExternalEditor,
  listExternalEditorCommands,
  resolveExternalEditorCommand,
} from "./external-editor.js";
import { registerWorkspaceShellIpc } from "./workspace-shell-ipc.js";
import type {
  FileOpener,
  WorkspaceFileActionResult,
  WorkspaceFileTargetInput,
  WorkspaceShellEditorResult,
} from "./workspace-shell-shared.js";
import { resolveDroppedPaths } from "./dropped-paths.js";
import { planSaveRelativeTarget } from "./plan-save-path.js";
import { registerTerminalIpc } from "./terminal-ipc.js";
import { TerminalSessionManager, createNodePtySpawner } from "./terminal-pty.js";

/**
 * Compiled sandboxed preload bundle, relative to the app root. The preload
 * is authored as ESM TypeScript (src/preload.ts) but the sandbox requires
 * a single CJS bundle; emitting it is a packaging-phase build step.
 */
const PRELOAD_OUTPUT = "dist/preload.cjs";

/** Developer-only override for the renderer entry (Vite dev server). */
const RENDERER_DEV_URL = rendererDevServerUrl(app.isPackaged, process.env.OMP_RENDERER_DEV_URL);

export async function main(): Promise<void> {
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
  await app.whenReady();

  const target = resolveRendererEntry(app.getAppPath(), RENDERER_DEV_URL);
  const allowedOrigin = rendererOriginFor(target);
  const preloadPath = join(app.getAppPath(), PRELOAD_OUTPUT);
  const appIcon = resolveAppIconPath({ appPath: app.getAppPath(), platform: process.platform });
  const appNativeIcon = appIcon !== undefined ? nativeImage.createFromPath(appIcon) : undefined;
  const validAppIcon = appNativeIcon !== undefined && !appNativeIcon.isEmpty() ? appNativeIcon : undefined;
  installCspHeaders(session.defaultSession, rendererCspFor(target));

  const hostFactory = createProductionHostFactory({
    openUrl: async (url) => {
      if (!/^https?:\/\//i.test(url)) throw new Error("refusing to open a non-http login url");
      await shell.openExternal(url);
    },
    revealDirectory: async (absDir) => {
      const error = await shell.openPath(absDir);
      if (error.length > 0) throw new Error(error);
    },
  });
  const terminalManager = new TerminalSessionManager({
    spawner: createNodePtySpawner(),
    resolveCwd: () => hostFactory.activeWorkspaceCwd() ?? process.cwd(),
  });

  const editorDialogFilters = (platform: NodeJS.Platform): Array<{ name: string; extensions: string[] }> => {
    if (platform === "darwin") {
      return [
        { name: "应用程序 (*.app)", extensions: ["app"] },
        { name: "所有文件", extensions: ["*"] },
      ];
    }
    if (platform === "win32") {
      return [
        { name: "应用程序 (*.exe)", extensions: ["exe"] },
        { name: "所有文件", extensions: ["*"] },
      ];
    }
    return [{ name: "所有文件", extensions: ["*"] }];
  };

  const showOpenWithPicker = async (title: string): Promise<string | undefined> => {
    const detected = resolveExternalEditorCommand();
    const defaultPath = detected !== undefined && isAbsolute(detected.file) ? detected.file : undefined;
    const pickerOptions: Electron.OpenDialogOptions = {
      title,
      buttonLabel: "用所选程序打开",
      properties: ["openFile"],
      ...(defaultPath === undefined ? {} : { defaultPath }),
      filters: editorDialogFilters(process.platform),
    };
    const owner = BrowserWindow.getFocusedWindow();
    const picked = owner === null
      ? await dialog.showOpenDialog(pickerOptions)
      : await dialog.showOpenDialog(owner, pickerOptions);
    return picked.canceled ? undefined : picked.filePaths[0];
  };

  const openInExternalEditor = async (cwd: string): Promise<WorkspaceShellEditorResult> => {
    const file = await showOpenWithPicker("选择用于打开项目的编辑器");
    if (file === undefined) {
      return { status: "cancelled" };
    }
    await launchExternalEditor(externalEditorCommandForPath(file), cwd);
    return { status: "opened", editorName: basename(file) };
  };

  /**
   * Resolve a Renderer-supplied workspace-relative tree path to its absolute
   * form, enforcing containment inside the workspace root plus existence and
   * kind checks. Absolute paths never travel inbound from the Renderer.
   */
  const resolveWorkspaceFileTarget = async (cwd: string, target: WorkspaceFileTargetInput): Promise<string> => {
    const root = resolve(cwd);
    const absolute = resolve(root, target.path);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new Error("目标路径超出工作区范围");
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch {
      throw new Error(`未找到${target.kind === "dir" ? "目录" : "文件"} ${target.path}`);
    }
    if ((target.kind === "dir") !== info.isDirectory()) {
      throw new Error(`${target.path} 不是${target.kind === "dir" ? "目录" : "文件"}`);
    }
    return absolute;
  };

  const openFile = async (cwd: string, target: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult> => {
    const absolute = await resolveWorkspaceFileTarget(cwd, target);
    const error = await shell.openPath(absolute);
    return error.length > 0 ? { status: "failed", message: error } : { status: "opened" };
  };

  const openFileWith = async (
    cwd: string,
    target: WorkspaceFileTargetInput,
    openerId: string,
  ): Promise<WorkspaceFileActionResult> => {
    const absolute = await resolveWorkspaceFileTarget(cwd, target);
    if (openerId === "choose") {
      if (process.platform === "win32" && target.kind === "file") {
        // Native Windows "How do you want to open this file?" dialog.
        const child = spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", absolute], {
          detached: true,
          stdio: "ignore",
        });
        await new Promise<void>((resolveSpawn, rejectSpawn) => {
          let settled = false;
          const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            rejectSpawn(error);
          };
          child.once("error", fail);
          child.once("spawn", () => {
            if (settled) return;
            settled = true;
            child.unref();
            resolveSpawn();
          });
        });
        return { status: "opened" };
      }
      const picked = await showOpenWithPicker(
        target.kind === "dir" ? "选择用于打开目录的程序" : "选择用于打开文件的程序",
      );
      if (picked === undefined) return { status: "cancelled" };
      await launchExternalEditor(externalEditorCommandForPath(picked), absolute);
      return { status: "opened" };
    }
    const command = listExternalEditorCommands().find((candidate) => candidate.id === openerId);
    if (command === undefined) {
      return { status: "failed", message: "未找到所选编辑器，请确认其已安装" };
    }
    await launchExternalEditor(command, absolute);
    return { status: "opened" };
  };

  const revealFileInFileManager = async (cwd: string, target: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult> => {
    const absolute = await resolveWorkspaceFileTarget(cwd, target);
    if (target.kind === "dir") {
      const error = await shell.openPath(absolute);
      return error.length > 0 ? { status: "failed", message: error } : { status: "opened" };
    }
    shell.showItemInFolder(absolute);
    return { status: "opened" };
  };

  const listFileOpeners = async (): Promise<ReadonlyArray<FileOpener>> =>
    listExternalEditorCommands().map((command): FileOpener => ({ id: command.id ?? command.label, name: command.label }));

  // Close-to-tray: closing the window only hides it once the tray exists;
  // without a tray the close keeps the legacy destroy-and-quit behavior.
  let trayRef: DesktopTray | null = null;
  let closeToTrayEnabled = false;
  let rendererWindow: BrowserWindow | null = null;

  const createWindow: DesktopWindowFactory = async (context) => {
    const window = createSecureWindow({
      BrowserWindow,
      windowOptions: {
        width: 1280,
        height: 800,
        show: false,
        title: "OMP Studio",
        ...(validAppIcon !== undefined ? { icon: validAppIcon } : appIcon !== undefined ? { icon: appIcon } : {}),
        backgroundColor: TITLEBAR_OVERLAY.light.color,
        titleBarStyle: "hidden" as const,
        titleBarOverlay: {
          color: TITLEBAR_OVERLAY.light.color,
          symbolColor: TITLEBAR_OVERLAY.light.symbolColor,
          height: TITLEBAR_OVERLAY_HEIGHT,
        },
      },
      preloadPath,
      target,
      allowedOrigin,
      deferLoad: true,
    });
    const windowSurface = window as typeof window & DesktopWindowSurface;
    if (validAppIcon !== undefined && typeof window.setIcon === "function") {
      window.setIcon(validAppIcon);
    }
    // Fixed named channels only; every payload validated at this boundary.
    // `dispose` removes handlers before Host shutdown on app quit.
    const isTrustedSender = (sender: { getURL(): string }) => isTrustedRendererUrl(sender.getURL(), allowedOrigin);
    const ipc = registerDesktopIpc({
      facade: context.transport,
      isTrustedSender,
    });
    const disposeChrome = registerTitleBarOverlayIpc({ isTrustedSender });
    const disposeNotify = registerChromeNotifyIpc({
      isTrustedSender,
    });
    const disposeOpenUrl = registerChromeOpenUrlIpc({
      ipcMain: {
        handle(channel, listener) {
          ipcMain.handle(channel, (event, payload: unknown) => listener({ sender: event.sender }, payload));
        },
        removeHandler(channel) {
          ipcMain.removeHandler(channel);
        },
      },
      isTrustedSender,
      openExternal: (url) => shell.openExternal(url),
    });
    const disposeMetrics = registerChromeMetricsIpc({
      ipcMain: {
        handle(channel, listener) {
          ipcMain.handle(channel, (event, payload: unknown) => listener({ sender: event.sender }, payload));
        },
        removeHandler(channel) {
          ipcMain.removeHandler(channel);
        },
      },
      isTrustedSender,
      actions: { appMetrics: () => app.getAppMetrics(), now: () => new Date() },
    });
    const logsDirectory = defaultHostLogsDirectory();
    const disposeLogs = registerChromeLogsIpc({
      ipcMain: {
        handle(channel, listener) {
          ipcMain.handle(channel, (event, payload: unknown) => listener({ sender: event.sender }, payload));
        },
        removeHandler(channel) {
          ipcMain.removeHandler(channel);
        },
      },
      isTrustedSender,
      actions: {
        logsDirectory,
        mkdirLogs: () => mkdir(logsDirectory, { recursive: true }).then(() => undefined),
        openDirectory: () => shell.openPath(logsDirectory),
        listBasenames: async () => {
          const entries = await readdir(logsDirectory, { withFileTypes: true });
          return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
        },
        readFile: (name) => readFile(join(logsDirectory, name), "utf8"),
        async showSaveDialog(sender, options) {
          const owner = BrowserWindow.fromWebContents(sender as WebContents);
          const dialogOptions = {
            title: "导出 Host 日志",
            defaultPath: options.defaultPath,
            filters: [{ name: "文本文件", extensions: ["txt"] }],
          };
          const picked = owner
            ? await dialog.showSaveDialog(owner, dialogOptions)
            : await dialog.showSaveDialog(dialogOptions);
          return { canceled: picked.canceled, ...(picked.filePath === undefined ? {} : { filePath: picked.filePath }) };
        },
        writeFile(filePath, text) {
          return writeFile(filePath, text, "utf8");
        },
      },
    });
    const disposeProfile = registerChromeProfileIpc({ isTrustedSender });
    const disposeImage = registerChromeImageIpc({
      ipcMain: {
        handle(channel, listener) {
          ipcMain.handle(channel, (event, payload: unknown) => listener({ sender: event.sender }, payload));
        },
        removeHandler(channel) {
          ipcMain.removeHandler(channel);
        },
      },
      isTrustedSender,
      actions: {
        copyImageToClipboard(bytes) {
          const image = nativeImage.createFromBuffer(Buffer.from(bytes));
          if (image.isEmpty()) return false;
          clipboard.writeImage(image);
          return true;
        },
        async showSaveDialog(sender, options) {
          const owner = BrowserWindow.fromWebContents(sender as WebContents);
          const dialogOptions = {
            title: "保存图片",
            defaultPath: options.defaultPath,
            filters: options.filters.map((filter) => ({
              name: filter.name,
              extensions: [...filter.extensions],
            })),
          };
          const result = owner
            ? await dialog.showSaveDialog(owner, dialogOptions)
            : await dialog.showSaveDialog(dialogOptions);
          return {
            canceled: result.canceled === true,
            ...(typeof result.filePath === "string" ? { filePath: result.filePath } : {}),
          };
        },
        writeFile(filePath, bytes) {
          return writeFile(filePath, bytes);
        },
      },
    });
    const disposeTerminal = registerTerminalIpc({
      ipcMain: {
        handle(channel, listener) {
          ipcMain.handle(channel, (event, payload: unknown) => listener({ sender: event.sender }, payload));
        },
        removeHandler(channel) {
          ipcMain.removeHandler(channel);
        },
      },
      isTrustedSender,
      manager: terminalManager,
    });
    const disposeWorkspaceShell = registerWorkspaceShellIpc({
      ipcMain: {
        handle(channel, listener) {
          ipcMain.handle(channel, (event, payload: unknown) => listener({ sender: event.sender }, payload));
        },
        removeHandler(channel) {
          ipcMain.removeHandler(channel);
        },
      },
      isTrustedSender,
      actions: {
        resolveWorkspaceCwd: (workspaceId) => hostFactory.resolveWorkspaceCwd(workspaceId),
        openInExternalEditor,
        revealInFileManager: async (cwd) => {
          const error = await shell.openPath(cwd);
          if (error.length > 0) throw new Error(error);
        },
        resolveDroppedPaths: (cwd, paths) => resolveDroppedPaths(cwd, paths),
        openFile,
        openFileWith,
        revealFileInFileManager,
        resolveFileAbsolutePath: (cwd, target) => resolveWorkspaceFileTarget(cwd, target),
        listFileOpeners,
        async pickPlanSavePath(cwd) {
          const picked = await dialog.showSaveDialog({
            title: "保存计划",
            defaultPath: join(cwd, "PLAN.md"),
            filters: [{ name: "Markdown", extensions: ["md"] }],
          });
          if (picked.canceled || picked.filePath === undefined || picked.filePath.length === 0) {
            return { status: "cancelled" };
          }
          return planSaveRelativeTarget(cwd, picked.filePath);
        },
      },
    });
    const disposeAppUpdate = registerChromeAppUpdateIpc({
      ipcMain: {
        handle(channel, listener) {
          ipcMain.handle(channel, (event, payload: unknown) => listener({ sender: event.sender }, payload));
        },
        removeHandler(channel) {
          ipcMain.removeHandler(channel);
        },
      },
      isTrustedSender,
      currentVersion: app.getVersion(),
      updatesDirectory: join(app.getPath("temp"), "omp-studio-updates"),
      openPath: (filePath) => shell.openPath(filePath),
      quitApp: () => app.quit(),
    });
    applyTitleBarOverlay(window, "light");
    rendererWindow = window;
    // Close hides to the tray (streaming keeps running in background); the
    // real quit path releases this through `isQuitting`.
    window.on("close", (event) => {
      if (context.isQuitting() || !closeToTrayEnabled) return;
      event.preventDefault();
      window.hide();
      trayRef?.notifyHiddenToTray?.();
    });
    window.webContents?.on?.("did-fail-load", (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string) => {
      console.error(`[omp-studio] renderer failed to load (${errorCode}): ${errorDescription} ${validatedURL}`);
    });
    window.webContents?.on?.("console-message", (event) => {
      if (event.level !== "warning" && event.level !== "error") return;
      console.error(`[omp-studio] renderer console ${event.sourceId}:${event.lineNumber}: ${event.message}`);
    });
    loadRendererTarget(window, target);
    return {
      show: () => {
        if (windowSurface.isMinimized()) windowSurface.restore();
        if (!windowSurface.isVisible()) windowSurface.show();
        windowSurface.focus();
      },
      focus: () => {
        if (windowSurface.isMinimized()) windowSurface.restore();
        windowSurface.focus();
      },
      close: () => {
        windowSurface.close();
      },
      dispose: () => {
        disposeAppUpdate.dispose();
        disposeWorkspaceShell.dispose();
        disposeTerminal.dispose();
        disposeImage.dispose();
        disposeLogs.dispose();
        disposeMetrics.dispose();
        disposeProfile();
        disposeOpenUrl.dispose();
        disposeNotify();
        disposeChrome();
        ipc.dispose();
      },
    };
  };

  const application = createDesktopApplication({
    hostFactory,
    createWindow,
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    onSecondInstance: (listener) => {
      app.on("second-instance", listener);
    },
    onBeforeQuit: (listener) => {
      app.on("before-quit", (event: { preventDefault(): void }) => {
        listener({ preventDefault: () => event.preventDefault() });
      });
    },
    onAllWindowsClosed: (listener) => {
      app.on("window-all-closed", listener);
    },
    createTray: ({ openWindow, requestQuit }) => {
      const tray = createAppTray({
        electron: {
          createImageFromPath: (iconPath) => nativeImage.createFromPath(iconPath),
          buildMenu: (template) => Menu.buildFromTemplate([...template]),
          createTrayFromImage: (image) => {
            const electronTray = new Tray(image as NativeImage);
            return {
              setToolTip: (toolTip: string) => electronTray.setToolTip(toolTip),
              setContextMenu: (menu: object) => electronTray.setContextMenu(menu as Menu),
              on: (event: "click", listener: () => void) => electronTray.on(event, listener),
              displayBalloon: (options: { icon?: object; title: string; content: string }) =>
                electronTray.displayBalloon({ ...options, icon: image as NativeImage }),
              isDestroyed: () => electronTray.isDestroyed(),
              destroy: () => electronTray.destroy(),
            };
          },
        },
        iconPath: appIcon,
        persistRoot: resolveProfilePersistRoot(app.getPath("appData")),
        locale: app.getLocale(),
        onOpen: openWindow,
        onQuit: requestQuit,
      });
      if (tray === undefined) {
        console.log("[omp-studio] tray unavailable; window close keeps quit behavior");
        return undefined;
      }
      closeToTrayEnabled = true;
      trayRef = tray;
      return tray;
    },
    confirmQuitWhileBusy: async () => {
      const options = quitBusyMessageBoxOptions(quitBusyDialogStrings(app.getLocale()));
      const owner = rendererWindow !== null && !rendererWindow.isDestroyed() ? rendererWindow : undefined;
      const picked = owner !== undefined
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      return picked.response === 1;
    },
    quit: () => {
      app.quit();
    },
    log: (message) => {
      console.log(`[omp-studio] ${message}`);
    },
  });

  await application.start();
}

main().catch((error: unknown) => {
  console.error(`[omp-studio] fatal startup failure: ${String(error)}`);
  app.exit(1);
});
