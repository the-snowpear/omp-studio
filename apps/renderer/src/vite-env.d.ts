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

  /** Explorer 文件树单个节点的桌面定位（工作区相对路径 + 节点类型）。 */
  type WorkspaceFileTargetInput = {
    readonly workspaceId: string;
    readonly path: string;
    readonly kind: "file" | "dir";
  };

  type WorkspaceFileActionResult =
    | { readonly status: "opened" }
    | { readonly status: "cancelled" }
    | { readonly status: "failed"; readonly message: string };

  var ompStudioChrome:
    | {
        setTheme(theme: "light" | "dark"): Promise<void>;
        /** App 级系统通知（固定文案；非 Host / Studio Bridge 面）。 */
        notify(payload: { title: string; body?: string }): Promise<void>;
        /** 用系统默认浏览器打开 https 链接（Main `shell.openExternal`，不是 Electron 窗）。 */
        openUrl(payload: { url: string }): Promise<void>;
        /** 打开 Host 日志目录。路径留在 Main，不回传。 */
        openLogDir(): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
        /** 另存近期 Host 日志。路径留在 Main，不回传。 */
        exportLogs(): Promise<
          | { readonly ok: true }
          | { readonly ok: false; readonly cancelled: true }
          | { readonly ok: false; readonly message: string }
        >;
        /** 把处理后的头像写入 `%APPDATA%\omp-studio\profile\`，不回传路径。 */
        saveAvatar(input: { mime: "image/jpeg" | "image/webp" | "image/png"; bytes: Uint8Array }): Promise<
          { readonly ok: true } | { readonly ok: false; readonly message: string }
        >;
        loadAvatar(): Promise<{ readonly mime: "image/jpeg" | "image/webp" | "image/png"; readonly bytes: Uint8Array } | null>;
        clearAvatar(): Promise<void>;
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
        /**
         * 原生另存为对话框选计划保存位置（Main 弹窗，默认 `<工作区>/PLAN.md`）。
         * `picked` 回传工作区相对路径（正斜杠）；`outside-workspace` = 选到工作区外。
         */
        pickPlanSavePath(input: { workspaceId: string }): Promise<
          | { readonly status: "picked"; readonly relativePath: string }
          | { readonly status: "cancelled" }
          | { readonly status: "outside-workspace"; readonly fileName: string }
        >;
        /** 用系统默认关联程序打开工作区文件（Main 解析绝对路径并校验）。 */
        openFile(input: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult>;
        /** 用所选编辑器 / 系统「打开方式」打开文件或目录。 */
        openFileWith(
          input: WorkspaceFileTargetInput & { readonly openerId: "vscode" | "cursor" | "windsurf" | "choose" },
        ): Promise<WorkspaceFileActionResult>;
        /** 文件在资源管理器中选中 / 目录在资源管理器中打开。 */
        revealFileInFileManager(input: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult>;
        /** 解析工作区相对路径为绝对路径（Main 校验存在性与包含性后回传）。 */
        resolveFileAbsolutePath(input: WorkspaceFileTargetInput): Promise<string>;
        /** 本机已安装编辑器清单（「打开方式」子菜单数据）。 */
        listFileOpeners(input: { workspaceId: string }): Promise<
          ReadonlyArray<{ readonly id: string; readonly name: string }>
        >;
        copyImage(input: {
          mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
          bytes: Uint8Array;
        }): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
        saveImage(input: {
          mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
          bytes: Uint8Array;
          suggestedName: string;
        }): Promise<
          | { readonly ok: true }
          | { readonly ok: false; readonly cancelled: true }
          | { readonly ok: false; readonly message: string }
        >;
        /** 检查 GitHub Releases 应用全量安装包更新。 */
        checkAppUpdate(): Promise<{
          readonly available: boolean;
          readonly currentVersion: string;
          readonly version?: string;
          readonly name?: string;
          readonly releaseNotes?: string;
          readonly publishedAt?: string;
          readonly htmlUrl?: string;
          readonly downloadUrl?: string;
          readonly assetName?: string;
          readonly assetSize?: number;
        } | null>;
        /** 下载应用全量安装包。 */
        downloadAppUpdate(url: string): Promise<
          | { readonly ok: true; readonly filePath: string }
          | { readonly ok: false; readonly message: string }
        >;
        /** 调起下载好的安装程序并退出当前应用。 */
        quitAndInstallUpdate(filePath: string): Promise<
          | { readonly ok: true }
          | { readonly ok: false; readonly message: string }
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
