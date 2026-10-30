/**
 * P0-4 integration: batching + flow control through the terminal IPC layer.
 *
 * `terminal-batch.test.ts` covers the batcher in isolation; this file drives
 * the real `TerminalSessionManager` + `registerTerminalIpc` pair with a fake
 * PTY and a manual clock, so it pins the behaviour the renderer actually sees:
 * one message per window, `bytes` on every message, ACK-driven pause/resume of
 * the PTY, exit ordering, recording batches, and window teardown.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TERMINAL_IPC_CHANNELS, type TerminalAckInput } from "../src/terminal-shared.js";
import { TerminalSessionManager, type PtyProcess, type PtySpawner } from "../src/terminal-pty.js";
import {
  registerTerminalIpc,
  type TerminalIpcMain,
  type TerminalSender,
} from "../src/terminal-ipc.js";
import type { TerminalBatchTimers } from "../src/terminal-batch.js";

class ManualTimers implements TerminalBatchTimers {
  readonly scheduled: Array<{ handler: () => void; cancelled: boolean }> = [];

  setTimeout(handler: () => void): unknown {
    const timer = { handler, cancelled: false };
    this.scheduled.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    const timer = handle as { handler: () => void; cancelled: boolean };
    timer.cancelled = true;
    const index = this.scheduled.indexOf(timer);
    if (index >= 0) this.scheduled.splice(index, 1);
  }

  run(): void {
    for (const timer of this.scheduled.splice(0)) if (!timer.cancelled) timer.handler();
  }

  get pending(): number {
    return this.scheduled.length;
  }
}

interface FakePty extends PtyProcess {
  readonly writes: string[];
  readonly resizes: Array<{ cols: number; rows: number }>;
  pauses: number;
  resumes: number;
  killed: boolean;
  emitData(data: string): void;
  emitExit(): void;
}

function makePty(): FakePty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(info: { exitCode: number }) => void> = [];
  return {
    writes: [],
    resizes: [],
    pauses: 0,
    resumes: 0,
    killed: false,
    write(data) {
      this.writes.push(data);
    },
    resize(cols, rows) {
      this.resizes.push({ cols, rows });
    },
    kill() {
      this.killed = true;
    },
    pause() {
      this.pauses += 1;
    },
    resume() {
      this.resumes += 1;
    },
    onData(listener) {
      dataListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    emitData(data) {
      for (const listener of dataListeners) listener(data);
    },
    emitExit() {
      for (const listener of exitListeners) listener({ exitCode: 0 });
    },
  };
}

interface FakeSender extends TerminalSender {
  destroyed: boolean;
  readonly sent: Array<{ channel: string; payload: unknown }>;
  readonly listeners: Map<string, Set<() => void>>;
  fire(event: string): void;
}

function makeSender(id: number): FakeSender {
  const listeners = new Map<string, Set<() => void>>();
  const add = (event: string, listener: () => void): void => {
    let set = listeners.get(event);
    if (set === undefined) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener);
  };
  return {
    id,
    destroyed: false,
    sent: [],
    listeners,
    isDestroyed() {
      return this.destroyed;
    },
    getURL() {
      return "file:///C:/app/index.html";
    },
    send(channel, payload) {
      this.sent.push({ channel, payload });
    },
    once: add,
    fire(event) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
  };
}

interface FakeIpc extends TerminalIpcMain {
  readonly handlers: Map<string, (event: { sender: TerminalSender }, payload?: unknown) => unknown>;
}

function makeIpc(): FakeIpc {
  return {
    handlers: new Map(),
    handle(channel, listener) {
      this.handlers.set(channel, listener);
    },
    removeHandler(channel) {
      this.handlers.delete(channel);
    },
  };
}

interface Rig {
  readonly ipc: FakeIpc;
  readonly manager: TerminalSessionManager;
  readonly timers: ManualTimers;
  readonly ptys: FakePty[];
  readonly recorded: string[];
  readonly sender: FakeSender;
  invoke(channel: string, payload?: unknown): unknown;
  data(): string[];
  create(input?: Record<string, unknown>): { id: string };
}

function rig(): Rig {
  const ipc = makeIpc();
  const timers = new ManualTimers();
  const ptys: FakePty[] = [];
  const recorded: string[] = [];
  const spawner: PtySpawner = {
    spawn() {
      const pty = makePty();
      ptys.push(pty);
      return pty;
    },
  };
  const manager = new TerminalSessionManager({
    spawner,
    resolveShell: () => ({ name: "pwsh", file: "pwsh.exe" }),
    resolveCwd: () => "D:\\work",
    newId: () => `term-${ptys.length + 1}xxxx`,
    // Small watermarks so a handful of bytes exercises the real thresholds.
    output: { timers, highWaterBytes: 16, lowWaterBytes: 8 },
    recording: {
      output: (_windowId, _id, data) => recorded.push(`out:${data}`),
      resize: (_windowId, _id, cols, rows) => recorded.push(`resize:${cols}x${rows}`),
      end: () => recorded.push("end"),
      disposeWindow: () => {},
    },
  });
  registerTerminalIpc({ ipcMain: ipc, isTrustedSender: () => true, manager });
  const sender = makeSender(7);
  const invoke = (channel: string, payload?: unknown): unknown => {
    const handler = ipc.handlers.get(channel);
    assert.ok(handler, `no handler for ${channel}`);
    return handler({ sender }, payload);
  };
  return {
    ipc,
    manager,
    timers,
    ptys,
    recorded,
    sender,
    invoke,
    data() {
      return sender.sent
        .filter((entry) => entry.channel === TERMINAL_IPC_CHANNELS.data)
        .map((entry) => (entry.payload as { data: string }).data);
    },
    create(input = {}) {
      return invoke(TERMINAL_IPC_CHANNELS.create, input) as { id: string };
    },
  };
}

function ack(f: Rig, id: string, bytes: number): unknown {
  return f.invoke(TERMINAL_IPC_CHANNELS.ack, { id, bytes } satisfies TerminalAckInput);
}

describe("terminal IPC: output batching", () => {
  test("one message per window, with the UTF-8 length attached", () => {
    const f = rig();
    const session = f.create();
    for (const chunk of ["a", "b", "c"]) f.ptys[0]?.emitData(chunk);
    assert.deepEqual(f.data(), [], "no per-chunk forwarding");
    f.timers.run();
    assert.deepEqual(f.sender.sent, [
      { channel: TERMINAL_IPC_CHANNELS.data, payload: { id: session.id, data: "abc", bytes: 3 } },
    ]);
  });

  test("recording follows the batch, not the chunk", () => {
    const f = rig();
    f.create();
    f.ptys[0]?.emitData("one");
    f.ptys[0]?.emitData("two");
    f.timers.run();
    assert.deepEqual(f.recorded, ["out:onetwo"], "one JSON frame per batch instead of per chunk");
  });

  test("resize flushes pending output so recorded order stays correct", () => {
    const f = rig();
    const session = f.create();
    f.ptys[0]?.emitData("before");
    f.invoke(TERMINAL_IPC_CHANNELS.resize, { id: session.id, cols: 100, rows: 20 });
    assert.deepEqual(f.recorded, ["out:before", "resize:100x20"]);
    assert.deepEqual(f.data(), ["before"]);
  });

  test("a terminal's exit delivers the buffered tail before the exit event", () => {
    const f = rig();
    f.create();
    f.ptys[0]?.emitData("last line");
    f.ptys[0]?.emitExit();
    assert.deepEqual(
      f.sender.sent.map((entry) => entry.channel),
      [TERMINAL_IPC_CHANNELS.data, TERMINAL_IPC_CHANNELS.exit],
      "data first, then exit",
    );
    assert.deepEqual(f.data(), ["last line"]);
  });

  test("a chunk that arrives after the exit event is still delivered", () => {
    const f = rig();
    f.create();
    f.ptys[0]?.emitExit();
    // ConPTY can hand over the final line after the exit notification.
    f.ptys[0]?.emitData("trailing");
    f.timers.run();
    assert.deepEqual(f.data(), ["trailing"]);
  });
});

describe("terminal IPC: input path is untouched", () => {
  test("keystrokes are written immediately, never batched or throttled", () => {
    const f = rig();
    const session = f.create({ flowControl: true });
    f.invoke(TERMINAL_IPC_CHANNELS.write, { id: session.id, data: "l" });
    f.invoke(TERMINAL_IPC_CHANNELS.write, { id: session.id, data: "s\r" });
    assert.deepEqual(f.ptys[0]?.writes, ["l", "s\r"], "one write per keystroke, no delay");
    assert.equal(f.timers.pending, 0, "the input path schedules no batching timer");
    assert.equal(f.sender.sent.length, 0, "input produces no output IPC");
  });

  test("input still works while output is paused by flow control", () => {
    const f = rig();
    const session = f.create({ flowControl: true });
    f.ptys[0]?.emitData("0123456789abcdef");
    f.timers.run();
    assert.equal(f.ptys[0]?.pauses, 1, "output paused");
    f.invoke(TERMINAL_IPC_CHANNELS.write, { id: session.id, data: "y" });
    assert.deepEqual(f.ptys[0]?.writes, ["y"], "the user can still type while output is paused");
  });
});

describe("terminal IPC: flow control", () => {
  test("create with flowControl pauses the PTY above the watermark and resumes on ACK", () => {
    const f = rig();
    const session = f.create({ flowControl: true });
    f.ptys[0]?.emitData("0123456789abcdef"); // 16 bytes == high watermark
    f.timers.run();
    assert.equal(f.ptys[0]?.pauses, 1, "source paused once the renderer fell behind");
    assert.deepEqual(ack(f, session.id, 16), { ok: true });
    assert.equal(f.ptys[0]?.resumes, 1, "ACK below the low watermark resumes the PTY");
    assert.equal(f.manager.flowStats(session.id)?.paused, false);
  });

  test("a partial ACK keeps the source paused", () => {
    const f = rig();
    const session = f.create({ flowControl: true });
    f.ptys[0]?.emitData("0123456789abcdef");
    f.timers.run();
    ack(f, session.id, 4);
    assert.equal(f.ptys[0]?.resumes, 0);
    assert.equal(f.manager.flowStats(session.id)?.unackedBytes, 12);
  });

  test("without the handshake the PTY is never paused (old renderer degrades)", () => {
    const f = rig();
    const session = f.create();
    for (let round = 0; round < 4; round += 1) {
      f.ptys[0]?.emitData("0123456789abcdef");
      f.timers.run();
    }
    assert.equal(f.ptys[0]?.pauses, 0);
    assert.equal(f.manager.flowStats(session.id)?.flowControl, false);
    assert.equal(f.manager.flowStats(session.id)?.unackedBytes, 0);
    assert.equal(f.data().join("").length, 4 * 16, "every byte still delivered");
  });

  test("an ACK for an unknown or foreign session is a harmless no-op", () => {
    const f = rig();
    const session = f.create({ flowControl: true });
    assert.deepEqual(ack(f, "term-unknown1", 10), { ok: true });
    assert.deepEqual(ack(f, session.id, 10), { ok: true });
    assert.equal(f.ptys[0]?.resumes, 0);
  });

  test("an ACK with a malformed payload is rejected", () => {
    const f = rig();
    f.create({ flowControl: true });
    assert.throws(() => f.invoke(TERMINAL_IPC_CHANNELS.ack, { id: "term-abcdxxxx" }), /bytes must be an integer/u);
    assert.throws(() => f.invoke(TERMINAL_IPC_CHANNELS.ack, { id: "term-abcdxxxx", bytes: -1 }), /bytes/u);
    assert.throws(() => f.invoke(TERMINAL_IPC_CHANNELS.ack, { id: "bad", bytes: 1 }), /terminal session id/u);
    assert.throws(() => f.invoke(TERMINAL_IPC_CHANNELS.ack, { id: "term-abcdxxxx", bytes: 1, extra: true }), /unexpected field/u);
  });

  test("closing the window releases the paused PTY and stops batching", () => {
    const f = rig();
    const session = f.create({ flowControl: true });
    f.ptys[0]?.emitData("0123456789abcdef");
    f.timers.run();
    assert.equal(f.ptys[0]?.pauses, 1);
    f.sender.fire("destroyed");
    assert.equal(f.ptys[0]?.killed, true, "PTY terminated with the window");
    assert.equal(f.timers.pending, 0, "no batching timers left behind");
    assert.equal(f.manager.flowStats(session.id), undefined, "buffer released");
    assert.equal(f.manager.flow.openBuffers, 0);
  });

  test("dispose flushes the tail and drops the buffer", () => {
    const f = rig();
    const session = f.create({ flowControl: true });
    f.ptys[0]?.emitData("tail");
    f.invoke(TERMINAL_IPC_CHANNELS.dispose, { id: session.id });
    assert.deepEqual(f.data(), ["tail"]);
    assert.equal(f.manager.flowStats(session.id), undefined);
    assert.equal(f.manager.flow.openBuffers, 0);
  });
});
