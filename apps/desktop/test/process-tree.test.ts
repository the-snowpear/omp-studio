import assert from "node:assert/strict";
import { test } from "node:test";

import { processGroupSpawnOptions, terminateProcessTree } from "../src/platform/process-tree.js";

function child(state: { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null } = { pid: 99 }) {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  return { value: { pid: state.pid, exitCode: state.exitCode ?? null, signalCode: state.signalCode ?? null, kill: (signal?: NodeJS.Signals | number) => { signals.push(signal); return true; } }, signals };
}

test("POSIX children lead their own process group; Windows spawns stay unchanged", () => {
  assert.deepEqual(processGroupSpawnOptions("darwin"), { detached: true });
  assert.deepEqual(processGroupSpawnOptions("win32"), {});
});

test("POSIX termination signals the whole group and Windows walks the tree", () => {
  const groups: Array<[number, NodeJS.Signals]> = [];
  terminateProcessTree(child().value, "SIGKILL", { platform: "darwin", killGroup: (pgid, signal) => groups.push([pgid, signal]) });
  assert.deepEqual(groups, [[99, "SIGKILL"]]);
  const taskkills: number[] = [];
  terminateProcessTree(child().value, "SIGKILL", { platform: "win32", spawnTaskkill: (pid) => taskkills.push(pid) });
  assert.deepEqual(taskkills, [99]);
});

test("finished processes are left alone and a non-leader falls back to itself", () => {
  const groups: number[] = [];
  const killGroup = (pgid: number) => { groups.push(pgid); };
  terminateProcessTree(child({ pid: 1, exitCode: 0 }).value, "SIGKILL", { platform: "darwin", killGroup });
  terminateProcessTree(child({ pid: 2, signalCode: "SIGTERM" }).value, "SIGKILL", { platform: "darwin", killGroup });
  terminateProcessTree(child({}).value, "SIGKILL", { platform: "darwin", killGroup });
  assert.deepEqual(groups, []);
  const lone = child();
  terminateProcessTree(lone.value, "SIGTERM", { platform: "darwin", killGroup: () => { throw new Error("ESRCH"); } });
  assert.deepEqual(lone.signals, ["SIGTERM"]);
});
