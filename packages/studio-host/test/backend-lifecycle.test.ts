import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import type {
  EnvironmentId,
  RuntimeEpoch,
  RuntimeId,
  SessionBinding,
  ThreadId,
  WorkspaceId,
} from "@omp-studio/studio-protocol";
import {
  CommandLedger,
  HostBackend,
  NodeRuntimeProcessPort,
  PtyAttachTicketRegistry,
  RuntimePtyTransport,
  StudioHostRuntimeActor,
  ThreadBindingStore,
  WindowsJobObjectContainment,
} from "../src/index.js";

function binding(epoch = 1): SessionBinding {
  return {
    threadId: "thread-backend" as ThreadId,
    environmentId: "environment-backend" as EnvironmentId,
    workspaceId: "workspace-backend" as WorkspaceId,
    runtimeId: "runtime-backend" as RuntimeId,
    runtimeEpoch: epoch as RuntimeEpoch,
    classification: "managed",
    backend: "studio-host",
    runtimeVersion: "17.2.12-studio.13",
    upstreamVersion: "17.2.12",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    capabilityHash: "capabilities",
  };
}

test("REC-003 relaunch waits for owner loss, preserves version, and advances Runtime epoch", async () => {
  const starts: SessionBinding[] = [];
  let exit: (() => void) | undefined;
  const actor = new StudioHostRuntimeActor(
    {
      start: async value => { starts.push(structuredClone(value)); },
      stop: async () => undefined,
      onExit(listener) { exit = listener; return () => { exit = undefined; }; },
    },
    new CommandLedger(),
  );
  await actor.start(binding());
  await assert.rejects(() => actor.relaunch(), /stopped or crashed/u);
  exit?.();
  const relaunched = await actor.relaunch();
  assert.equal(relaunched.runtimeEpoch, 2);
  assert.equal(relaunched.runtimeVersion, "17.2.12-studio.13");
  assert.equal(starts.length, 2);
  assert.equal(actor.state, "running");
});

test("WP-064 durable Thread bindings drive Runtime reference protection", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-bindings-"));
  const path = join(temporary, "thread-bindings.json");
  const store = new ThreadBindingStore(path);
  await store.bind(binding(), "sha256:executable");
  assert.equal(store.isRuntimeReferenced("17.2.12-studio.13"), true);
  assert.deepEqual(store.referencingThreads("17.2.12-studio.13"), ["thread-backend"]);
  const restored = new ThreadBindingStore(path);
  await restored.load();
  assert.equal(restored.get("thread-backend" as ThreadId)?.binding.runtimeEpoch, 1);
  await restored.unbind("thread-backend" as ThreadId);
  assert.equal(JSON.parse(await readFile(path, "utf8")).length, 0);
});

test("backend composition wires Thread references into installer retention", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-backend-composition-"));
  const backend = new HostBackend({ stateDirectory: temporary });
  await backend.initialize();
  await backend.bind(binding(), "sha256:executable");
  await assert.rejects(() => backend.installer.uninstall("17.2.12-studio.13"), /active Thread binding/u);
  await backend.unbind(binding());
  assert.equal(backend.bindings.isRuntimeReferenced("17.2.12-studio.13"), false);
});

test("HostBackend keeps the managed Runtime tree at runtimeInstallDirectory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "omp-studio-backend-runtime-"));
  const install = join(temporary, "install-runtime");
  const backend = new HostBackend({
    stateDirectory: join(temporary, "profile"),
    runtimeInstallDirectory: install,
  });
  assert.equal(backend.installer.rootDirectory, install);
  const defaulted = new HostBackend({ stateDirectory: join(temporary, "profile-default") });
  assert.equal(defaulted.installer.rootDirectory, join(temporary, "profile-default", "runtimes"));
});

test("Windows Job Object containment attaches, terminates, and closes through the native seam", async () => {
  const calls: string[] = [];
  const containment = new WindowsJobObjectContainment({
    createKillOnClose: () => "job-handle",
    assign: (handle, pid) => { calls.push(`assign:${handle}:${pid}`); },
    terminate: handle => { calls.push(`terminate:${handle}`); },
    close: handle => { calls.push(`close:${handle}`); },
  });
  const child = Object.assign(new EventEmitter(), { pid: 42, kill: () => true }) as unknown as ChildProcess;
  await containment.attach(child);
  await containment.forceStop(child);
  await containment.release(child);
  assert.deepEqual(calls, ["assign:job-handle:42", "terminate:job-handle", "close:job-handle"]);
});

test("Node Runtime process lifecycle calls containment attach and release", async () => {
  const calls: string[] = [];
  class FakeChild extends EventEmitter {
    pid = 43;
    kill(): boolean { queueMicrotask(() => this.emit("exit", 0, null)); return true; }
  }
  const port = new NodeRuntimeProcessPort({
    executable: "fixture.exe",
    cwd: process.cwd(),
    args: () => [],
    spawnProcess: (() => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    }) as never,
    containment: {
      attach: () => { calls.push("attach"); },
      requestStop: child => { calls.push("stop"); child.kill(); },
      forceStop: () => { calls.push("force"); },
      release: () => { calls.push("release"); },
    },
  });
  await port.start(binding());
  await port.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["attach", "stop", "release"]);
});

test("SEC-003 PTY transport consumes scoped tickets and retains a bounded opaque byte tail", async () => {
  let ticket = 0;
  const tickets = new PtyAttachTicketRegistry({ randomToken: () => `ticket-${++ticket}`.padEnd(32, "x") });
  const calls: string[] = [];
  const runtime = { runtimeId: "runtime-backend", runtimeEpoch: 1 };
  const transport = new RuntimePtyTransport(runtime, tickets, {
    write: data => { calls.push(`write:${Buffer.from(data).toString()}`); },
    resize: (columns, rows) => { calls.push(`resize:${columns}x${rows}`); },
    signal: signal => { calls.push(`signal:${signal}`); },
    terminate: () => { calls.push("terminate"); },
    close: () => { calls.push("close"); },
  }, 5);
  transport.acceptOutput(Buffer.from("123"));
  transport.acceptOutput(Buffer.from("4567"));
  assert.equal(transport.outputTail().toString(), "34567");
  await transport.write(tickets.issue(runtime, ["write"]).token, Buffer.from("input"));
  await transport.resize(tickets.issue(runtime, ["resize"]).token, 120, 40);
  await transport.signal(tickets.issue(runtime, ["signal"]).token, "SIGINT");
  await transport.terminate(tickets.issue(runtime, ["terminate"]).token);
  await transport.close();
  assert.deepEqual(calls, ["write:input", "resize:120x40", "signal:SIGINT", "terminate", "close"]);
  assert.throws(() => transport.acceptOutput(Buffer.from("x")), /closed/u);
});
