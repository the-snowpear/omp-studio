/**
 * Secure preload bridge (FRONTEND_INTEGRATION.md §9.1).
 *
 * Runs in a sandboxed renderer (contextIsolation + sandbox, no Node
 * integration) and exposes exactly one frozen object under
 * `window.ompStudio` (see {@link DESKTOP_BRIDGE_GLOBAL}):
 * `OmpStudioDesktopApi` with the fixed named methods bootstrap / query /
 * command / subscribe / close. Window chrome helpers (`ompStudioChrome`,
 * `ompStudioTerminal`) are separate frozen objects on named channels —
 * they are not Host transport.
 *
 * Hard guarantees:
 * - `ipcRenderer` is never exposed: it lives only inside this module's
 *   closure and the bridge adapter below.
 * - No generic `invoke(channel, payload)`: every call resolves to a fixed
 *   constant from `DESKTOP_IPC_CHANNELS` or a chrome channel constant.
 * - No arbitrary event forwarding: `ipcRenderer.on` binds only the fixed
 *   Host event channel and the terminal data/exit channels; unsubscribe
 *   removes the exact listener reference.
 * - No Node API or Host secret (token/endpoint/Runtime PID) leaks.
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";

import {
  createDesktopIpcBridge,
  DESKTOP_BRIDGE_GLOBAL,
  type DesktopIpcBridge,
} from "./ipc-validation.js";
import { CHROME_NOTIFY_CHANNEL } from "./chrome-notify-shared.js";
import { CHROME_OPEN_URL_CHANNEL } from "./chrome-open-url-shared.js";
import {
  CHROME_LOGS_CHANNELS,
  type ChromeLogsResult,
} from "./chrome-logs-shared.js";
import {
  CHROME_IMAGE_CHANNELS,
  type ChromeImageInput,
  type ChromeImageResult,
} from "./chrome-image-shared.js";
import {
  CHROME_PROFILE_CHANNELS,
  type ChromeAvatarBytes,
  type ChromeAvatarSaveResult,
} from "./chrome-profile-shared.js";
import {
  CHROME_APP_UPDATE_CHANNELS,
  type AppUpdateInfo,
  type ChromeAppUpdateDownloadResult,
  type ChromeAppUpdateInstallResult,
} from "./chrome-app-update-shared.js";
import { TITLEBAR_OVERLAY_CHANNEL } from "./titlebar-overlay-shared.js";
import {
  WORKSPACE_SHELL_IPC_CHANNELS,
  type FileOpener,
  type FileOpenWithInput,
  type PlanSavePathPickResult,
  type ResolvedDroppedPath,
  type WorkspaceFileActionResult,
  type WorkspaceFileTargetInput,
  type WorkspaceShellEditorResult,
} from "./workspace-shell-shared.js";
import {
  TERMINAL_IPC_CHANNELS,
  type OmpStudioTerminalApi,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from "./terminal-shared.js";

/**
 * Electron `ipcRenderer.on` calls `(IpcRendererEvent, payload)`. The Host
 * bridge must see only the payload — cloning the IPC event throws
 * "envelope contains a non-JSON value". Wrap like the terminal channels
 * and keep a WeakMap so `removeListener` still matches by identity.
 */
const hostEventWrappers = new WeakMap<
  (event: unknown, ...args: readonly unknown[]) => void,
  (event: unknown, ...args: readonly unknown[]) => void
>();

const sender: DesktopIpcBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      listener(payload);
    };
    hostEventWrappers.set(listener, wrapped);
    ipcRenderer.on(channel, wrapped);
  },
  removeListener: (channel, listener) => {
    const wrapped = hostEventWrappers.get(listener) ?? listener;
    hostEventWrappers.delete(listener);
    ipcRenderer.removeListener(channel, wrapped);
  },
};

const api = createDesktopIpcBridge(sender);

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_GLOBAL, api);
contextBridge.exposeInMainWorld(
  "ompStudioChrome",
  Object.freeze({
    setTheme(theme: "light" | "dark"): Promise<void> {
      if (theme !== "light" && theme !== "dark") return Promise.resolve();
      return ipcRenderer.invoke(TITLEBAR_OVERLAY_CHANNEL, { theme }) as Promise<void>;
    },
    notify(payload: { title: string; body?: string }): Promise<void> {
      return ipcRenderer.invoke(CHROME_NOTIFY_CHANNEL, payload) as Promise<void>;
    },
    openUrl(payload: { url: string }): Promise<void> {
      return ipcRenderer.invoke(CHROME_OPEN_URL_CHANNEL, payload) as Promise<void>;
    },
    openLogDir(): Promise<ChromeLogsResult> {
      return ipcRenderer.invoke(CHROME_LOGS_CHANNELS.openDir, {}) as Promise<ChromeLogsResult>;
    },
    exportLogs(): Promise<ChromeLogsResult> {
      return ipcRenderer.invoke(CHROME_LOGS_CHANNELS.exportLogs, {}) as Promise<ChromeLogsResult>;
    },
    saveAvatar(input: ChromeAvatarBytes): Promise<ChromeAvatarSaveResult | { ok: false; message: string }> {
      return ipcRenderer.invoke(CHROME_PROFILE_CHANNELS.saveAvatar, input) as Promise<
        ChromeAvatarSaveResult | { ok: false; message: string }
      >;
    },
    loadAvatar(): Promise<ChromeAvatarBytes | null> {
      return ipcRenderer.invoke(CHROME_PROFILE_CHANNELS.loadAvatar) as Promise<ChromeAvatarBytes | null>;
    },
    clearAvatar(): Promise<void> {
      return ipcRenderer.invoke(CHROME_PROFILE_CHANNELS.clearAvatar) as Promise<void>;
    },
    openProjectInEditor(workspaceId: string): Promise<WorkspaceShellEditorResult> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.openInEditor, { workspaceId }) as Promise<WorkspaceShellEditorResult>;
    },
    openProjectDirectory(workspaceId: string): Promise<void> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.revealInFileManager, { workspaceId }) as Promise<void>;
    },
    getPathForFile(file: File): string | null {
      try {
        const path = webUtils.getPathForFile(file);
        return typeof path === "string" && path.length > 0 ? path : null;
      } catch {
        return null;
      }
    },
    resolveDroppedPaths(workspaceId: string, paths: readonly string[]): Promise<ReadonlyArray<ResolvedDroppedPath>> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.resolveDroppedPaths, {
        workspaceId,
        paths,
      }) as Promise<ReadonlyArray<ResolvedDroppedPath>>;
    },
    pickPlanSavePath(input: { workspaceId: string }): Promise<PlanSavePathPickResult> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.pickPlanSavePath, input) as Promise<PlanSavePathPickResult>;
    },
    openFile(input: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpen, input) as Promise<WorkspaceFileActionResult>;
    },
    openFileWith(input: FileOpenWithInput): Promise<WorkspaceFileActionResult> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpenWith, input) as Promise<WorkspaceFileActionResult>;
    },
    revealFileInFileManager(input: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileReveal, input) as Promise<WorkspaceFileActionResult>;
    },
    resolveFileAbsolutePath(input: WorkspaceFileTargetInput): Promise<string> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileAbsolutePath, input) as Promise<string>;
    },
    listFileOpeners(input: { workspaceId: string }): Promise<ReadonlyArray<FileOpener>> {
      return ipcRenderer.invoke(WORKSPACE_SHELL_IPC_CHANNELS.fileOpeners, input) as Promise<ReadonlyArray<FileOpener>>;
    },
    copyImage(input: Pick<ChromeImageInput, "mime" | "bytes">): Promise<ChromeImageResult> {
      return ipcRenderer.invoke(CHROME_IMAGE_CHANNELS.copyImage, input) as Promise<ChromeImageResult>;
    },
    saveImage(input: ChromeImageInput): Promise<ChromeImageResult> {
      return ipcRenderer.invoke(CHROME_IMAGE_CHANNELS.saveImage, input) as Promise<ChromeImageResult>;
    },
    checkAppUpdate(): Promise<AppUpdateInfo | null> {
      return ipcRenderer.invoke(CHROME_APP_UPDATE_CHANNELS.check) as Promise<AppUpdateInfo | null>;
    },
    downloadAppUpdate(url: string): Promise<ChromeAppUpdateDownloadResult> {
      return ipcRenderer.invoke(CHROME_APP_UPDATE_CHANNELS.download, { url }) as Promise<ChromeAppUpdateDownloadResult>;
    },
    quitAndInstallUpdate(filePath: string): Promise<ChromeAppUpdateInstallResult> {
      return ipcRenderer.invoke(CHROME_APP_UPDATE_CHANNELS.install, { filePath }) as Promise<ChromeAppUpdateInstallResult>;
    },
  }),
);

function subscribeTerminal<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: unknown): void => {
    listener(payload as T);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const terminalApi: OmpStudioTerminalApi = {
  create(size) {
    return ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.create, size ?? {}) as ReturnType<
      OmpStudioTerminalApi["create"]
    >;
  },
  write(id, data) {
    return ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.write, { id, data }) as Promise<void>;
  },
  resize(id, cols, rows) {
    return ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.resize, { id, cols, rows }) as Promise<void>;
  },
  dispose(id) {
    return ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.dispose, { id }) as Promise<void>;
  },
  onData(listener) {
    return subscribeTerminal<TerminalDataEvent>(TERMINAL_IPC_CHANNELS.data, listener);
  },
  onExit(listener) {
    return subscribeTerminal<TerminalExitEvent>(TERMINAL_IPC_CHANNELS.exit, listener);
  },
};

contextBridge.exposeInMainWorld("ompStudioTerminal", Object.freeze(terminalApi));
