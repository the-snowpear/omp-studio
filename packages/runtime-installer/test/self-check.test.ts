import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createSmokeTestRunner } from "../src/index.js";
import type { SelfCheckChild, SelfCheckSpawn } from "../src/index.js";

interface SpawnCall {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; stdio: "ignore"; windowsHide: boolean };
}

function fakeChild(onKill?: (emitter: EventEmitter) => void): SelfCheckChild & { emitter: EventEmitter } {
  const emitter = new EventEmitter();
  return {
    emitter,
    once: (event, listener) => emitter.once(event, listener),
    kill: () => {
      onKill?.(emitter);
      return true;
    },
  };
}

function recordingSpawn(calls: SpawnCall[], child: SelfCheckChild): SelfCheckSpawn {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return child;
  };
}

test("smoke-test runner spawns the entrypoint with --smoke-test and resolves on exit 0", async () => {
  const calls: SpawnCall[] = [];
  const child = fakeChild();
  const runner = createSmokeTestRunner({ spawn: recordingSpawn(calls, child), env: { TEST_ENV: "1" } });
  const completed = runner.run("C:\\runtimes\\v1\\omp.exe");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.command, "C:\\runtimes\\v1\\omp.exe");
  assert.deepEqual(call.args, ["--smoke-test"]);
  assert.equal(call.options.stdio, "ignore");
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env?.TEST_ENV, "1");
  child.emitter.emit("close", 0);
  await completed;
});

test("smoke-test runner rejects on a non-zero exit", async () => {
  const child = fakeChild();
  const runner = createSmokeTestRunner({ spawn: recordingSpawn([], child) });
  const completed = runner.run("entrypoint");
  child.emitter.emit("close", 1);
  await assert.rejects(completed, /failed with exit 1/u);
});

test("smoke-test runner rejects when the child fails to start", async () => {
  const child = fakeChild();
  const runner = createSmokeTestRunner({ spawn: recordingSpawn([], child) });
  const completed = runner.run("entrypoint");
  child.emitter.emit("error", new Error("ENOENT"));
  await assert.rejects(completed, /failed to start.*ENOENT/u);
});

test("smoke-test runner rejects when spawn throws synchronously", async () => {
  const runner = createSmokeTestRunner({
    spawn: () => { throw new Error("spawn blocked"); },
  });
  await assert.rejects(runner.run("entrypoint"), /Failed to start.*spawn blocked/u);
});

test("smoke-test runner rejects when the self-check times out", async () => {
  const child = fakeChild((emitter) => queueMicrotask(() => emitter.emit("close", null)));
  const runner = createSmokeTestRunner({
    spawn: recordingSpawn([], child),
    timeoutMs: 20,
  });
  await assert.rejects(runner.run("entrypoint"), /timed out after 20ms/u);
});
