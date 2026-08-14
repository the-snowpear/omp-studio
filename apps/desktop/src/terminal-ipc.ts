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
} from "./terminal-shared.js";
import type { TerminalSessionManager, TerminalSessionListeners } from "./terminal-pty.js";

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
    };
    sender.once("destroyed", teardown);
    sender.once("did-navigate", teardown);
  }

  ipc.removeHandler(TERMINAL_IPC_CHANNELS.create);
  ipc.removeHandler(TERMINAL_IPC_CHANNELS.write);
  ipc.removeHandler(TERMINAL_IPC_CHANNELS.resize);
  ipc.removeHandler(TERMINAL_IPC_CHANNELS.dispose);

  ipc.handle(TERMINAL_IPC_CHANNELS.create, (event, payload) => {
    assertTrusted(event.sender);
    track(event.sender);
    const size = parseCreateInput(payload);
    return options.manager.create(event.sender.id, size, listenersFor(event.sender));
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.write, (event, payload) => {
    assertTrusted(event.sender);
    const input = parseWriteInput(payload);
    options.manager.write(event.sender.id, input.id, input.data);
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.resize, (event, payload) => {
    assertTrusted(event.sender);
    const input = parseResizeInput(payload);
    options.manager.resize(event.sender.id, input.id, input.cols, input.rows);
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.dispose, (event, payload) => {
    assertTrusted(event.sender);
    const input = parseDisposeInput(payload);
    options.manager.dispose(event.sender.id, input.id, listenersFor(event.sender));
  });

  return Object.freeze({
    dispose(): void {
      for (const windowId of [...tracked]) {
        options.manager.disposeWindow(windowId);
      }
      tracked.clear();
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.create);
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.write);
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.resize);
      ipc.removeHandler(TERMINAL_IPC_CHANNELS.dispose);
    },
  });
}
