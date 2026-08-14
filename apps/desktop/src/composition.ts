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
  DesktopWindow,
} from "./types.js";

export function createDesktopApplication(deps: DesktopApplicationDeps): DesktopApplication {
  let host: DesktopHostComposition | null = null;
  let mainWindow: DesktopWindow | null = null;
  let runtimeStatus: DesktopRuntimeStatus = "read-only";
  let quitting = false;
  let started = false;

  const log = (message: string): void => {
    deps.log?.(message);
  };

  // A second instance must not become a second owner: focus the existing
  // window instead. (The requesting instance has already quit.)
  deps.onSecondInstance(() => {
    log("second instance detected; focusing existing window");
    mainWindow?.focus();
  });

  // Defer every quit until the graceful Host shutdown completed; the
  // re-entrant `quit()` below then proceeds without preventing again.
  deps.onBeforeQuit((event) => {
    if (quitting) return;
    event.preventDefault();
    void quit();
  });

  // Windows shell: closing the last window ends the app (Host shutdown
  // happens through the before-quit path above).
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
    // Stop serving renderer calls before closing the client session.
    mainWindow?.dispose?.();
    try {
      await shutdownHost();
    } finally {
      deps.quit();
    }
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
      });
    },

    quit,
  };
}
