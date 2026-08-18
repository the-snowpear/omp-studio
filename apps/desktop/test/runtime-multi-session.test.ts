import assert from "node:assert/strict";
import { test } from "node:test";

import type { HostRuntimeHelloView } from "@omp-studio/host-client-api";
import { InMemorySessionLeaseStore } from "@omp-studio/studio-host";
import type {
  OperatorStateSnapshot,
  RuntimeEpoch,
  SessionId,
  StateVersion,
  StudioOperation,
  StudioReceipt,
} from "@omp-studio/studio-protocol";

import type { DesktopRuntimeSession, DesktopRuntimeSessionPort } from "../src/host-composition.js";
import { createDesktopRuntimeSessionPort, type DesktopRuntimeSessionPortOptions } from "../src/runtime-session.js";

const T0 = "2026-08-15T21:30:00.000Z";

function snapshot(sessionId: string, runtimeEpoch: number, streaming = false): OperatorStateSnapshot {
  return {
    runtimeId: `runtime-${sessionId}` as never,
    runtimeEpoch: runtimeEpoch as RuntimeEpoch,
    stateVersion: 1 as StateVersion,
    sessionId: sessionId as SessionId,
    isStreaming: streaming,
    isCompacting: false,
    activeMode: "normal", approvalMode: "yolo",
    plan: { status: "off" },
    goal: { status: "off" },
    pause: { paused: false },
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

function fakeWorkerFactory(state: {
  readonly created: Array<{ sessionId: string; epoch: number }>;
  readonly stopped: string[];
  readonly streaming: Set<string>;
  readonly failInvoke: Set<string>;
  readonly dead: Set<string>;
  readonly invokes: Array<{ sessionId: string; operation: StudioOperation }>;
}): NonNullable<DesktopRuntimeSessionPortOptions["workerPortFactory"]> {
  let fresh = 0;
  return ({ resumeSessionId, nextRuntimeEpoch }) => {
    const sessionId = resumeSessionId ?? `fresh-${++fresh}`;
    const epoch = nextRuntimeEpoch();
    state.created.push({ sessionId, epoch });
    state.dead.delete(sessionId);
    let alive = true;
    const current = () => snapshot(sessionId, epoch, state.streaming.has(sessionId));
    const session = {
      controller: {
        publication: () => ({ commitSeq: 1, publishedAt: T0, snapshot: current(), terminalOutcomes: [] }),
        invoke: async (request: { requestId: string; operation: StudioOperation }): Promise<StudioReceipt> => {
          if (state.failInvoke.has(sessionId)) {
            throw new Error(`invoke failed for ${sessionId}`);
          }
          state.invokes.push({ sessionId, operation: request.operation });
          return {
            type: "studio.receipt",
            requestId: request.requestId,
            runtimeEpoch: epoch,
            stateVersion: 1,
            status: "completed",
            result: {},
          } as StudioReceipt;
        },
      },
      hello: () =>
        alive && !state.dead.has(sessionId)
          ? ({ runtimeId: `runtime-${sessionId}`, runtimeEpoch: epoch, classification: "managed" } satisfies HostRuntimeHelloView)
          : undefined,
      capabilityManifest: () => undefined,
      commandManifest: () => undefined,
      onPublication: () => () => undefined,
    } as unknown as DesktopRuntimeSession;
    return {
      async start() {
        return session;
      },
      async stop() {
        if (!alive) return;
        alive = false;
        state.stopped.push(sessionId);
      },
    } satisfies DesktopRuntimeSessionPort;
  };
}

function createHarness(maxResidentSessions?: number, idleWorkerTtlMs = 10 * 60_000) {
  const state = {
    created: [] as Array<{ sessionId: string; epoch: number }>,
    stopped: [] as string[],
    streaming: new Set<string>(),
    failInvoke: new Set<string>(),
    dead: new Set<string>(),
    invokes: [] as Array<{ sessionId: string; operation: StudioOperation }>,
  };
  const port = createDesktopRuntimeSessionPort({
    ...(maxResidentSessions === undefined ? {} : { maxResidentSessions }),
    idleWorkerTtlMs,
    ownerId: "broker-test",
    sessionLeaseStore: new InMemorySessionLeaseStore(),
    workerPortFactory: fakeWorkerFactory(state),
  });
  return { port, state };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Worker lifecycle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const context = {
  resolution: { classification: "managed" } as never,
  endpoint: { kind: "private", authority: "test" } as never,
  profileDirectory: "C:/profile",
  runtimeInstallDirectory: "C:/runtime",
  workspace: { workspaceId: "workspace-a", cwd: "C:/workspace" },
};

test("desktop multi-session port keeps A and B resident when selecting A again", async () => {
  const { port, state } = createHarness();
  const fresh = await port.start(context);
  assert.equal(fresh?.controller.publication()?.snapshot.sessionId, "fresh-1");
  const sessionB = await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  const sessionA = await port.switchSession?.({ kind: "resume", sessionId: "fresh-1" });
  assert.equal(sessionB?.controller.publication()?.snapshot.sessionId, "session-b");
  assert.equal(sessionA, fresh);
  assert.deepEqual(state.created, [
    { sessionId: "fresh-1", epoch: 1 },
    { sessionId: "session-b", epoch: 2 },
  ]);
  assert.deepEqual(state.stopped, []);
  await port.stop();
  assert.deepEqual(new Set(state.stopped), new Set(["fresh-1", "session-b"]));
});

test("capacity hibernates only the least-recently-selected idle background Session", async () => {
  const { port, state } = createHarness(2);
  await port.start(context);
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  await port.switchSession?.({ kind: "resume", sessionId: "session-c" });
  assert.deepEqual(state.stopped, ["fresh-1"]);
  assert.deepEqual(state.created.map((entry) => entry.sessionId), ["fresh-1", "session-b", "session-c"]);
  await port.stop();
});

test("capacity never evicts a streaming background Session", async () => {
  const { port, state } = createHarness(2);
  state.streaming.add("fresh-1");
  await port.start(context);
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  await assert.rejects(
    () => port.switchSession!({ kind: "resume", sessionId: "session-c" }),
    /capacity is exhausted/,
  );
  assert.deepEqual(state.stopped, []);
  assert.deepEqual(state.created.map((entry) => entry.sessionId), ["fresh-1", "session-b"]);
  await port.stop();
});

test("default Worker residency has no application-level count cap", async () => {
  const { port, state } = createHarness();
  await port.start(context);
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  await port.switchSession?.({ kind: "resume", sessionId: "session-c" });
  await port.switchSession?.({ kind: "resume", sessionId: "session-d" });
  assert.equal(state.created.length, 4);
  assert.deepEqual(state.stopped, []);
  await port.stop();
});

test("completed idle background Workers hibernate after the configured TTL", async () => {
  const { port, state } = createHarness(undefined, 20);
  await port.start(context);
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  await waitFor(() => state.stopped.includes("fresh-1"));
  assert.deepEqual(state.stopped, ["fresh-1"]);
  await port.stop();
});

test("idle hibernation never stops a background Worker while it is streaming", async () => {
  const { port, state } = createHarness(undefined, 20);
  state.streaming.add("fresh-1");
  await port.start(context);
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(state.stopped, []);
  state.streaming.delete("fresh-1");
  await waitFor(() => state.stopped.includes("fresh-1"));
  assert.deepEqual(state.stopped, ["fresh-1"]);
  await port.stop();
});

test("idle TTL restarts after a streaming background Worker becomes idle", async () => {
  const ttl = 80;
  const { port, state } = createHarness(undefined, ttl);
  state.streaming.add("fresh-1");
  await port.start(context);
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  await new Promise((resolve) => setTimeout(resolve, ttl + 10));
  state.streaming.delete("fresh-1");
  await new Promise((resolve) => setTimeout(resolve, ttl + 20));
  assert.equal(state.stopped.includes("fresh-1"), false);
  await waitFor(() => state.stopped.includes("fresh-1"));
  await port.stop();
});

test("applyApprovalMode persists on the active Runtime and overrides siblings", async () => {
  const { port, state } = createHarness();
  await port.start(context); // fresh-1 active
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" }); // session-b active
  const result = await port.applyApprovalMode?.("write");
  assert.deepEqual(result, { mode: "write", syncStatus: "complete", appliedSessions: 2, failedSessions: 0 });
  const bySession = Object.fromEntries(
    state.invokes.map((entry) => [entry.sessionId, entry.operation]),
  );
  assert.deepEqual(bySession["session-b"], { kind: "permissions.mode.set", mode: "write", persist: true });
  assert.deepEqual(bySession["fresh-1"], { kind: "permissions.mode.set", mode: "write", persist: false });
  await port.stop();
});

test("applyApprovalMode reports partial when a sibling fails and re-syncs the next launch", async () => {
  const { port, state } = createHarness();
  await port.start(context); // fresh-1 active
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" }); // session-b active
  state.failInvoke.add("fresh-1");
  const result = await port.applyApprovalMode?.("always-ask");
  assert.deepEqual(result, { mode: "always-ask", syncStatus: "partial", appliedSessions: 1, failedSessions: 1 });
  // A fresh active Worker retries the durable write, then re-applies the
  // mode to every resident before the pending marker can clear.
  state.failInvoke.delete("fresh-1");
  await port.switchSession?.({ kind: "fresh" });
  await waitFor(() =>
    state.invokes.some(
      (entry) => entry.sessionId === "fresh-2" && entry.operation.kind === "permissions.mode.set",
    ),
  );
  const reapply = state.invokes.find(
    (entry) => entry.sessionId === "fresh-2" && entry.operation.kind === "permissions.mode.set",
  );
  assert.deepEqual(reapply?.operation, { kind: "permissions.mode.set", mode: "always-ask", persist: true });
  assert.equal(
    state.invokes.some(
      (entry) =>
        entry.sessionId === "fresh-1" &&
        entry.operation.kind === "permissions.mode.set" &&
        entry.operation.persist === false,
    ),
    true,
  );
  await port.stop();
});

test("approval mode retry does not clear while any resident remains unsynchronized", async () => {
  const { port, state } = createHarness();
  await port.start(context); // fresh-1
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  await port.switchSession?.({ kind: "resume", sessionId: "session-c" }); // active
  state.failInvoke.add("fresh-1");
  state.failInvoke.add("session-b");
  const first = await port.applyApprovalMode?.("always-ask");
  assert.deepEqual(first, {
    mode: "always-ask",
    syncStatus: "partial",
    appliedSessions: 1,
    failedSessions: 2,
  });

  // session-b can now persist, but fresh-1 is still failing. The pending
  // mode must remain after this otherwise-successful activation.
  state.failInvoke.delete("session-b");
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  assert.equal(
    state.invokes.some(
      (entry) =>
        entry.sessionId === "session-b" &&
        entry.operation.kind === "permissions.mode.set" &&
        entry.operation.persist === true,
    ),
    true,
  );

  // Once the final failed resident recovers, selecting another resident
  // retries the complete set and reaches fresh-1 before clearing pending.
  state.failInvoke.delete("fresh-1");
  await port.switchSession?.({ kind: "resume", sessionId: "session-c" });
  assert.equal(
    state.invokes.some(
      (entry) =>
        entry.sessionId === "fresh-1" &&
        entry.operation.kind === "permissions.mode.set" &&
        entry.operation.persist === false,
    ),
    true,
  );
  await port.stop();
});

test("applyApprovalMode fails closed without any resident Runtime", async () => {
  const { port } = createHarness();
  await assert.rejects(() => port.applyApprovalMode!("yolo"), /No Runtime session is available/);
});

test("ensure is a no-op when the active Runtime hello is still live", async () => {
  const { port, state } = createHarness();
  const first = await port.start(context);
  assert.equal(first?.controller.publication()?.snapshot.sessionId, "fresh-1");
  const next = await port.ensure!();
  assert.equal(next, first);
  assert.deepEqual(state.created, [{ sessionId: "fresh-1", epoch: 1 }]);
  assert.deepEqual(state.stopped, []);
  await port.stop();
});

test("ensure relaunches the active session when its hello is gone", async () => {
  const { port, state } = createHarness();
  await port.start(context);
  state.dead.add("fresh-1");
  const next = await port.ensure!();
  assert.equal(next?.controller.publication()?.snapshot.sessionId, "fresh-1");
  assert.deepEqual(state.stopped, ["fresh-1"]);
  assert.deepEqual(state.created, [
    { sessionId: "fresh-1", epoch: 1 },
    { sessionId: "fresh-1", epoch: 2 },
  ]);
  await port.stop();
});
