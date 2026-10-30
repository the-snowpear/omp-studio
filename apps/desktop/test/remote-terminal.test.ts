import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteTerminalManager, remoteTerminalCommand } from "../src/remote/terminal.js";
import type { RemoteConnectionManager } from "../src/remote/manager.js";
import type { PtySpawnOptions } from "../src/terminal-pty.js";

function fixture(path: Promise<{ path: string }> = Promise.resolve({ path: "/work/a'b" })) {
  const writes: string[] = [];
  const spawns: PtySpawnOptions[] = [];
  let killed = 0;
  const remote = { environment: { platform: "linux" }, transport: { peer: { request: () => path } } };
  const manager = new RemoteTerminalManager({ get: () => remote, profile: () => ({ host: "test-host", name: "Test" }), assertWritable: () => {}, authentication: () => undefined } as unknown as RemoteConnectionManager, {
    spawn(options) { spawns.push(options); return { write: data => { writes.push(data); }, resize: () => {}, kill: () => { killed++; }, onData: () => {}, onExit: () => {} }; },
  });
  return { manager, writes, spawns, killed: () => killed };
}

test("closing an SSH terminal terminates its PTY without typing into the foreground program", async () => {
  const f = fixture();
  const terminal = await f.manager.create(1, "target", "workspace", { cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  f.manager.write(1, terminal.id, "user input");
  f.manager.dispose(1, terminal.id);
  assert.deepEqual(f.writes, ["user input"]);
  assert.equal(f.killed(), 1);
  assert.equal(f.spawns[0]?.args?.[0], "-tt");
  assert.ok(f.spawns[0]?.args?.at(-1)?.includes("a'\\''b"));
});

test("closing a window during remote cwd lookup does not launch an orphan SSH terminal", async () => {
  let done!: (value: { path: string }) => void;
  const f = fixture(new Promise(resolve => { done = resolve; }));
  const opening = f.manager.create(1, "target", "workspace", { cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  f.manager.disposeWindow(1);
  done({ path: "/work/project" });
  await assert.rejects(opening, /window has closed/);
  assert.equal(f.spawns.length, 0);
});

test("Windows SSH shell exits if its requested working directory cannot be entered", () => {
  const command = remoteTerminalCommand("win32", "D:\\工作目录\\a'b");
  const script = Buffer.from(command.slice(1, -1).split(" ").at(-1)!, "base64").toString("utf16le");
  assert.ok(script.includes("Set-Location -LiteralPath 'D:\\工作目录\\a''b'"));
  assert.ok(script.includes("catch"));
  assert.ok(script.includes("exit 1"));
});

// ---- P2-1: the SSH path must satisfy the same flow-control contract --------

interface FlowFixture {
  readonly manager: RemoteTerminalManager;
  readonly data: string[];
  readonly events: string[];
  pauses(): number;
  resumes(): number;
  emit(text: string): void;
  exit(): void;
}

/** Fake SSH PTY that can produce output and records pause/resume. */
function flowFixture(): FlowFixture {
  const data: string[] = [];
  const events: string[] = [];
  let dataListener: (chunk: string) => void = () => {};
  let exitListener: (info: { exitCode: number }) => void = () => {};
  let pauses = 0;
  let resumes = 0;
  const remote = { environment: { platform: "linux" }, transport: { peer: { request: async () => ({ path: "/work" }) } } };
  const manager = new RemoteTerminalManager(
    { get: () => remote, profile: () => ({ host: "test-host", name: "Test" }), assertWritable: () => {}, authentication: () => undefined } as unknown as RemoteConnectionManager,
    {
      spawn() {
        return {
          write: (chunk: string) => { data.push(chunk); },
          resize: () => {},
          kill: () => {},
          pause: () => { pauses += 1; },
          resume: () => { resumes += 1; },
          onData: (listener: (chunk: string) => void) => { dataListener = listener; },
          onExit: (listener: (info: { exitCode: number }) => void) => { exitListener = listener; },
        };
      },
    },
  );
  return {
    manager,
    data,
    events,
    pauses: () => pauses,
    resumes: () => resumes,
    emit: (text) => dataListener(text),
    exit: () => exitListener({ exitCode: 0 }),
  };
}

/** Poll until `predicate` holds (the batcher flushes on a real 8 ms window). */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("SSH output is coalesced into one message per batching window", async () => {
  const f = flowFixture();
  const terminal = await f.manager.create(1, "target", "workspace", { cols: 80, rows: 24, flowControl: true }, {
    onData: (event) => f.events.push(event.data),
    onExit: () => {},
  });
  f.emit("a");
  f.emit("b");
  f.emit("c");
  assert.deepEqual(f.events, [], "nothing is forwarded before the window closes");
  await until(() => f.events.length === 1, "the batched SSH message");
  assert.deepEqual(f.events, ["abc"]);
  f.manager.dispose(1, terminal.id);
});

test("SSH PTY pauses above the high watermark and resumes on the renderer's ACK", async () => {
  const f = flowFixture();
  const terminal = await f.manager.create(1, "target", "workspace", { cols: 80, rows: 24, flowControl: true }, {
    onData: () => {},
    onExit: () => {},
  });
  const chunk = "x".repeat(512 * 1024); // ≥ the 500 KiB high watermark
  f.emit(chunk);
  await until(() => f.pauses() === 1, "the SSH PTY to be paused");
  // The renderer never acknowledged while unmounted: no resume yet.
  assert.equal(f.resumes(), 0);

  f.manager.acknowledge(1, terminal.id, chunk.length);
  assert.equal(f.resumes(), 1, "acknowledging the backlog resumes the SSH PTY");
  f.manager.dispose(1, terminal.id);
});

test("SSH PTY is never paused when the renderer did not negotiate flow control", async () => {
  const f = flowFixture();
  const terminal = await f.manager.create(1, "target", "workspace", { cols: 80, rows: 24 }, {
    onData: (event) => f.events.push(event.data),
    onExit: () => {},
  });
  const chunk = "y".repeat(600 * 1024);
  f.emit(chunk);
  f.emit(chunk);
  await until(() => f.events.join("").length === chunk.length * 2, "both SSH messages");
  assert.equal(f.pauses(), 0, "batched but never throttled, like the local shell");
  f.manager.dispose(1, terminal.id);
});

test("SSH dispose delivers the buffered tail before the exit event", async () => {
  const f = flowFixture();
  const terminal = await f.manager.create(1, "target", "workspace", { cols: 80, rows: 24, flowControl: true }, {
    onData: (event) => f.events.push(`data:${event.data}`),
    onExit: () => f.events.push("exit"),
  });
  f.emit("tail");
  // Dispose before the 8 ms window closes: the tail must still be delivered.
  f.manager.dispose(1, terminal.id);
  f.exit();
  assert.deepEqual(f.events, ["data:tail", "exit"]);
});
