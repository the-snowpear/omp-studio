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
  parseResolveDroppedPathsInput,
  parseWorkspaceShellInput,
  type ResolvedDroppedPath,
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

  return Object.freeze({
    dispose(): void {
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.openInEditor);
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.revealInFileManager);
      ipc.removeHandler(WORKSPACE_SHELL_IPC_CHANNELS.resolveDroppedPaths);
    },
  });
}
