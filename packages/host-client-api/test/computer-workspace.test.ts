import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientEvent, ClientError, CommandRequestId, IdempotencyKey, PublicAuthorityIdentity } from "@omp-studio/client-contract";
import { COMPUTER_WORKSPACE_KINDS, type ComputerWorkspaceQuery, type ComputerWorkspaceResultMap, type ComputerWorkspaceSnapshot, type OperatorStateSnapshot, type RuntimeEpoch, type SessionId, type StateVersion, type StudioOperation } from "@omp-studio/studio-protocol";
import type { HostBackend, StudioComputerForward } from "@omp-studio/studio-host";
import { StudioHostClientFacade, createDefaultHostDiagnosticsFactory, type HostRuntimeAccess } from "../src/index.js";

const AT = "2026-11-05T00:00:00.000Z";
const workspace: ComputerWorkspaceSnapshot = {
  version: 1, sessionId: "session-1", revision: 1, updatedAt: 1, enabled: true,
  preludeAvailable: true, backend: "native", capabilities: { capture: true, input: true, accessibility: false, globalEscape: true, observationOnly: true },
  permissions: { capture: "granted", input: "granted", accessibility: "unavailable" },
  screen: { locked: false, asleep: false }, control: { status: "allowed", revision: 1, updatedAt: 1, foreground: "none" },
  targets: [], active: [], frames: [],
};
const results: Pick<ComputerWorkspaceResultMap, ComputerWorkspaceQuery["kind"]> = {
  "computer.workspace.get": workspace,
  "computer.activity.list": { items: [], frames: [], revision: 1 },
  "computer.frame.get": null,
  "computer.structure.get": { snapshotId: "structure-1", sessionId: "session-1", targetId: "display-1", capturedAt: 1, nodes: [], truncated: false, coordinateSpace: "unavailable", reason: "Accessibility not available" },
};

function harness(options: { supported?: boolean; channel?: boolean } = {}) {
  let snapshot: OperatorStateSnapshot = {
    runtimeId: "runtime-1" as OperatorStateSnapshot["runtimeId"], runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 1 as StateVersion, sessionId: "session-1" as SessionId, isStreaming: true, isCompacting: false,
    activeMode: "normal", approvalMode: "yolo", pendingMessages: 0, activeCommandIds: [], agentsRevision: 0, jobsRevision: 0, agents: [], jobs: [],
  };
  const reads: ComputerWorkspaceQuery[] = [];
  const writes: StudioOperation[] = [];
  let computerListener: ((event: StudioComputerForward) => void) | undefined;
  let connected = true;
  const runtime: HostRuntimeAccess = {
    hello: () => connected ? { runtimeId: String(snapshot.runtimeId), runtimeEpoch: Number(snapshot.runtimeEpoch), classification: "managed" } : undefined,
    snapshot: () => snapshot,
    onComputerEvent: listener => { computerListener = listener; return () => { computerListener = undefined; }; },
    ...(options.channel === false ? {} : {
      readComputer: async <K extends ComputerWorkspaceQuery["kind"]>(operation: Extract<ComputerWorkspaceQuery, { kind: K }>): Promise<ComputerWorkspaceResultMap[K]> => {
        reads.push(operation);
        return results[operation.kind] as ComputerWorkspaceResultMap[K];
      },
    }),
  };
  const facade = new StudioHostClientFacade({
    authority: { authorityId: "authority-1" as PublicAuthorityIdentity["authorityId"], authorityEpoch: 1 as PublicAuthorityIdentity["authorityEpoch"] },
    platform: "win32", arch: "x64", backend: {} as HostBackend, runtime,
    capabilityManifest: () => ({ profile: "limited", generatedAt: AT, hash: "computer-capabilities", capabilities: options.supported === false ? [] : COMPUTER_WORKSPACE_KINDS.map(id => ({ id, grade: "stable", version: 1, evidence: "fixture" })) }),
    commandManifest: () => undefined, catalog: { list: () => [] }, diagnostics: createDefaultHostDiagnosticsFactory(),
    install: async () => ({ status: "installed", signature: "unknown" }),
    commands: { resume: () => { throw new Error("not used"); }, drop: () => { throw new Error("not used"); }, respond: () => { throw new Error("not used"); }, invoke: async operation => { writes.push(operation); return { snapshot, result: operation.kind === "computer.control.stop" ? workspace.control : { stopped: true } }; } },
  });
  return {
    facade, reads, writes,
    forward: (event: StudioComputerForward) => computerListener?.(event),
    switchSession: () => { snapshot = { ...snapshot, sessionId: "session-2" as SessionId }; },
    disconnect: () => { connected = false; },
  };
}

test("Computer workspace queries return direct read models without command lifecycle events", async () => {
  const h = harness();
  const events: ClientEvent[] = [];
  h.facade.subscribe({ scope: "all" }, event => events.push(event));
  try {
    assert.deepEqual(await h.facade.query({ queryName: "computer.workspace.get", input: { sessionId: "session-1" } }), { ok: true, queryName: "computer.workspace.get", result: workspace });
    assert.deepEqual(await h.facade.query({ queryName: "computer.activity.list", input: { sessionId: "session-1", limit: 20 } }), { ok: true, queryName: "computer.activity.list", result: results["computer.activity.list"] });
    assert.deepEqual(await h.facade.query({ queryName: "computer.frame.get", input: { sessionId: "session-1", frameId: "missing" } }), { ok: true, queryName: "computer.frame.get", result: null });
    assert.deepEqual(await h.facade.query({ queryName: "computer.structure.get", input: { sessionId: "session-1", leaseId: "lease-1", targetId: "display-1" } }), { ok: true, queryName: "computer.structure.get", result: results["computer.structure.get"] });
    assert.equal(h.reads.length, 4);
    assert.equal(h.writes.length, 0);
    assert.equal(events.length, 0);
  } finally { await h.facade.close(); }
});

test("Computer metadata uses the runtime subscription and active session/epoch fence", async () => {
  const h = harness();
  const events: ClientEvent[] = [];
  h.facade.subscribe({ scope: "runtime" }, event => events.push(event));
  const envelope: StudioComputerForward["envelope"] = { type: "computer.event", runtimeEpoch: 1 as RuntimeEpoch, stateVersion: 1 as StateVersion, occurredAt: AT, event: { kind: "state", sessionId: "session-1", revision: 1, snapshot: workspace } };
  try {
    h.forward({ envelope });
    h.forward({ envelope: { ...envelope, runtimeEpoch: 0 as RuntimeEpoch } });
    h.forward({ envelope: { ...envelope, runtimeEpoch: 2 as RuntimeEpoch } });
    h.forward({ envelope: { ...envelope, event: { kind: "reset", sessionId: "other", revision: 2 } } });
    h.switchSession();
    h.forward({ envelope });
    h.disconnect();
    h.forward({ envelope: { ...envelope, event: { kind: "reset", sessionId: "session-2", revision: 3 } } });
    const changes = events.filter(event => event.kind === "computer.changed");
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.change, envelope.event);
    assert.equal(changes[0]?.runtimeEpoch, 1);
    assert.equal(changes[0]?.authorityEpoch, 1);
    assert.equal(changes[0]?.occurredAt, AT);
  } finally { await h.facade.close(); }
});

for (const options of [{ supported: false }, { channel: false }]) {
  test(`Unsupported Computer workspace fails honestly (${JSON.stringify(options)})`, async () => {
    const h = harness(options);
    const events: ClientEvent[] = [];
    h.facade.subscribe({ scope: "all" }, event => events.push(event));
    try {
      const result = await h.facade.query({ queryName: "computer.workspace.get", input: { sessionId: "session-1" } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "CAPABILITY_UNAVAILABLE");
      assert.deepEqual(h.reads, []);
      assert.equal(h.writes.length, 0);
      assert.equal(events.length, 0);
      if (options.supported === false) {
        await assert.rejects(() => h.facade.command({ commandName: "computer.control.stop", requestId: "unsupported" as CommandRequestId, idempotencyKey: "unsupported" as IdempotencyKey, input: { sessionId: "session-1" } }), error => (error as ClientError).code === "CAPABILITY_UNAVAILABLE");
      }
      // Existing runtimes retain the old ComputerObservation API.
      await h.facade.command({ commandName: "computer.stop", requestId: "legacy" as CommandRequestId, idempotencyKey: "legacy" as IdempotencyKey, input: { sessionId: "session-1" } });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.writes.at(-1)?.kind, "computer.stop");
      assert.ok(events.some(event => event.kind === "command.receipt" && event.receipt.status === "completed"));
    } finally { await h.facade.close(); }
  });
}

test("Computer workspace commands keep the normal accepted/receipt path", async () => {
  const h = harness();
  const events: ClientEvent[] = [];
  h.facade.subscribe({ scope: "runtime" }, event => events.push(event));
  try {
    await h.facade.command({ commandName: "computer.control.stop", requestId: "stop" as CommandRequestId, idempotencyKey: "stop" as IdempotencyKey, input: { sessionId: "session-1", reason: "handoff" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.writes, [{ kind: "computer.control.stop", sessionId: "session-1", reason: "handoff" }]);
    assert.deepEqual(events.map(event => event.kind), ["command.accepted", "command.receipt"]);
    const receipt = events.find(event => event.kind === "command.receipt")?.receipt;
    assert.equal(receipt?.status, "completed");
    if (receipt?.status === "completed") assert.deepEqual((receipt.result as { result: unknown }).result, workspace.control);
  } finally { await h.facade.close(); }
});
