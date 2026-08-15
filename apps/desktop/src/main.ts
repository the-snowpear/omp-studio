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

import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import {
  TITLEBAR_OVERLAY,
  TITLEBAR_OVERLAY_HEIGHT,
  applyTitleBarOverlay,
  registerTitleBarOverlayIpc,
} from "./titlebar-overlay.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
} from "./security.js";
import type { DesktopWindowFactory, DesktopWindowSurface } from "./types.js";
import { createProductionHostFactory } from "./host-factory.js";
import { registerTerminalIpc } from "./terminal-ipc.js";
import { TerminalSessionManager, createNodePtySpawner } from "./terminal-pty.js";

/**
 * Compiled sandboxed preload bundle, relative to the app root. The preload
 * is authored as ESM TypeScript (src/preload.ts) but the sandbox requires
 * a single CJS bundle; emitting it is a packaging-phase build step.
 */
const PRELOAD_OUTPUT = "dist/preload.cjs";

/** Developer-only override for the renderer entry (Vite dev server). */
const RENDERER_DEV_URL = process.env.OMP_RENDERER_DEV_URL;

/** Window / dock icon next to `package.json` (`resources/icon.ico|.png`). */
function resolveAppIconPath(): string | undefined {
  const dir = join(app.getAppPath(), "resources");
  const ico = join(dir, "icon.ico");
  const png = join(dir, "icon.png");
  if (process.platform === "win32" && existsSync(ico)) return ico;
  if (existsSync(png)) return png;
  if (existsSync(ico)) return ico;
  return undefined;
}

export async function main(): Promise<void> {
  await app.whenReady();

  const target = resolveRendererEntry(app.getAppPath(), RENDERER_DEV_URL);
  const allowedOrigin = rendererOriginFor(target);
  const preloadPath = join(app.getAppPath(), PRELOAD_OUTPUT);
  const appIcon = resolveAppIconPath();
  if (process.platform === "darwin" && appIcon) {
    app.dock?.setIcon(appIcon);
  }

  installCspHeaders(session.defaultSession, rendererCspFor(target));

  const hostFactory = createProductionHostFactory({
    openUrl: async (url) => {
      if (!/^https?:\/\//i.test(url)) throw new Error("refusing to open a non-http login url");
      await shell.openExternal(url);
    },
  });
  const terminalManager = new TerminalSessionManager({ spawner: createNodePtySpawner() });

  const createWindow: DesktopWindowFactory = async (context) => {
    const window = createSecureWindow({
      BrowserWindow,
      windowOptions: {
        width: 1280,
        height: 800,
        show: false,
        title: "OMP Studio",
        ...(appIcon ? { icon: appIcon } : {}),
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
    // Fixed named channels only; every payload validated at this boundary.
    // `dispose` removes handlers before Host shutdown on app quit.
    const isTrustedSender = (sender: { getURL(): string }) => isTrustedRendererUrl(sender.getURL(), allowedOrigin);
    const ipc = registerDesktopIpc({
      facade: context.transport,
      isTrustedSender,
    });
    const disposeChrome = registerTitleBarOverlayIpc({ isTrustedSender });
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
    applyTitleBarOverlay(window, "light");
    window.webContents?.on?.("did-fail-load", (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string) => {
      console.error(`[omp-studio] renderer failed to load (${errorCode}): ${errorDescription} ${validatedURL}`);
    });
    window.webContents?.on?.("console-message", (event) => {
      if (event.level !== "warning" && event.level !== "error") return;
      console.error(`[omp-studio] renderer console ${event.sourceId}:${event.lineNumber}: ${event.message}`);
    });
    loadRendererTarget(window, target);
    return {
      focus: () => {
        if (windowSurface.isMinimized()) windowSurface.restore();
        windowSurface.focus();
      },
      close: () => {
        windowSurface.close();
      },
      dispose: () => {
        disposeTerminal.dispose();
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
