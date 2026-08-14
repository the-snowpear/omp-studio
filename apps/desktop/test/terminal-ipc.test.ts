/**
 * Desktop-chrome terminal IPC tests.
 *
 * Headless: fake ipcMain + fake PTY. No Electron, no native addon.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  TERMINAL_IPC_CHANNELS,
  TERMINAL_MAX_SESSIONS,
  parseCreateInput,
  parseDisposeInput,
  parseResizeInput,
  parseWriteInput,
  TerminalIpcError,
} from "../src/terminal-shared.js";
import {
  TerminalSessionManager,
  resolveDefaultShell,
  type PtyProcess,
  type PtySpawner,
} from "../src/terminal-pty.js";
import {
  registerTerminalIpc,
  type TerminalIpcMain,
  type TerminalSender,
} from "../src/terminal-ipc.js";

interface FakePty extends PtyProcess {
  readonly writes: string[];
  readonly resizes: Array<{ cols: number; rows: number }>;
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

function makeSpawner(ptys: FakePty[]): PtySpawner {
  return {
    spawn() {
      const pty = makePty();
      ptys.push(pty);
      return pty;
    },
  };
}

interface FakeSender extends TerminalSender {
  destroyed: boolean;
  readonly sent: Array<{ channel: string; payload: unknown }>;
  readonly onceListeners: Map<string, Set<() => void>>;
  fireOnce(event: string): void;
}

function makeSender(id: number): FakeSender {
  const onceListeners = new Map<string, Set<() => void>>();
  return {
    id,
    destroyed: false,
    sent: [],
    onceListeners,
    isDestroyed() {
      return this.destroyed;
    },
    getURL() {
      return "http://127.0.0.1:5173/";
    },
    send(channel, payload) {
      this.sent.push({ channel, payload });
    },
    once(event, listener) {
      let set = onceListeners.get(event);
      if (set === undefined) {
        set = new Set();
        onceListeners.set(event, set);
      }
      set.add(listener);
    },
    fireOnce(event) {
      for (const listener of [...(onceListeners.get(event) ?? [])]) listener();
      onceListeners.delete(event);
    },
  };
}

interface FakeIpc extends TerminalIpcMain {
  readonly handlers: Map<string, (event: { sender: TerminalSender }, payload?: unknown) => unknown>;
  readonly removed: string[];
}

function makeIpc(): FakeIpc {
  return {
    handlers: new Map(),
    removed: [],
    handle(channel, listener) {
      this.handlers.set(channel, listener);
    },
    removeHandler(channel) {
      this.removed.push(channel);
      this.handlers.delete(channel);
    },
  };
}

function register(trusted: (sender: TerminalSender) => boolean = () => true) {
  const ipc = makeIpc();
  const ptys: FakePty[] = [];
  const manager = new TerminalSessionManager({
    spawner: makeSpawner(ptys),
    resolveShell: () => ({ name: "pwsh", file: "pwsh.exe" }),
    resolveCwd: () => "D:\\work",
    newId: () => `term-${ptys.length + 1}xxxx`,
  });
  const handle = registerTerminalIpc({ ipcMain: ipc, isTrustedSender: trusted, manager });
  return {
    ipc,
    ptys,
    manager,
    handle,
    invoke(channel: string, sender: TerminalSender, payload?: unknown) {
      const handler = ipc.handlers.get(channel);
      assert.ok(handler, `no handler for ${channel}`);
      return handler({ sender }, payload);
    },
  };
}

describe("terminal payload validation", () => {
  test("create defaults missing size and rejects extras", () => {
    assert.deepEqual(parseCreateInput(undefined), { cols: 80, rows: 24 });
    assert.deepEqual(parseCreateInput({}), { cols: 80, rows: 24 });
    assert.deepEqual(parseCreateInput({ cols: 120, rows: 30 }), { cols: 120, rows: 30 });
    assert.throws(() => parseCreateInput({ cols: 120, rows: 30, extra: true }), TerminalIpcError);
    assert.throws(() => parseCreateInput({ cols: 0, rows: 24 }), TerminalIpcError);
  });

  test("write / resize / dispose reject malformed envelopes", () => {
    assert.deepEqual(parseWriteInput({ id: "term-abcdxxxx", data: "ls\r" }), {
      id: "term-abcdxxxx",
      data: "ls\r",
    });
    assert.throws(() => parseWriteInput({ id: "bad", data: "x" }), TerminalIpcError);
    assert.throws(() => parseWriteInput({ id: "term-abcdxxxx" }), TerminalIpcError);
    assert.deepEqual(parseResizeInput({ id: "term-abcdxxxx", cols: 40, rows: 12 }), {
      id: "term-abcdxxxx",
      cols: 40,
      rows: 12,
    });
    assert.throws(() => parseResizeInput({ id: "term-abcdxxxx", cols: 1, rows: 12 }), TerminalIpcError);
    assert.deepEqual(parseDisposeInput({ id: "term-abcdxxxx" }), { id: "term-abcdxxxx" });
    assert.throws(() => parseDisposeInput({ id: "term-abcdxxxx", extra: 1 }), TerminalIpcError);
  });
});

describe("resolveDefaultShell", () => {
  test("prefers pwsh on Windows when the file exists", () => {
    const shell = resolveDefaultShell({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
      exists: (path) => path.endsWith("PowerShell\\7\\pwsh.exe"),
    });
    assert.equal(shell.name, "pwsh");
    assert.equal(shell.file, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  test("falls back to ComSpec when no PowerShell is present", () => {
    const shell = resolveDefaultShell({
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "C:\\Windows" },
      exists: () => false,
    });
    assert.equal(shell.name, "cmd");
    assert.equal(shell.file, "C:\\Windows\\System32\\cmd.exe");
  });
});

describe("registerTerminalIpc", () => {
  test("registers exactly the four inbound channels", () => {
    const { ipc, handle } = register();
    assert.deepEqual(
      [...ipc.handlers.keys()].sort(),
      [
        TERMINAL_IPC_CHANNELS.create,
        TERMINAL_IPC_CHANNELS.dispose,
        TERMINAL_IPC_CHANNELS.resize,
        TERMINAL_IPC_CHANNELS.write,
      ].sort(),
    );
    assert.equal(ipc.handlers.has(TERMINAL_IPC_CHANNELS.data), false);
    handle.dispose();
  });

  test("rejects untrusted senders before spawning", () => {
    const { invoke, ptys, handle } = register(() => false);
    const sender = makeSender(1);
    assert.throws(() => invoke(TERMINAL_IPC_CHANNELS.create, sender, {}), /untrusted sender/);
    assert.equal(ptys.length, 0);
    handle.dispose();
  });

  test("create / write / resize / data / exit / dispose", () => {
    const { invoke, ptys, handle } = register();
    const sender = makeSender(7);
    const created = invoke(TERMINAL_IPC_CHANNELS.create, sender, { cols: 80, rows: 24 }) as {
      id: string;
      name: string;
      cwd: string;
    };
    assert.equal(created.name, "pwsh");
    assert.equal(created.cwd, "D:\\work");
    assert.equal(ptys.length, 1);
    invoke(TERMINAL_IPC_CHANNELS.write, sender, { id: created.id, data: "dir\r" });
    assert.deepEqual(ptys[0]?.writes, ["dir\r"]);
    invoke(TERMINAL_IPC_CHANNELS.resize, sender, { id: created.id, cols: 100, rows: 20 });
    assert.deepEqual(ptys[0]?.resizes, [{ cols: 100, rows: 20 }]);
    ptys[0]?.emitData("hello");
    assert.deepEqual(sender.sent, [{ channel: TERMINAL_IPC_CHANNELS.data, payload: { id: created.id, data: "hello" } }]);
    ptys[0]?.emitExit();
    assert.equal(sender.sent.at(-1)?.channel, TERMINAL_IPC_CHANNELS.exit);
    invoke(TERMINAL_IPC_CHANNELS.dispose, sender, { id: created.id });
    handle.dispose();
  });

  test("caps sessions per window and tears down on destroy", () => {
    const { invoke, ptys, handle } = register();
    const sender = makeSender(3);
    for (let i = 0; i < TERMINAL_MAX_SESSIONS; i += 1) {
      invoke(TERMINAL_IPC_CHANNELS.create, sender, {});
    }
    assert.equal(ptys.length, TERMINAL_MAX_SESSIONS);
    assert.throws(() => invoke(TERMINAL_IPC_CHANNELS.create, sender, {}), /at most/);
    sender.fireOnce("destroyed");
    assert.ok(ptys.every((pty) => pty.killed));
    handle.dispose();
  });

  test("dispose removes inbound handlers", () => {
    const { ipc, handle } = register();
    handle.dispose();
    assert.equal(ipc.handlers.size, 0);
    assert.ok(ipc.removed.includes(TERMINAL_IPC_CHANNELS.create));
  });
});
