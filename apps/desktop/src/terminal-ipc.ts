/**
 * Named Desktop-chrome IPC for the integrated local shell.
 *
 * Electron-free: Main injects `ipcMain`. Handlers reject untrusted senders
 * and validate every payload before touching a PTY. This channel set is
 * not part of the Host transport.
 */

import {
  TERMINAL_IPC_CHANNELS,
  parseAckInput,
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
  once(event: "destroyed" | "did-navigate" | "render-process-gone", listener: () => void): void;
  off(event: "destroyed" | "did-navigate" | "render-process-gone", listener: () => void): void;
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
  readonly resolveWorkspaceCwd?: (workspaceId: string) => Promise<string>;
  readonly activeRemote?: () => string | null;
  readonly recordings?: TerminalRecordingManager;
}

export interface TerminalIpcHandle {
  dispose(): void;
}

function listenersFor(sender: TerminalSender, active: () => boolean = () => true): TerminalSessionListeners {
  return {
    onData(event) {
      if (active() && !sender.isDestroyed()) sender.send(TERMINAL_IPC_CHANNELS.data, event);
    },
    onExit(event) {
      if (active() && !sender.isDestroyed()) sender.send(TERMINAL_IPC_CHANNELS.exit, event);
    },
  };
}

export function registerTerminalIpc(options: TerminalIpcOptions): TerminalIpcHandle {
  const ipc = options.ipcMain;
  const tracked = new Map<number, { teardown(): void }>();

  function assertTrusted(sender: TerminalSender): void {
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) {
      throw new Error("desktop terminal: untrusted sender");
    }
  }

  function track(sender: TerminalSender) {
    const existing = tracked.get(sender.id);
    if (existing) return existing;
    const document = {
      teardown(): void {
        if (tracked.get(sender.id) !== document) return;
        tracked.delete(sender.id);
        for (const event of ["destroyed", "did-navigate", "render-process-gone"] as const) sender.off(event, document.teardown);
        options.manager.disposeWindow(sender.id);
        options.remote?.disposeWindow(sender.id);
      },
    };
    tracked.set(sender.id, document);
    for (const event of ["destroyed", "did-navigate", "render-process-gone"] as const) sender.once(event, document.teardown);
    return document;
  }

  ipc.removeHandler(TERMINAL_IPC_CHANNELS.create);
  ipc.removeHandler(TERMINAL_IPC_CHANNELS.write);
  ipc.removeHandler(TERMINAL_IPC_CHANNELS.resize);
  ipc.removeHandler(TERMINAL_IPC_CHANNELS.dispose);
  ipc.removeHandler(TERMINAL_IPC_CHANNELS.ack);
  for (const channel of [TERMINAL_IPC_CHANNELS.recordingStart, TERMINAL_IPC_CHANNELS.recordingStop, TERMINAL_IPC_CHANNELS.recordingStatus]) ipc.removeHandler(channel);

  ipc.handle(TERMINAL_IPC_CHANNELS.recordingStart, (event, payload) => {
    assertTrusted(event.sender); track(event.sender);
    const input = parseRecordingInput(payload);
    if (!options.recordings) throw new Error("Terminal recording is unavailable");
    if (options.remote?.owns(event.sender.id, input.id)) throw new Error("SSH terminal recording is not supported");
    options.manager.flushOutput(event.sender.id, input.id);
    return options.recordings.start(event.sender.id, input, options.manager.recordingTarget(event.sender.id, input.id));
  });
  ipc.handle(TERMINAL_IPC_CHANNELS.recordingStop, (event, payload) => {
    assertTrusted(event.sender); const input = parseDisposeInput(payload);
    if (!options.recordings) throw new Error("Terminal recording is unavailable");
    options.manager.flushOutput(event.sender.id, input.id);
    return options.recordings.stop(event.sender.id, input.id);
  });
  ipc.handle(TERMINAL_IPC_CHANNELS.recordingStatus, (event, payload) => {
    assertTrusted(event.sender); const input = parseDisposeInput(payload);
    if (!options.recordings) throw new Error("Terminal recording is unavailable");
    return options.recordings.status(event.sender.id, input.id);
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.create, (event, payload) => {
    assertTrusted(event.sender);
    const document = track(event.sender);
    const listeners = listenersFor(event.sender, () => tracked.get(event.sender.id) === document);
    const size = parseCreateInput(payload);
    if (size.targetId) {
      if (!options.remote || !size.workspaceId) throw new Error("SSH terminal requires a remote workspace");
      return options.remote.create(event.sender.id, size.targetId, size.workspaceId, size, listeners);
    }
    if (size.workspaceId && options.resolveWorkspaceCwd) return options.resolveWorkspaceCwd(size.workspaceId).then(cwd => {
      if (event.sender.isDestroyed() || tracked.get(event.sender.id) !== document) throw new Error("Terminal window has closed");
      return options.manager.create(event.sender.id, size, listeners, cwd);
    });
    if (!size.workspaceId && options.activeRemote?.()) throw new Error("SSH workspace cannot open a local terminal implicitly");
    return options.manager.create(event.sender.id, size, listeners);
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

  // Flow control: the Renderer reports how much output it has written to
  // xterm. Not every renderer can ACK (older bundle), which is why `create`
  // decides whether this session is flow-controlled at all.
  ipc.handle(TERMINAL_IPC_CHANNELS.ack, (event, payload) => {
    assertTrusted(event.sender);
    const input = parseAckInput(payload);
    if (options.remote?.owns(event.sender.id, input.id)) options.remote.acknowledge(event.sender.id, input.id, input.bytes);
    else options.manager.acknowledge(event.sender.id, input.id, input.bytes);
    return { ok: true };
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.dispose, (event, payload) => {
    assertTrusted(event.sender);
    const input = parseDisposeInput(payload);
    if (options.remote?.owns(event.sender.id, input.id)) options.remote.dispose(event.sender.id, input.id);
    else options.manager.dispose(event.sender.id, input.id, listenersFor(event.sender));
  });

  return Object.freeze({
    dispose(): void {
      for (const document of [...tracked.values()]) document.teardown();
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.create);
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.write);
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.resize);
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.dispose);
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.ack);
      for (const channel of [TERMINAL_IPC_CHANNELS.recordingStart, TERMINAL_IPC_CHANNELS.recordingStop, TERMINAL_IPC_CHANNELS.recordingStatus]) ipc.removeHandler(channel);
    },
  });
}
