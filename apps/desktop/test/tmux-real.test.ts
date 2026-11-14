import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { TmuxControlManager } from "../src/tmux/manager.js";
import { quoteTmux } from "../src/tmux/commands.js";
import type { TmuxTopology } from "../src/tmux/tmux-shared.js";
import type { RemoteConnectionManager } from "../src/remote/manager.js";

// Optional real transport. No host names or credentials are embedded in tests.
const ssh = process.env.TMUX_TEST_SSH, container = process.env.TMUX_TEST_CONTAINER;
const available = !!ssh || spawnSync("tmux", ["-V"]).status === 0;
test("real control connection: restore, split, Unicode input, hide, detach and reattach", { skip: !available, timeout: 60_000 }, async () => {
  const socket = `studio-test-${randomUUID()}`;
  const remote = { environment: { platform: "linux" }, transport: { peer: { request: async () => ({ path: "/tmp" }) } } };
  const launch = (command: string) => {
    const wrapped = container ? `docker exec -i ${quoteTmux(container)} /bin/sh -c ${quoteTmux(command)}` : command;
    return ssh ? spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes", ssh, wrapped], { windowsHide: true }) : spawn("/bin/sh", ["-c", command]);
  };
  const execute = (command: string) => new Promise<string>((resolve, reject) => {
    const child = launch(command); let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr))); child.stdin.end();
  });
  const manager = new TmuxControlManager({
    connections: { get: () => remote, profile: () => ({ host: "test" }), authentication: () => undefined, assertWritable() {} } as unknown as RemoteConnectionManager,
    spawnControl: (_file, args) => launch(args.at(-1)!.replaceAll("tmux -u", `tmux -L ${socket} -f /dev/null -u`)),
  });
  let topology: TmuxTopology | undefined;
  const known = new Set<string>(), output: string[] = [];
  const listeners = { onTopology(value: TmuxTopology) { topology = value; for (const pane of Object.values(value.panes)) known.add(pane.terminalId); }, onData(event: { id: string; data: string; bytes?: number }) { assert.ok(known.has(event.id), "topology precedes pane output"); output.push(event.data); manager.acknowledge(1, event.id, event.bytes ?? Buffer.byteLength(event.data)); }, onExit() {} };
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 12_000; while (!predicate()) { if (Date.now() > deadline) assert.fail(`timed out; state=${topology?.state} reason=${topology?.reason}`); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const input = { targetId: "remote", workspaceId: "ws", session: "studio-test", cols: 100, rows: 30, flowControl: true };
  try {
    const first = await manager.attach(1, input, listeners);
    await wait(() => topology?.state === "attached" && output.length > 0);
    const paneId = Object.keys(topology!.panes)[0]!, terminalId = topology!.panes[paneId]!.terminalId;
    manager.write(1, terminalId, "printf 'tmux-ready-中文\\n'\r");
    await wait(() => output.join("").includes("tmux-ready-中文"));
    await manager.command(1, { connectionId: first.connectionId, action: { kind: "splitPane", paneId, direction: "right" } });
    await wait(() => Object.keys(topology!.panes).length === 2);
    await manager.command(1, { connectionId: first.connectionId, action: { kind: "renameWindow", windowId: topology!.windows[0]!.id, name: "literal #{pane_id}; '$HOME" } });
    await wait(() => topology!.windows[0]!.name.includes("#{pane_id}"));
    await manager.command(1, { connectionId: first.connectionId, action: { kind: "setPaneVisible", paneIds: [paneId], visible: false } });
    await manager.command(1, { connectionId: first.connectionId, action: { kind: "setPaneVisible", paneIds: [paneId], visible: true } });
    await manager.detach(1, first.connectionId);
    await execute(`tmux -L ${socket} has-session -t studio-test`);
    const before = output.length;
    const second = await manager.attach(1, input, listeners);
    assert.notEqual(first.connectionId, second.connectionId);
    await wait(() => topology?.state === "attached" && output.length > before);
    assert.equal(Object.keys(topology!.panes).length, 2);
    assert.ok(output.slice(before).join("").includes("tmux-ready-中文"));
    await manager.detach(1, second.connectionId);
  } finally {
    await manager.disposeAll();
    await execute(`tmux -L ${socket} kill-server`).catch(() => {});
  }
});
