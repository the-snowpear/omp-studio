/**
 * Shared application-level contracts for the OMP Studio Desktop shell
 * (FRONTEND_INTEGRATION.md §9.2).
 *
 * Pure contracts: type-only imports only, no Electron and no Node runtime
 * imports, so this module is safe to import from headless tests.
 *
 * Ownership:
 * - src/main.ts / src/composition.ts / src/security.ts consume these.
 * - src/host-composition.ts / src/host-factory.ts (Host composition) and
 *   src/ipc.ts / src/preload.ts (IPC layer) implement them.
 *
 * The public surface carries only public facts — opaque identities, coarse
 * availability status and the renderer-facing transport. It never exposes
 * Bridge tokens, private endpoints, PIDs, process handles or
 * session/workspace paths (FRONTEND_INTEGRATION.md §8, §9.2).
 */

import type { ClientTransport } from "@omp-studio/client-contract";
import type { StudioHostClientFacade } from "@omp-studio/host-client-api";

/** Public Host availability as surfaced to the window (no secrets). */
export type DesktopRuntimeStatus = "ready" | "read-only";

/**
 * Host-side composition produced by the injected Host factory.
 *
 * `status` is `"ready"` only when Host and Runtime are fully up; otherwise
 * the shell opens in read-only environment state and every IPC call fails
 * closed. `shutdown()` performs the graceful close sequence: renderer
 * client-session close first, then Host shutdown and authority release —
 * it is invoked only on app quit, never on renderer reload.
 */
export interface DesktopHostComposition {
  /** Facade session serving the renderer's client identity. */
  readonly facade: StudioHostClientFacade;
  /** Renderer-facing transport the IPC layer serves calls from. */
  readonly transport: ClientTransport;
  readonly status: DesktopRuntimeStatus;
  /** Re-bind to the same Host session without stopping the Runtime. */
  reload(): Promise<DesktopHostComposition>;
  /**
   * Rebind the Host to a new workspace cwd and rebuild the facade's runtime
   * access from the returned session bundle. Callers may keep a workspace
   * read-only when no resident Worker exists. No-op when the runtime session
   * port has no `rebind` seam.
   */
  rebindWorkspace(
    workspace: { workspaceId: string; cwd: string },
    options?: { readonly launchIfMissing?: boolean },
  ): Promise<void>;
  /** Graceful close: client-session close, Host shutdown, authority release. */
  shutdown(): Promise<void>;
  /**
   * True while any resident session is streaming/compacting. Main-only
   * gate for the tray quit confirmation; never surfaced to the renderer.
   */
  isBusy(): boolean;
  /** Main-only maintenance; absent when managed installation is unavailable. */
  rollbackRuntime?(): Promise<void>;
  pruneRuntimes?(): Promise<void>;
}

/** Injectable factory that brings the Host composition up (or fails closed). */
export interface DesktopHostFactory {
  create(): Promise<DesktopHostComposition>;
}

/** Context handed to the window factory for one Renderer window. */
export interface DesktopWindowContext {
  /**
   * Renderer-facing transport, or null when the Host could not be brought
   * up at all. The window still opens in read-only environment state and
   * every IPC call fails closed to `unavailable`.
   */
  readonly transport: ClientTransport | null;
  readonly runtimeStatus: DesktopRuntimeStatus;
  /**
   * True once a real quit started. The window factory uses it to let close
   * events pass during shutdown while intercepting them otherwise
   * (close-to-tray).
   */
  readonly isQuitting: () => boolean;
}

/** Window handle the application tracks for show/focus/second-instance handling. */
export interface DesktopWindow {
  /** Bring the window to the front: show if hidden, restore if minimized, focus. */
  show(): void;
  focus(): void;
  close(): void;
  /**
   * Optional release of per-window resources (e.g. IPC handler removal)
   * before Host shutdown on app quit. Must be safe to call when already
   * released.
   */
  dispose?(): void;
}

export type DesktopWindowFactory = (context: DesktopWindowContext) => Promise<DesktopWindow>;

/** Tray handle the application owns alongside the main window. */
export interface DesktopTray {
  /**
   * Best-effort one-time notification for the first close-to-tray hide.
   * Optional because non-Windows trays cannot show a balloon.
   */
  notifyHiddenToTray?(): void;
  /** Release the tray icon; safe to call when already released. */
  dispose?(): void;
}

/**
 * Electron window surface the `DesktopWindowFactory` implementation
 * consumes beyond the secure-window base: the minimize/restore/show/
 * focus/close handle methods used for second-instance and tray handling.
 * Structural (no Electron import) so the factory stays testable with fakes.
 */
export interface DesktopWindowSurface {
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  close(): void;
}

/** Lifecycle handle returned by `createDesktopApplication`. */
export interface DesktopApplication {
  readonly runtimeStatus: DesktopRuntimeStatus;
  /** Single-instance check, Host start (fail closed), first window. */
  start(): Promise<void>;
  /**
   * Graceful shutdown: host shutdown first, then app quit. Idempotent;
   * renderer reload never routes through this.
   */
  quit(): Promise<void>;
}

/**
 * All Electron/OS coupling injected by src/main.ts; src/composition.ts is
 * pure orchestration and testable with fakes.
 */
export interface DesktopApplicationDeps {
  readonly hostFactory: DesktopHostFactory;
  readonly createWindow: DesktopWindowFactory;
  /** true when this instance holds the single-instance lock. */
  readonly requestSingleInstanceLock: () => boolean;
  /** Retry configuration when restarting (e.g. on --omp-restarted) */
  readonly singleInstanceRetry?: { readonly attempts: number; readonly delayMs: number } | undefined;
  /** Optional argv override for testing single-instance restart flags. */
  readonly argv?: readonly string[] | undefined;
  /** Fired when a second instance tried to start; focus the existing window. */
  readonly onSecondInstance: (listener: () => void) => void;
  /** Fired before quit; `preventDefault` defers the quit. */
  readonly onBeforeQuit: (listener: (event: { preventDefault(): void }) => void) => void;
  /** Fired when every window closed (Windows: quit the app). */
  readonly onAllWindowsClosed: (listener: () => void) => void;
  /**
   * Optional OS tray seam. Returns undefined when the tray is unavailable —
   * closing the window then keeps the legacy behavior (quit the app).
   */
  readonly createTray?: (actions: {
    /** Show and focus the existing window (tray left click / menu open). */
    openWindow(): void;
    /** Tray menu quit; routes through the busy-quit confirmation gate. */
    requestQuit(): void;
  }) => DesktopTray | undefined;
  /** Native confirmation before a tray-initiated quit while sessions are busy. */
  readonly confirmQuitWhileBusy?: () => Promise<boolean>;
  /** Actually quit the app (Electron `app.quit()` in production). */
  readonly quit: () => void;
  readonly log?: (message: string) => void;
}
