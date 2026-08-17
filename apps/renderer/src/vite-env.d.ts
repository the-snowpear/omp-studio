/// <reference types="vite/client" />

import type { StudioClient } from "@omp-studio/client-contract";
import type { OmpStudioDesktopApi } from "@omp-studio/transport-desktop";

declare global {
  /**
   * Semantic client injected by the hosting shell (local WebUI bridge or a
   * test harness) before the renderer bundle runs. Optional at runtime:
   * when absent, the Vite entry renders an explicit unavailable state
   * instead of crashing. The renderer never imports a transport.
   */
  var OMP_STUDIO_CLIENT: StudioClient | undefined;

  /**
   * Desktop preload bridge exposed by the Electron shell (frozen
   * `OmpStudioDesktopApi`: bootstrap/query/command/subscribe/close only —
   * no generic invoke). Used by the Vite entry as a fallback: when
   * `OMP_STUDIO_CLIENT` is absent but this is present, the entry wraps it
   * in a desktop transport + `StudioClientImpl` itself.
   */
  var ompStudio: OmpStudioDesktopApi | undefined;

  /**
   * Window-chrome helpers (not the Host transport). Theme sync talks to the
   * native caption buttons; workspace actions resolve paths in Main and never
   * send a filesystem path back to the Renderer.
   */
  type WorkspaceShellEditorResult =
    | { readonly status: "opened"; readonly editorName?: string }
    | { readonly status: "cancelled" };

  var ompStudioChrome:
    | {
        setTheme(theme: "light" | "dark"): Promise<void>;
        /** App 级系统通知（固定文案；非 Host / Studio Bridge 面）。 */
        notify(payload: { title: string; body?: string }): Promise<void>;
        openProjectInEditor(workspaceId: string): Promise<WorkspaceShellEditorResult>;
        openProjectDirectory(workspaceId: string): Promise<void>;
        /** Electron `webUtils.getPathForFile` for dropped / pasted File objects. */
        getPathForFile(file: File): string | null;
        /**
         * `scope: "workspace"` → `path` is workspace-relative;
         * `scope: "absolute"` → the drop came from elsewhere on the machine.
         */
        resolveDroppedPaths(
          workspaceId: string,
          paths: readonly string[],
        ): Promise<
          ReadonlyArray<
            | {
                readonly ok: true;
                readonly kind: "file" | "dir" | "image";
                readonly scope: "workspace" | "absolute";
                readonly path: string;
                readonly name: string;
              }
            | { readonly ok: false; readonly reason: "missing" | "invalid" }
          >
        >;
      }
    | undefined;

  /**
   * Desktop-chrome local shell (not Host / Studio Bridge). Present only
   * when the Electron preload exposed `ompStudioTerminal`.
   */
  var ompStudioTerminal:
    | {
        create(size?: { cols?: number; rows?: number }): Promise<{ id: string; name: string; cwd: string }>;
        write(id: string, data: string): Promise<void>;
        resize(id: string, cols: number, rows: number): Promise<void>;
        dispose(id: string): Promise<void>;
        onData(listener: (event: { id: string; data: string }) => void): () => void;
        onExit(listener: (event: { id: string }) => void): () => void;
      }
    | undefined;
}

export {};
