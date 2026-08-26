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
  readonly launchedIn: Array<{ sessionId: string; workspaceId: string; cwd: string }>;
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
      async start(launchContext) {
        // A Runtime binds its cwd at spawn; record what this Worker was
        // actually launched under so tests can prove no Session migrates.
        if (launchContext.workspace !== undefined) {
          state.launchedIn.push({
            sessionId,
            workspaceId: launchContext.workspace.workspaceId,
            cwd: launchContext.workspace.cwd,
          });
        }
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
    launchedIn: [] as Array<{ sessionId: string; workspaceId: string; cwd: string }>,
    adopted: [] as Array<{ workspaceId: string; cwd: string }>,
  };
  const port = createDesktopRuntimeSessionPort({
    ...(maxResidentSessions === undefined ? {} : { maxResidentSessions }),
    idleWorkerTtlMs,
    ownerId: "broker-test",
    sessionLeaseStore: new InMemorySessionLeaseStore(),
    workerPortFactory: fakeWorkerFactory(state),
  });
  port.attachWorkspaceSink?.((workspace) => {
    state.adopted.push({ ...workspace });
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

const WORKSPACE_A = { workspaceId: "workspace-a", cwd: "C:/workspace" };
const WORKSPACE_B = { workspaceId: "workspace-b", cwd: "C:/other" };

test("rebind to another workspace keeps the previous project's Workers resident", async () => {
  const { port, state } = createHarness();
  const inA = await port.start(context);
  assert.equal(inA?.controller.publication()?.snapshot.sessionId, "fresh-1");
  const inB = await port.rebind?.(WORKSPACE_B);
  assert.equal(inB?.controller.publication()?.snapshot.sessionId, "fresh-2");
  // The whole point: opening B does not stop A's Worker.
  assert.deepEqual(state.stopped, []);
  assert.equal(port.isResident?.("fresh-1"), true);
  assert.equal(port.isResident?.("fresh-2"), true);
  assert.deepEqual(state.launchedIn, [
    { sessionId: "fresh-1", workspaceId: "workspace-a", cwd: "C:/workspace" },
    { sessionId: "fresh-2", workspaceId: "workspace-b", cwd: "C:/other" },
  ]);
  await port.stop();
});

test("rebind back to a resident workspace selects its Worker without spawning", async () => {
  const { port, state } = createHarness();
  const inA = await port.start(context);
  await port.rebind?.(WORKSPACE_B);
  const backInA = await port.rebind?.(WORKSPACE_A);
  assert.equal(backInA, inA);
  assert.equal(state.created.length, 2);
  assert.deepEqual(state.stopped, []);
  await port.stop();
});

test("hasResidentForWorkspace reports live Workers per workspace", async () => {
  const { port, state } = createHarness();
  await port.start(context);
  assert.equal(port.hasResidentForWorkspace?.("workspace-a"), true);
  assert.equal(port.hasResidentForWorkspace?.("workspace-b"), false);
  await port.rebind?.(WORKSPACE_B);
  assert.equal(port.hasResidentForWorkspace?.("workspace-b"), true);
  // A Worker whose hello is gone no longer counts as resident, so the
  // composition treats the next rebind as a restart rather than a switch.
  state.dead.add("fresh-1");
  assert.equal(port.hasResidentForWorkspace?.("workspace-a"), false);
  await port.stop();
});

test("rebind replaces a dead Worker of the target workspace only", async () => {
  const { port, state } = createHarness();
  await port.start(context);
  await port.rebind?.(WORKSPACE_B);
  state.dead.add("fresh-1");
  const relaunched = await port.rebind?.(WORKSPACE_A);
  assert.equal(relaunched?.controller.publication()?.snapshot.sessionId, "fresh-3");
  assert.deepEqual(state.stopped, ["fresh-1"]);
  assert.equal(port.isResident?.("fresh-2"), true);
  assert.deepEqual(
    state.launchedIn.filter((entry) => entry.sessionId === "fresh-3"),
    [{ sessionId: "fresh-3", workspaceId: "workspace-a", cwd: "C:/workspace" }],
  );
  await port.stop();
});

test("a fresh Session lands in the workspace currently bound to the view", async () => {
  const { port, state } = createHarness();
  await port.start(context);
  await port.rebind?.(WORKSPACE_B);
  await port.switchSession?.({ kind: "fresh" });
  assert.deepEqual(
    state.launchedIn.filter((entry) => entry.sessionId === "fresh-3"),
    [{ sessionId: "fresh-3", workspaceId: "workspace-b", cwd: "C:/other" }],
  );
  await port.stop();
});

test("resuming a Session of another project moves the active workspace with it", async () => {
  const { port, state } = createHarness();
  await port.start(context); // fresh-1 in A
  await port.rebind?.(WORKSPACE_B); // fresh-2 in B
  state.adopted.length = 0;
  await port.switchSession?.({ kind: "resume", sessionId: "fresh-1" });
  assert.deepEqual(state.adopted, [WORKSPACE_A]);
  // A subsequent fresh Session must follow the adopted workspace, not B.
  await port.switchSession?.({ kind: "fresh" });
  assert.deepEqual(
    state.launchedIn.filter((entry) => entry.sessionId === "fresh-3"),
    [{ sessionId: "fresh-3", workspaceId: "workspace-a", cwd: "C:/workspace" }],
  );
  await port.stop();
});

test("relaunching a dead resident keeps it in its own workspace", async () => {
  const { port, state } = createHarness();
  await port.start(context); // fresh-1 in A
  await port.rebind?.(WORKSPACE_B); // fresh-2 in B, active workspace is B
  state.dead.add("fresh-1");
  await port.switchSession?.({ kind: "resume", sessionId: "fresh-1" });
  assert.deepEqual(state.stopped, ["fresh-1"]);
  assert.deepEqual(
    state.launchedIn.filter((entry) => entry.sessionId === "fresh-1"),
    [
      { sessionId: "fresh-1", workspaceId: "workspace-a", cwd: "C:/workspace" },
      { sessionId: "fresh-1", workspaceId: "workspace-a", cwd: "C:/workspace" },
    ],
  );
  await port.stop();
});

test("evacuating the active Session relaunches inside its own workspace", async () => {
  const { port, state } = createHarness();
  await port.start(context); // fresh-1 in A
  await port.rebind?.(WORKSPACE_B); // fresh-2 in B is active
  const result = await port.evacuateResident?.("fresh-2");
  assert.equal(result?.found, true);
  assert.equal(result?.active?.controller.publication()?.snapshot.sessionId, "fresh-3");
  assert.deepEqual(
    state.launchedIn.filter((entry) => entry.sessionId === "fresh-3"),
    [{ sessionId: "fresh-3", workspaceId: "workspace-b", cwd: "C:/other" }],
  );
  assert.equal(port.isResident?.("fresh-1"), true);
  await port.stop();
});

test("force ensure relaunches the active Session in its own workspace", async () => {
  const { port, state } = createHarness();
  await port.start(context); // fresh-1 in A
  await port.rebind?.(WORKSPACE_B); // fresh-2 in B is active
  await port.ensure?.({ force: true });
  assert.deepEqual(state.stopped, ["fresh-2"]);
  assert.deepEqual(
    state.launchedIn.filter((entry) => entry.sessionId === "fresh-2"),
    [
      { sessionId: "fresh-2", workspaceId: "workspace-b", cwd: "C:/other" },
      { sessionId: "fresh-2", workspaceId: "workspace-b", cwd: "C:/other" },
    ],
  );
  assert.equal(port.isResident?.("fresh-1"), true);
  await port.stop();
});

test("capacity hibernates a background project before an idle sibling of the active one", async () => {
  const { port, state } = createHarness(3);
  await port.start(context); // fresh-1 in A
  await port.switchSession?.({ kind: "fresh" }); // fresh-2 in A
  await port.rebind?.(WORKSPACE_B); // fresh-3 in B, B is active
  // Capacity is full. fresh-1 is the least-recently-selected overall, and it
  // belongs to the now-background project A, so it hibernates first.
  await port.switchSession?.({ kind: "fresh" }); // fresh-4 in B
  assert.deepEqual(state.stopped, ["fresh-1"]);
  await port.stop();
});

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

test("applyApprovalMode reports partial when a sibling fails and stops that Worker", async () => {
  const { port, state } = createHarness();
  await port.start(context); // fresh-1 active
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" }); // session-b active
  state.failInvoke.add("fresh-1");
  const result = await port.applyApprovalMode?.("always-ask");
  assert.deepEqual(result, { mode: "always-ask", syncStatus: "partial", appliedSessions: 1, failedSessions: 1 });
  assert.deepEqual(state.stopped, ["fresh-1"]);
  assert.equal(port.isResident?.("fresh-1"), false);
  // Resume relaunches the stopped sibling; the durable persist already landed
  // on the active Worker, so the new Worker reads that mode from disk.
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
  await port.stop();
});

test("applyApprovalMode stops failed background residents so they cannot stay on a stale mode", async () => {
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
  assert.equal(state.stopped.includes("fresh-1"), true);
  assert.equal(state.stopped.includes("session-b"), true);
  assert.equal(port.isResident?.("fresh-1"), false);
  assert.equal(port.isResident?.("session-b"), false);

  state.failInvoke.delete("session-b");
  state.failInvoke.delete("fresh-1");
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  assert.equal(
    state.created.some((entry) => entry.sessionId === "session-b" && entry.epoch > 2),
    true,
  );
  assert.equal(
    state.invokes.some(
      (entry) =>
        entry.sessionId === "session-b" &&
        entry.operation.kind === "permissions.mode.set" &&
        entry.operation.persist === true,
    ),
    true,
  );
  await port.stop();
});

test("evacuateResident stops a background Worker without switching the active session", async () => {
  const { port, state } = createHarness();
  await port.start(context);
  await port.switchSession?.({ kind: "resume", sessionId: "session-b" });
  assert.equal(port.isResident?.("fresh-1"), true);
  const result = await port.evacuateResident?.("fresh-1");
  assert.deepEqual(result, { found: true });
  assert.equal(port.isResident?.("fresh-1"), false);
  assert.equal(port.isResident?.("session-b"), true);
  assert.deepEqual(state.stopped, ["fresh-1"]);
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

test("ensure force relaunches even when hello is still live", async () => {
  const { port, state } = createHarness();
  const first = await port.start(context);
  const next = await port.ensure!({ force: true });
  assert.notEqual(next, first);
  assert.equal(next?.controller.publication()?.snapshot.sessionId, "fresh-1");
  assert.deepEqual(state.stopped, ["fresh-1"]);
  assert.deepEqual(state.created, [
    { sessionId: "fresh-1", epoch: 1 },
    { sessionId: "fresh-1", epoch: 2 },
  ]);
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
