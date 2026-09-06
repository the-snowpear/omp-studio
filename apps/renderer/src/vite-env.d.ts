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
        /** Initial workbench health; absent on older installed main/preload versions. */
        reportPayloadHealth?(status: "ready" | "failed"): Promise<boolean>;
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
        /**
         * 一次进程内存采样（Main 投影自 `app.getAppMetrics()`）。
         * 不含 pid 与可执行路径；不可用时返回 null。
         */
        sampleProcessMemory(): Promise<{
          readonly capturedAt: string;
          readonly totalWorkingSetKb: number;
          readonly rows: ReadonlyArray<{
            readonly kind: string;
            readonly ordinal: number;
            readonly workingSetKb: number;
            readonly peakWorkingSetKb?: number;
          }>;
        } | null>;
        copyImage(input: {          mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";
          bytes: Uint8Array;
        }): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
        saveImage(input: {
          mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";
          bytes: Uint8Array;
          suggestedName: string;
        }): Promise<
          | { readonly ok: true }
          | { readonly ok: false; readonly cancelled: true }
          | { readonly ok: false; readonly message: string }
        >;
        /** 检查更新索引（应用热更新/全量更新与 Runtime 更新）。 */
        checkUpdates(): Promise<{
          readonly checkedAt: string;
          readonly app: {
            readonly currentVersion?: string;
            readonly plan: "none" | "hot" | "full";
            readonly version?: string;
            readonly reason?: string;
            readonly sizeBytes?: number;
            readonly releaseNotesUrl?: string;
          };
          readonly runtime: {
            readonly plan: "none" | "available" | "blocked";
            readonly runtimeVersion?: string;
            readonly reason?: string;
            readonly sizeBytes?: number;
          };
          readonly error?: string;
        } | null>;
        /** 从本地文件/目录导入已签名的更新工件。 */
        importLocalUpdate(input: {
          readonly kind: "app" | "runtime";
          readonly source: "file" | "directory";
        }): Promise<{
          readonly ok: boolean;
          readonly jobId?: string;
          readonly cancelled?: boolean;
          readonly runtimeVersion?: string;
          readonly runtimeChannel?: "stable" | "canary";
          readonly message?: string;
        }>;
        /** 取消正在进行中的更新下载或任务。 */
        cancelUpdate(jobId: string): Promise<void>;
        /** 读取更新偏好设置。 */
        getUpdatePrefs(): Promise<{
          readonly mirrorPrefix: string;
          readonly autoCheck: boolean;
          readonly skippedAppVersion: string;
          readonly runtimeChannel: "stable" | "canary";
          readonly preferHotUpdate: boolean;
          readonly lastIndexSequence: number;
        } | null>;
        /** 写入更新偏好设置。 */
        setUpdatePrefs(patch: {
          readonly mirrorPrefix?: string;
          readonly autoCheck?: boolean;
          readonly skippedAppVersion?: string;
          readonly runtimeChannel?: "stable" | "canary";
          readonly preferHotUpdate?: boolean;
        }): Promise<{
          readonly mirrorPrefix: string;
          readonly autoCheck: boolean;
          readonly skippedAppVersion: string;
          readonly runtimeChannel: "stable" | "canary";
          readonly preferHotUpdate: boolean;
          readonly lastIndexSequence: number;
        } | null>;
        /** 启动在线应用热更新下载。 */
        startApp(): Promise<{ readonly ok: boolean; readonly jobId?: string; readonly message?: string }>;
        /** 启动在线 Runtime 下载与验签。 */
        startRuntime(): Promise<{ readonly ok: boolean; readonly jobId?: string; readonly message?: string }>;
        /** 应用已就绪的热更新。 */
        applyUpdate(): Promise<{ readonly ok: boolean; readonly deferred?: boolean; readonly message?: string }>;
        getAppVersion(): Promise<{ readonly version: string; readonly bundledVersion: string; readonly payloadVersion?: string }>;
        rollbackRuntimeUpdate(): Promise<{ readonly ok: boolean; readonly deferred?: boolean; readonly message?: string }>;
        pruneRuntimeUpdates(): Promise<{ readonly ok: boolean; readonly deferred?: boolean; readonly message?: string }>;
        /** 回滚当前应用热更新负载。 */
        rollbackUpdate(): Promise<{ readonly ok: boolean; readonly deferred?: boolean; readonly message?: string }>;
        /** 订阅更新进度事件。 */
        subscribeUpdateProgress(
          listener: (event: {
            readonly jobId: string;
            readonly kind: "app" | "runtime";
            readonly phase:
              | "resolving"
              | "downloading"
              | "verifying"
              | "extracting"
              | "installing"
              | "activating"
              | "awaiting-apply"
              | "done"
              | "failed"
              | "cancelled";
            readonly step: number;
            readonly steps: number;
            readonly receivedBytes?: number;
            readonly totalBytes?: number;
            readonly bytesPerSecond?: number;
            readonly message?: string;
          }) => void,
        ): () => void;
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
