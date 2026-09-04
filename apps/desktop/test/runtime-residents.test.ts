import assert from "node:assert/strict";
import { test } from "node:test";

import type { HostRuntimeHelloView } from "@omp-studio/host-client-api";
import { InMemorySessionLeaseStore } from "@omp-studio/studio-host";
import type {
  CommandLedgerEntry,
  OperatorStateSnapshot,
  RuntimeEpoch,
  SessionId,
  StateVersion,
  StudioOperation,
  StudioReceipt,
} from "@omp-studio/studio-protocol";

import type {
  DesktopResidentsChange,
  DesktopRuntimeSession,
  DesktopRuntimeSessionPort,
} from "../src/host-composition.js";
import { createDesktopRuntimeSessionPort, type DesktopRuntimeSessionPortOptions } from "../src/runtime-session.js";

const WORKSPACE_A = { workspaceId: "workspace-a", cwd: "C:/workspace" };
const WORKSPACE_B = { workspaceId: "workspace-b", cwd: "C:/other" };

function baseSnapshot(sessionId: string, epoch: number): OperatorStateSnapshot {
  return {
    runtimeId: `runtime-${sessionId}` as never,
    runtimeEpoch: epoch as RuntimeEpoch,
    stateVersion: 1 as StateVersion,
    sessionId: sessionId as SessionId,
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal",
    approvalMode: "yolo",
    plan: { status: "off" },
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

type FakePublication = {
  commitSeq: number;
  publishedAt: string;
  snapshot: OperatorStateSnapshot;
  terminalOutcomes: readonly CommandLedgerEntry[];
};

function createHarness(options: {
  maxResidentSessions?: number;
  idleWorkerTtlMs?: number;
} = {}) {
  let nextFresh = 0;
  let commitSeq = 0;
  const stopped: string[] = [];
  const snapshots = new Map<string, OperatorStateSnapshot>();
  const listeners = new Map<string, Set<(publication: FakePublication) => void>>();
  const makePublication = (sessionId: string, terminalOutcomes: readonly CommandLedgerEntry[] = []) => ({
    commitSeq: ++commitSeq,
    publishedAt: new Date().toISOString(),
    snapshot: snapshots.get(sessionId)!,
    terminalOutcomes,
  });
  const workerPortFactory = ({ resumeSessionId, nextRuntimeEpoch }: Parameters<NonNullable<DesktopRuntimeSessionPortOptions["workerPortFactory"]>>[0]): DesktopRuntimeSessionPort => {
    const sessionId = resumeSessionId ?? `fresh-${++nextFresh}`;
    const epoch = nextRuntimeEpoch();
    snapshots.set(sessionId, baseSnapshot(sessionId, epoch));
    const sessionListeners = new Set<(value: FakePublication) => void>();
    listeners.set(sessionId, sessionListeners);
    let alive = true;
    const currentPublication = () => ({
      commitSeq,
      publishedAt: "2026-08-23T00:00:00.000Z",
      snapshot: snapshots.get(sessionId)!,
      terminalOutcomes: [],
    });
    const session = {
      controller: {
        publication: currentPublication,
        invoke: async (request: { requestId: string; operation: StudioOperation }): Promise<StudioReceipt> => ({
          type: "studio.receipt",
          requestId: request.requestId,
          runtimeEpoch: epoch,
          stateVersion: 1,
          status: "completed",
          result: {},
        } as StudioReceipt),
      },
      hello: () => alive ? ({ runtimeId: `runtime-${sessionId}`, runtimeEpoch: epoch, classification: "managed" } satisfies HostRuntimeHelloView) : undefined,
      capabilityManifest: () => undefined,
      commandManifest: () => undefined,
      onPublication: (listener: (value: FakePublication) => void) => {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
    } as unknown as DesktopRuntimeSession;
    return {
      start: async () => session,
      stop: async () => {
        if (!alive) return;
        alive = false;
        stopped.push(sessionId);
        listeners.delete(sessionId);
      },
    } satisfies DesktopRuntimeSessionPort;
  };
  const port = createDesktopRuntimeSessionPort({
    ownerId: "resident-test",
    sessionLeaseStore: new InMemorySessionLeaseStore(),
    ...(options.maxResidentSessions === undefined ? {} : { maxResidentSessions: options.maxResidentSessions }),
    ...(options.idleWorkerTtlMs === undefined ? {} : { idleWorkerTtlMs: options.idleWorkerTtlMs }),
    workerPortFactory,
  });
  const publish = (
    sessionId: string,
    next: Partial<OperatorStateSnapshot>,
    terminalOutcomes: readonly CommandLedgerEntry[] = [],
  ) => {
    snapshots.set(sessionId, { ...snapshots.get(sessionId)!, ...next });
    const current = makePublication(sessionId, terminalOutcomes);
    for (const listener of listeners.get(sessionId) ?? []) listener(current);
  };
  return { port, snapshots, publish, stopped };
}

const context = {
  resolution: { classification: "managed" } as never,
  endpoint: { kind: "private", authority: "resident-test" } as never,
  profileDirectory: "C:/profile",
  runtimeInstallDirectory: "C:/runtime",
  workspace: WORKSPACE_A,
};

test("resident projection prioritizes GUI interaction and plan review as waiting", async () => {
  const harness = createHarness();
  const port = harness.port;
  await port.start(context);
  harness.publish("fresh-1", {
    pendingMessages: 3,
    plan: { status: "review" },
    pendingInteraction: { owner: "gui", request: { kind: "approval" } } as never,
  });
  let model = port.listResidents!();
  assert.equal(model.residents[0]?.phase, "waiting");
  assert.equal(model.residents[0]?.waitKind, "approval");
  assert.equal(model.residents[0]?.pendingMessages, 3);
  harness.publish("fresh-1", { pendingInteraction: undefined });
  model = port.listResidents!();
  assert.equal(model.residents[0]?.phase, "waiting");
  assert.equal(model.residents[0]?.waitKind, "plan");
  await port.stop();
});

test("resident changes expose terminal outcomes without copying background publications", async () => {
  const harness = createHarness();
  const port = harness.port;
  await port.start(context);
  const changes: DesktopResidentsChange[] = [];
  const detach = port.attachResidentsSink!((change) => changes.push(change));
  const outcome = {
    commandId: "command-background",
    requestId: "request-background",
    runtimeId: "runtime-fresh-1",
    runtimeEpoch: 1,
    operationKind: "core.prompt",
    status: "completed",
    terminalAt: "2026-08-23T00:00:00.000Z",
  } as CommandLedgerEntry;
  harness.publish("fresh-1", {}, [outcome]);
  assert.deepEqual(changes.at(-1)?.terminalOutcomes, [outcome]);
  assert.equal("publications" in (changes.at(-1) ?? {}), false);
  detach();
  await port.stop();
});

test("pending interaction resident is neither idle nor eligible for capacity/TTL eviction", async () => {
  const harness = createHarness({ maxResidentSessions: 2, idleWorkerTtlMs: 20 });
  const port = harness.port;
  await port.start(context);
  harness.publish("fresh-1", { pendingInteraction: { owner: "gui", request: { kind: "ask" } } as never });
  await port.rebind!(WORKSPACE_B);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(harness.stopped, []);
  await assert.rejects(() => port.switchSession!({ kind: "fresh" }), /capacity is exhausted/);
  await port.stop();
});
