/**
 * Application-level composition for the OMP Studio Desktop shell.
 *
 * Pure orchestration: no Electron imports. Every OS/Electron seam
 * (single-instance lock, quit hooks, window creation, Host factory) is
 * injected through `DesktopApplicationDeps`, so the lifecycle is fully
 * testable with fakes.
 *
 * Lifecycle rules (FRONTEND_INTEGRATION.md §9.2):
 * - A second instance must never become a second owner: without the
 *   single-instance lock the app quits immediately.
 * - Closing the window hides it to the OS tray (when the tray seam is
 *   available); the tray quit path confirms first while sessions are busy.
 * - Host startup failure fails closed: the window still opens in read-only
 *   environment state with a null transport (IPC then serves `unavailable`).
 * - Renderer reload never touches the Host composition; only app quit runs
 *   `shutdown()` (client-session close, Host shutdown, authority release).
 */

import type {
  DesktopApplication,
  DesktopApplicationDeps,
  DesktopHostComposition,
  DesktopRuntimeStatus,
  DesktopTray,
  DesktopWindow,
} from "./types.js";

export function createDesktopApplication(deps: DesktopApplicationDeps): DesktopApplication {
  let host: DesktopHostComposition | null = null;
  let mainWindow: DesktopWindow | null = null;
  let tray: DesktopTray | null = null;
  let runtimeStatus: DesktopRuntimeStatus = "read-only";
  let quitting = false;
  let quitConfirmInFlight = false;
  let started = false;

  const log = (message: string): void => {
    deps.log?.(message);
  };

  // A second instance must not become a second owner: show the existing
  // window instead. (The requesting instance has already quit.)
  deps.onSecondInstance(() => {
    log("second instance detected; showing existing window");
    mainWindow?.show();
  });

  // Defer every quit until the graceful Host shutdown completed; the
  // re-entrant `quit()` below then proceeds without preventing again.
  deps.onBeforeQuit((event) => {
    if (quitting) return;
    event.preventDefault();
    void quit();
  });

  // Windows shell with tray: closing the window hides it to the tray, so
  // this fires only on the real quit path (Host shutdown happens through
  // the before-quit path above). Without a tray the close still destroys
  // the window and this remains the quit safety net.
  deps.onAllWindowsClosed(() => {
    deps.quit();
  });

  async function shutdownHost(): Promise<void> {
    const current = host;
    host = null;
    if (current === null) return;
    try {
      await current.shutdown();
    } catch (error) {
      log(`host shutdown failed: ${String(error)}`);
    }
  }

  async function quit(): Promise<void> {
    if (quitting) return;
    quitting = true;
    // Release the tray icon and stop serving renderer calls before closing
    // the client session.
    tray?.dispose?.();
    tray = null;
    mainWindow?.dispose?.();
    try {
      await shutdownHost();
    } finally {
      deps.quit();
    }
  }

  // Tray-initiated quit: while any session is streaming, confirm first —
  // quitting aborts the output. Other quit paths (before-quit from OS
  // shutdown or update installs) never block on a dialog.
  function requestQuit(): void {
    if (quitting || quitConfirmInFlight) return;
    if (host?.isBusy() !== true) {
      void quit();
      return;
    }
    quitConfirmInFlight = true;
    void Promise.resolve(deps.confirmQuitWhileBusy ? deps.confirmQuitWhileBusy() : true)
      .then((confirmed) => {
        if (confirmed) void quit();
      })
      .finally(() => {
        quitConfirmInFlight = false;
      });
  }

  return {
    get runtimeStatus(): DesktopRuntimeStatus {
      return runtimeStatus;
    },

    async start(): Promise<void> {
      if (started) return;
      started = true;

      if (!deps.requestSingleInstanceLock()) {
        log("another instance holds the single-instance lock; quitting");
        deps.quit();
        return;
      }

      try {
        host = await deps.hostFactory.create();
        runtimeStatus = host.status;
      } catch (error) {
        // Fail closed: keep the window in read-only environment state.
        runtimeStatus = "read-only";
        log(`host composition failed; opening read-only window: ${String(error)}`);
      }

      mainWindow = await deps.createWindow({
        transport: host?.transport ?? null,
        runtimeStatus,
        isQuitting: () => quitting,
      });

      // The tray owns close-to-tray; when it is unavailable the window
      // close keeps the legacy destroy-and-quit behavior.
      try {
        tray = deps.createTray?.({
          openWindow: () => mainWindow?.show(),
          requestQuit,
        }) ?? null;
      } catch (error) {
        log(`tray unavailable; window close keeps quit behavior: ${String(error)}`);
        tray = null;
      }
    },

    quit,
  };
}
