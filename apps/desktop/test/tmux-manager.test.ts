import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";
import { TmuxControlManager } from "../src/tmux/manager.js";
import type { RemoteConnectionManager } from "../src/remote/manager.js";
import type { TmuxTopology } from "../src/tmux/tmux-shared.js";
import { tmuxLayoutChecksum } from "../src/tmux/layout.js";

const layoutBody = "80x24,0,0,0";
class ControlProcess extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough();
  exitCode: number | null = null; signalCode = null; pid = undefined;
  commands: string[] = []; version = "3.2a"; capture = "shell prompt"; sequence = 1;
  stdin = new Writable({ write: (chunk, _encoding, done) => { this.command(chunk.toString()); done(); }, final: done => { this.exitCode = 0; this.emit("close", 0); done(); } });
  constructor() { super(); queueMicrotask(() => this.respond([])); }
  command(text: string) {
    this.commands.push(text);
    if (text === "\n") { this.stdout.write("%exit\n"); return; }
    let result: string[] = [];
    if (text.startsWith("display-message -p '#{version}")) result = [this.version];
    else if (text.startsWith("display-message -p '#{session_id}")) result = ["$0\tcap"];
    else if (text.startsWith("list-windows")) result = [`@0\t0\t1\t*\t${tmuxLayoutChecksum(layoutBody)},${layoutBody}\t${tmuxLayoutChecksum(layoutBody)},${layoutBody}\tshell`];
    else if (text.startsWith("list-panes") || text.startsWith("display-message -p -t")) result = ["%0\t@0\t1\t0\t0\t3\t2\t1\t0\t0\t0\t1\t0\t0\t23\t1\tshell"];
    else if (text.startsWith("capture-pane")) result = [this.capture];
    queueMicrotask(() => this.respond(result));
  }
  respond(lines: string[]) { const n = this.sequence++; this.stdout.write(`%begin 1 ${n} 1\n${lines.length ? lines.join("\n") + "\n" : ""}%end 1 ${n} 1\n`); }
  kill() { this.exitCode = 1; this.emit("close", 1); return true; }
  lose() { this.stderr.write("connection reset"); this.exitCode = 255; this.emit("close", 255); }
}
const until = async (predicate: () => boolean) => { for (let attempt = 0; !predicate(); attempt++) { assert.ok(attempt < 400, "condition timed out"); await new Promise(resolve => setTimeout(resolve, 5)); } };
function harness(path: Promise<{ path: string }> = Promise.resolve({ path: "/tmp" }), version = "3.2a") {
  const processes: ControlProcess[] = [], topology: TmuxTopology[] = [], output: string[] = [], order: string[] = [];
  const remote = { environment: { platform: "linux" }, transport: { peer: { request: () => path } } };
  const manager = new TmuxControlManager({
    connections: { get: () => remote, profile: () => ({ host: "example.test" }), authentication: () => undefined, assertWritable() {} } as unknown as RemoteConnectionManager,
    spawnControl: (_file, args) => { assert.equal(args[0], "-T"); const process = new ControlProcess(); process.version = version; processes.push(process); return process as unknown as ChildProcessWithoutNullStreams; },
    batchOptions: { batchMs: 1, highWaterBytes: 1024, lowWaterBytes: 100 }, detachTimeoutMs: 20,
  });
  const listeners = { onTopology(value: TmuxTopology) { topology.push(value); order.push("topology"); }, onData(event: { data: string }) { output.push(event.data); order.push("data"); }, onExit() {} };
  const attach = () => manager.attach(1, { targetId: "remote", workspaceId: "ws", session: "cap", cols: 80, rows: 24, flowControl: true }, listeners);
  return { manager, processes, topology, output, order, attach };
}
test("attach publishes pane identities before restore, routes writes, and isolates window ownership", async () => {
  const h = harness();
  try {
    const { connectionId } = await h.attach();
    await until(() => h.output.length > 0);
    const snapshot = h.topology.at(-1)!;
    const terminalId = snapshot.panes["%0"]!.terminalId;
    assert.ok(h.order.indexOf("topology") < h.order.indexOf("data"));
    assert.ok(h.output.join("").includes("shell prompt"));
    assert.deepEqual(h.processes[0]!.commands.slice(0, 3), ["display-message -p '#{version}'\n", "refresh-client -f pause-after=15\n", "refresh-client -C 80x24\n"]);
    h.manager.write(2, terminalId, "wrong owner");
    h.manager.write(1, terminalId, "ls\r");
    assert.equal(h.processes[0]!.commands.at(-1), "send-keys -t %0 -H 6c 73 0d\n");
    assert.equal((await h.attach()).connectionId, connectionId);
    assert.equal(h.processes.length, 1);
    assert.equal(h.manager.hasTarget("remote"), true);
    await h.manager.detach(1, connectionId);
    assert.equal(h.processes[0]!.commands.at(-1), "\n");
    assert.equal(h.manager.hasTarget("remote"), false);
  } finally { await h.manager.disposeAll(); }
});
test("output pauses SSH at the high watermark, resumes on ACK, and recaptures a paused pane", async () => {
  const h = harness();
  try {
    await h.attach(); await until(() => h.output.length > 0);
    const process = h.processes[0]!, terminalId = h.topology.at(-1)!.panes["%0"]!.terminalId;
    h.manager.acknowledge(1, terminalId, 1e6);
    process.stdout.write(`%output %0 ${"x".repeat(2000)}\n`);
    await until(() => process.stdout.isPaused());
    h.manager.acknowledge(1, terminalId, 1e6);
    assert.equal(process.stdout.isPaused(), false);
    process.capture = "fresh screen";
    process.stdout.write("%pause %0\n");
    await until(() => h.output.join("").includes("fresh screen"));
    assert.ok(process.commands.includes("refresh-client -A '%0:continue'\n"));
    process.stdout.write("%subscription-changed studio-cwd $0 @0 0 %0 : /work/with space\n");
    await until(() => h.topology.at(-1)?.panes["%0"]?.cwd === "/work/with space");
  } finally { await h.manager.disposeAll(); }
});
test("SSH loss keeps an ended snapshot; versions below 3.2 detach with a useful reason", async () => {
  const h = harness();
  try {
    await h.attach(); await until(() => h.output.length > 0);
    h.processes[0]!.lose();
    assert.equal(h.topology.at(-1)?.state, "lost");
    assert.equal(h.topology.at(-1)?.reason, "connection reset");
    assert.ok(h.topology.at(-1)?.panes["%0"]);
  } finally { await h.manager.disposeAll(); }
  const old = harness(undefined, "3.1c");
  try {
    const attaching = old.attach();
    await attaching;
    await until(() => old.topology.at(-1)?.state === "exited");
    assert.equal(old.topology.at(-1)?.reason, "too-old");
    assert.ok(old.processes[0]!.commands.includes("\n"));
  } finally { await old.manager.disposeAll(); }
});
test("window teardown during workspace lookup never spawns an orphan connection", async () => {
  let finish!: (path: { path: string }) => void;
  const h = harness(new Promise(resolve => { finish = resolve; }));
  const opening = h.attach();
  await h.manager.disposeWindow(1);
  finish({ path: "/tmp" });
  await assert.rejects(opening, /window has closed/);
  assert.equal(h.processes.length, 0);
});
