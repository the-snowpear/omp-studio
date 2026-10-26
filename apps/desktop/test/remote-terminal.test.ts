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
