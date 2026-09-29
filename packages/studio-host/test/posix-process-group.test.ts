import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { POSIX_PROCESS_GROUP_SPAWN_OPTIONS, PosixProcessGroupContainment } from "../src/index.js";

function fakeChild(state: { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null }) {
  const own: NodeJS.Signals[] = [];
  return {
    child: {
      pid: state.pid,
      exitCode: state.exitCode ?? null,
      signalCode: state.signalCode ?? null,
      kill: (signal?: NodeJS.Signals | number) => {
        own.push(signal as NodeJS.Signals);
        return true;
      },
    },
    own,
  };
}

test("stop signals go to the whole process group of a live leader", () => {
  const sent: Array<[number, NodeJS.Signals]> = [];
  const containment = new PosixProcessGroupContainment((pgid, signal) => sent.push([pgid, signal]));
  const { child } = fakeChild({ pid: 4242 });
  containment.requestStop(child);
  containment.forceStop(child);
  assert.deepEqual(sent, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
});

test("a reaped leader is never signalled, so a reused group id stays safe", () => {
  const sent: number[] = [];
  const containment = new PosixProcessGroupContainment((pgid) => sent.push(pgid));
  containment.forceStop(fakeChild({ pid: 1, exitCode: 0 }).child);
  containment.forceStop(fakeChild({ pid: 2, signalCode: "SIGKILL" }).child);
  containment.forceStop(fakeChild({}).child);
  assert.deepEqual(sent, []);
});

test("a child that is not a group leader falls back to signalling itself", () => {
  const containment = new PosixProcessGroupContainment(() => {
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  });
  const { child, own } = fakeChild({ pid: 7 });
  containment.requestStop(child);
  assert.deepEqual(own, ["SIGTERM"]);
});

test("forceStop also kills the tools a detached Runtime started", { skip: process.platform === "win32" ? "POSIX process groups" : false }, async () => {
  const leader = spawn("/bin/sh", ["-c", "sleep 60 & echo $!; wait"], { ...POSIX_PROCESS_GROUP_SPAWN_OPTIONS, stdio: ["ignore", "pipe", "ignore"] });
  const grandchild = Number(await new Promise<string>((resolve) => leader.stdout!.once("data", (data: Buffer) => resolve(data.toString().trim()))));
  const exited = new Promise<void>((resolve) => leader.once("exit", () => resolve()));
  new PosixProcessGroupContainment().forceStop(leader);
  await exited;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(grandchild, 0), /ESRCH/u);
});
