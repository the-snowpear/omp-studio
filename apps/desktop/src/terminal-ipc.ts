/**
 * Named Desktop-chrome IPC for the integrated local shell.
 *
 * Electron-free: Main injects `ipcMain`. Handlers reject untrusted senders
 * and validate every payload before touching a PTY. This channel set is
 * not part of the Host transport.
 */

import {
  TERMINAL_IPC_CHANNELS,
  parseCreateInput,
  parseDisposeInput,
  parseResizeInput,
  parseWriteInput,
  parseRecordingInput,
} from "./terminal-shared.js";
import type { TerminalSessionManager, TerminalSessionListeners } from "./terminal-pty.js";
import type { RemoteTerminalManager } from "./remote/terminal.js";
import type { TerminalRecordingManager } from "./terminal-recording.js";

export interface TerminalSender {
  readonly id: number;
  isDestroyed(): boolean;
  getURL(): string;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed" | "did-navigate", listener: () => void): void;
}

export interface TerminalIpcMain {
  handle(
    channel: string,
    listener: (event: { sender: TerminalSender }, payload?: unknown) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface TerminalIpcOptions {
  readonly ipcMain: TerminalIpcMain;
  readonly isTrustedSender: (sender: TerminalSender) => boolean;
  readonly manager: TerminalSessionManager;
  readonly remote?: RemoteTerminalManager;
  readonly activeRemote?: () => string | null;
  readonly recordings?: TerminalRecordingManager;
}

export interface TerminalIpcHandle {
  dispose(): void;
}

function listenersFor(sender: TerminalSender): TerminalSessionListeners {
  return {
    onData(event) {
      if (!sender.isDestroyed()) sender.send(TERMINAL_IPC_CHANNELS.data, event);
    },
    onExit(event) {
      if (!sender.isDestroyed()) sender.send(TERMINAL_IPC_CHANNELS.exit, event);
    },
  };
}

export function registerTerminalIpc(options: TerminalIpcOptions): TerminalIpcHandle {
  const ipc = options.ipcMain;
  const tracked = new Set<number>();

  function assertTrusted(sender: TerminalSender): void {
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) {
      throw new Error("desktop terminal: untrusted sender");
    }
  }

  function track(sender: TerminalSender): void {
    if (tracked.has(sender.id)) return;
    tracked.add(sender.id);
    const teardown = (): void => {
      if (!tracked.delete(sender.id)) return;
      options.manager.disposeWindow(sender.id);
      options.remote?.disposeWindow(sender.id);
    };
    sender.once("destroyed", teardown);
    sender.once("did-navigate", teardown);
  }

  ipc.removeHandler(TERMINAL_IPC_CHANNELS.create);
  ipc.removeHandler(TERMINAL_IPC_CHANNELS.write);
  ipc.removeHandler(TERMINAL_IPC_CHANNELS.resize);
  ipc.removeHandler(TERMINAL_IPC_CHANNELS.dispose);
  for (const channel of [TERMINAL_IPC_CHANNELS.recordingStart, TERMINAL_IPC_CHANNELS.recordingStop, TERMINAL_IPC_CHANNELS.recordingStatus]) ipc.removeHandler(channel);

  ipc.handle(TERMINAL_IPC_CHANNELS.recordingStart, (event, payload) => {
    assertTrusted(event.sender); track(event.sender);
    const input = parseRecordingInput(payload);
    if (!options.recordings) throw new Error("Terminal recording is unavailable");
    if (options.remote?.owns(event.sender.id, input.id)) throw new Error("SSH terminal recording is not supported");
    return options.recordings.start(event.sender.id, input, options.manager.recordingTarget(event.sender.id, input.id));
  });
  ipc.handle(TERMINAL_IPC_CHANNELS.recordingStop, (event, payload) => {
    assertTrusted(event.sender); const input = parseDisposeInput(payload);
    if (!options.recordings) throw new Error("Terminal recording is unavailable");
    return options.recordings.stop(event.sender.id, input.id);
  });
  ipc.handle(TERMINAL_IPC_CHANNELS.recordingStatus, (event, payload) => {
    assertTrusted(event.sender); const input = parseDisposeInput(payload);
    if (!options.recordings) throw new Error("Terminal recording is unavailable");
    return options.recordings.status(event.sender.id, input.id);
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.create, (event, payload) => {
    assertTrusted(event.sender);
    track(event.sender);
    const size = parseCreateInput(payload);
    if (size.targetId) {
      if (!options.remote || !size.workspaceId) throw new Error("SSH terminal requires a remote workspace");
      return options.remote.create(event.sender.id, size.targetId, size.workspaceId, size, listenersFor(event.sender));
    }
    if (options.activeRemote?.()) throw new Error("SSH workspace cannot open a local terminal implicitly");
    return options.manager.create(event.sender.id, size, listenersFor(event.sender));
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.write, (event, payload) => {
    assertTrusted(event.sender);
    const input = parseWriteInput(payload);
    if (options.remote?.owns(event.sender.id, input.id)) options.remote.write(event.sender.id, input.id, input.data);
    else options.manager.write(event.sender.id, input.id, input.data);
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.resize, (event, payload) => {
    assertTrusted(event.sender);
    const input = parseResizeInput(payload);
    if (options.remote?.owns(event.sender.id, input.id)) options.remote.resize(event.sender.id, input.id, input.cols, input.rows);
    else options.manager.resize(event.sender.id, input.id, input.cols, input.rows);
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.dispose, (event, payload) => {
    assertTrusted(event.sender);
    const input = parseDisposeInput(payload);
    if (options.remote?.owns(event.sender.id, input.id)) options.remote.dispose(event.sender.id, input.id);
    else options.manager.dispose(event.sender.id, input.id, listenersFor(event.sender));
  });

  return Object.freeze({
    dispose(): void {
      for (const windowId of [...tracked]) {
        options.manager.disposeWindow(windowId);
        options.remote?.disposeWindow(windowId);
      }
      tracked.clear();
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.create);
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.write);
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.resize);
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.dispose);
      for (const channel of [TERMINAL_IPC_CHANNELS.recordingStart, TERMINAL_IPC_CHANNELS.recordingStop, TERMINAL_IPC_CHANNELS.recordingStatus]) ipc.removeHandler(channel);
    },
  });
}
