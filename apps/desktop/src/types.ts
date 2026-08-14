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
   * Restart the Runtime under a new workspace cwd and rebuild the facade's
   * runtime access from the returned session bundle. No-op when the
   * runtime session port has no `rebind` seam.
   */
  rebindWorkspace(workspace: { workspaceId: string; cwd: string }): Promise<void>;
  /** Graceful close: client-session close, Host shutdown, authority release. */
  shutdown(): Promise<void>;
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
}

/** Window handle the application tracks for focus/second-instance handling. */
export interface DesktopWindow {
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

/**
 * Electron window surface the `DesktopWindowFactory` implementation
 * consumes beyond the secure-window base: the minimize/restore/focus/close
 * handle methods used for second-instance handling. Structural (no
 * Electron import) so the factory stays testable with fakes.
 */
export interface DesktopWindowSurface {
  isMinimized(): boolean;
  restore(): void;
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
  /** Fired when a second instance tried to start; focus the existing window. */
  readonly onSecondInstance: (listener: () => void) => void;
  /** Fired before quit; `preventDefault` defers the quit. */
  readonly onBeforeQuit: (listener: (event: { preventDefault(): void }) => void) => void;
  /** Fired when every window closed (Windows: quit the app). */
  readonly onAllWindowsClosed: (listener: () => void) => void;
  /** Actually quit the app (Electron `app.quit()` in production). */
  readonly quit: () => void;
  readonly log?: (message: string) => void;
}
