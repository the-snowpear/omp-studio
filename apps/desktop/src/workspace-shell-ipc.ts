/**
 * Desktop-chrome workspace shell IPC.
 *
 * Electron-free: Main injects `ipcMain`. Handlers reject untrusted senders
 * and validate every payload before touching the Host-owned workspace
 * registry or launching an external process. The Renderer only supplies an
 * opaque workspaceId; canonical paths never cross the IPC boundary.
 */

import {
  WORKSPACE_SHELL_IPC_CHANNELS,
  parseFileOpenWithInput,
  parseResolveDroppedPathsInput,
  parseWorkspaceFileTargetInput,
  parseWorkspaceShellInput,
  type FileOpener,
  type PlanSavePathPickResult,
  type ResolvedDroppedPath,
  type WorkspaceFileActionResult,
  type WorkspaceFileTargetInput,
  type WorkspaceShellEditorResult,
} from "./workspace-shell-shared.js";

export interface WorkspaceShellSender {
  isDestroyed(): boolean;
  getURL(): string;
}

export interface WorkspaceShellIpcMain {
  handle(
    channel: string,
    listener: (event: { sender: WorkspaceShellSender }, payload?: unknown) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface WorkspaceShellActions {
  /** Resolve a Renderer-supplied opaque workspaceId to its Host-owned cwd. */
  resolveWorkspaceCwd(workspaceId: string): Promise<string>;
  openInExternalEditor(cwd: string): Promise<WorkspaceShellEditorResult>;
  revealInFileManager(cwd: string): Promise<void>;
  resolveDroppedPaths(cwd: string, paths: readonly string[]): Promise<ReadonlyArray<ResolvedDroppedPath>>;
  /** Native save-as picker for plans; Main owns the dialog and the cwd. */
  pickPlanSavePath(cwd: string): Promise<PlanSavePathPickResult>;
  /** Open a workspace file with the OS default association. */
  openFile(cwd: string, target: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult>;
  /** Open a workspace file or directory with a chosen editor / system picker. */
  openFileWith(cwd: string, target: WorkspaceFileTargetInput, openerId: string): Promise<WorkspaceFileActionResult>;
  /** Reveal a workspace file (select it) or directory (open it) in the OS file manager. */
  revealFileInFileManager(cwd: string, target: WorkspaceFileTargetInput): Promise<WorkspaceFileActionResult>;
  /** Resolve a workspace-relative path to its absolute form (existence-checked). */
  resolveFileAbsolutePath(cwd: string, target: WorkspaceFileTargetInput): Promise<string>;
  /** Machine-level probe of installed editors for the Open-With submenu. */
  listFileOpeners(): Promise<ReadonlyArray<FileOpener>>;
}

export interface WorkspaceShellIpcOptions {
  readonly ipcMain: WorkspaceShellIpcMain;
  readonly isTrustedSender: (sender: WorkspaceShellSender) => boolean;
  readonly actions: WorkspaceShellActions;
}

export interface WorkspaceShellIpcHandle {
  dispose(): void;
}

export function registerWorkspaceShellIpc(options: WorkspaceShellIpcOptions): WorkspaceShellIpcHandle {
  const ipc = options.ipcMain;

  function assertTrusted(sender: WorkspaceShellSender): void {
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) {
      throw new Error("desktop workspace shell: untrusted sender");
    }
  }

  async function resolveCwd(payload: unknown): Promise<string> {
    const input = parseWorkspaceShellInput(payload);
    return await options.actions.resolveWorkspaceCwd(input.workspaceId);
  }

  ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.openInEditor);
  ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.revealInFileManager);
  ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.resolveDroppedPaths);
  ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.pickPlanSavePath);
  ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.fileOpen);
  ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.fileOpenWith);
  ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.fileReveal);
  ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.fileAbsolutePath);
  ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.fileOpeners);

  ipc.handle(WORKSPACE_SHELL_IPC_CHANNELS.openInEditor, async (event, payload) => {
    assertTrusted(event.sender);
    const cwd = await resolveCwd(payload);
    return await options.actions.openInExternalEditor(cwd);
  });

  ipc.handle(WORKSPACE_SHELL_IPC_CHANNELS.revealInFileManager, async (event, payload) => {
    assertTrusted(event.sender);
    const cwd = await resolveCwd(payload);
    await options.actions.revealInFileManager(cwd);
  });

  ipc.handle(WORKSPACE_SHELL_IPC_CHANNELS.resolveDroppedPaths, async (event, payload) => {
    assertTrusted(event.sender);
    const input = parseResolveDroppedPathsInput(payload);
    const cwd = await options.actions.resolveWorkspaceCwd(input.workspaceId);
    return await options.actions.resolveDroppedPaths(cwd, input.paths);
  });

  ipc.handle(WORKSPACE_SHELL_IPC_CHANNELS.pickPlanSavePath, async (event, payload) => {
    assertTrusted(event.sender);
    const cwd = await resolveCwd(payload);
    return await options.actions.pickPlanSavePath(cwd);
  });

  ipc.handle(WORKSPACE_SHELL_IPC_CHANNELS.fileOpen, async (event, payload) => {
    assertTrusted(event.sender);
    const input = parseWorkspaceFileTargetInput(payload);
    const cwd = await options.actions.resolveWorkspaceCwd(input.workspaceId);
    return await options.actions.openFile(cwd, input);
  });

  ipc.handle(WORKSPACE_SHELL_IPC_CHANNELS.fileOpenWith, async (event, payload) => {
    assertTrusted(event.sender);
    const input = parseFileOpenWithInput(payload);
    const cwd = await options.actions.resolveWorkspaceCwd(input.workspaceId);
    const target: WorkspaceFileTargetInput = { workspaceId: input.workspaceId, path: input.path, kind: input.kind };
    return await options.actions.openFileWith(cwd, target, input.openerId);
  });

  ipc.handle(WORKSPACE_SHELL_IPC_CHANNELS.fileReveal, async (event, payload) => {
    assertTrusted(event.sender);
    const input = parseWorkspaceFileTargetInput(payload);
    const cwd = await options.actions.resolveWorkspaceCwd(input.workspaceId);
    return await options.actions.revealFileInFileManager(cwd, input);
  });

  ipc.handle(WORKSPACE_SHELL_IPC_CHANNELS.fileAbsolutePath, async (event, payload) => {
    assertTrusted(event.sender);
    const input = parseWorkspaceFileTargetInput(payload);
    const cwd = await options.actions.resolveWorkspaceCwd(input.workspaceId);
    return await options.actions.resolveFileAbsolutePath(cwd, input);
  });

  ipc.handle(WORKSPACE_SHELL_IPC_CHANNELS.fileOpeners, async (event, payload) => {
    assertTrusted(event.sender);
    parseWorkspaceShellInput(payload);
    return await options.actions.listFileOpeners();
  });

  return Object.freeze({
    dispose(): void {
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.openInEditor);
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.revealInFileManager);
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.resolveDroppedPaths);
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.pickPlanSavePath);
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.fileOpen);
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.fileOpenWith);
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.fileReveal);
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.fileAbsolutePath);
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.fileOpeners);
    },
  });
}
