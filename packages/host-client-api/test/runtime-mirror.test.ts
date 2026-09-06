import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ClientEvent,
  CommandRequestId,
  IdempotencyKey,
  PublicAuthorityIdentity,
  ResidentsReadModel,
  RuntimeInstallState,
  StudioRuntimeSettingsGetResult,
  WorkspaceId,
} from "@omp-studio/client-contract";
import type { OperatorStateSnapshot, StudioOperation, RuntimeEpoch, RuntimeId, SessionId, StateVersion } from "@omp-studio/studio-protocol";
import { StudioHostClientFacade, createDefaultHostDiagnosticsFactory } from "../src/index.js";
import type { HostInvokeOutcome } from "../src/services.js";
import type { HostBackend } from "@omp-studio/studio-host";

const snapshot: OperatorStateSnapshot = {
  runtimeId: "runtime-1" as RuntimeId,
  runtimeEpoch: 1 as RuntimeEpoch,
  stateVersion: 4 as StateVersion,
  sessionId: "session-1" as SessionId,
  isStreaming: false,
  isCompacting: false,
  activeMode: "plan",
  approvalMode: "always-ask",
  pendingMessages: 0,
  activeCommandIds: [],
  agentsRevision: 0,
  jobsRevision: 0,
  agents: [],
  jobs: [],
};

function makeFacade(invocations: StudioOperation[], install: () => Promise<RuntimeInstallState> = async () => ({ status: "installed", signature: "unknown" }),
  invokeOverride?: (operation: StudioOperation) => Promise<HostInvokeOutcome>): StudioHostClientFacade {
  return new StudioHostClientFacade({
    authority: { authorityId: "authority-1" as PublicAuthorityIdentity["authorityId"], authorityEpoch: 1 as PublicAuthorityIdentity["authorityEpoch"] },
    platform: "win32",
    arch: "x64",
    backend: {} as HostBackend,
    capabilityManifest: () => undefined,
    commandManifest: () => undefined,
    runtime: {
      hello: () => ({ runtimeId: "runtime-1", runtimeEpoch: 1, classification: "managed" }),
      snapshot: () => snapshot,
    },
    catalog: { list: () => [] },
    diagnostics: createDefaultHostDiagnosticsFactory(),
    install,
    commands: {
      resume: () => snapshot,
      drop: () => snapshot,
      respond: () => snapshot,
      invoke: (operation): HostInvokeOutcome | Promise<HostInvokeOutcome> => {
        if (invokeOverride !== undefined) return invokeOverride(operation);
        invocations.push(operation);
        switch (operation.kind) {
          case "runtime.settings.get":
            return {
              values: { extendedContext: true },
            } satisfies StudioRuntimeSettingsGetResult;
          case "runtime.settings.set":
            return { key: operation.key, value: operation.value, persisted: operation.persist };
          case "mode.plan.review.saveAndQuit":
            return {
              saved: true,
              path: operation.path,
              exitedPlan: true,
              newSession: "started",
              sessionId: "session-2" as SessionId,
            };
          default:
            return snapshot;
        }
      },
    },
  });
}

async function waitForReceipt(events: ClientEvent[], requestId: CommandRequestId): Promise<Extract<ClientEvent, { kind: "command.receipt" }>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const receipt = events.find(
      (event): event is Extract<ClientEvent, { kind: "command.receipt" }> =>
        event.kind === "command.receipt" && event.receipt.requestId === requestId,
    );
    if (receipt !== undefined) return receipt;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`receipt ${requestId} was not emitted`);
}

test("Runtime install business failure emits a failed terminal receipt", async () => {
  const facade = makeFacade([], async () => ({ status: "failed", signature: "verified", message: "Runtime did not start" }));
  const events: ClientEvent[] = [];
  facade.subscribe({ scope: "all" }, (event) => events.push(event));
  const requestId = "install-failed" as CommandRequestId;
  try {
    await facade.command({ commandName: "runtime.install", input: {}, requestId, idempotencyKey: "install-failed" as IdempotencyKey });
    const { receipt } = await waitForReceipt(events, requestId);
    assert.equal(receipt.status, "failed");
    if (receipt.status === "failed") assert.match(receipt.error.message, /did not start/);
  } finally { await facade.close(); }
});

test("Runtime install fences concurrent installs and commands until the terminal receipt", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let installs = 0;
  const invokes: StudioOperation[] = [];
  const facade = makeFacade(invokes, async () => { installs += 1; await gate; return { status: "installed", signature: "verified" }; });
  const events: ClientEvent[] = [];
  facade.subscribe({ scope: "all" }, (event) => events.push(event));
  const request = { commandName: "runtime.install" as const, input: {}, requestId: "install-one" as CommandRequestId, idempotencyKey: "install-one" as IdempotencyKey };
  try {
    await facade.command(request);
    await facade.command(request);
    await assert.rejects(facade.command({ ...request, requestId: "install-two" as CommandRequestId, idempotencyKey: "install-two" as IdempotencyKey }), { code: "UNAVAILABLE" });
    await assert.rejects(facade.command({ commandName: "runtime.settings.set", input: { key: "extendedContext", value: false, persist: true }, requestId: "settings-during-update" as CommandRequestId, idempotencyKey: "settings-during-update" as IdempotencyKey }), { code: "UNAVAILABLE" });
    assert.equal(installs, 1);
    assert.deepEqual(invokes, []);
    finish();
    assert.equal((await waitForReceipt(events, request.requestId)).receipt.status, "completed");
    await facade.command({ commandName: "runtime.settings.set", input: { key: "extendedContext", value: false, persist: true }, requestId: "settings-after-update" as CommandRequestId, idempotencyKey: "settings-after-update" as IdempotencyKey });
    assert.equal(invokes.length, 1);
  } finally { finish(); await facade.close(); }
});

test("Runtime install refuses an earlier command whose result has not reached the snapshot", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const facade = makeFacade([], undefined, async () => { await gate; return snapshot; });
  const events: ClientEvent[] = [];
  facade.subscribe({ scope: "all" }, (event) => events.push(event));
  try {
    await facade.command({ commandName: "runtime.settings.get", input: {}, requestId: "pending" as CommandRequestId, idempotencyKey: "pending" as IdempotencyKey });
    const install = { commandName: "runtime.install" as const, input: {}, requestId: "install-after-pending" as CommandRequestId, idempotencyKey: "install-after-pending" as IdempotencyKey };
    await assert.rejects(facade.command(install), { code: "UNAVAILABLE" });
    finish();
    await waitForReceipt(events, "pending" as CommandRequestId);
    await facade.command(install);
    assert.equal((await waitForReceipt(events, install.requestId)).receipt.status, "completed");
  } finally { finish(); await facade.close(); }
});

test("Host maps Runtime mirror commands to StudioOperation and forwards typed receipts", async () => {
  const invocations: StudioOperation[] = [];
  const facade = makeFacade(invocations);
  const events: ClientEvent[] = [];
  const unsubscribe = facade.subscribe({ scope: "all" }, (event) => events.push(event));
  try {
    const requests = [
      {
        commandName: "runtime.settings.get" as const,
        input: { keys: ["extendedContext"] as const },
        requestId: "request-settings-get" as CommandRequestId,
        idempotencyKey: "idem-settings-get" as IdempotencyKey,
      },
      {
        commandName: "runtime.settings.set" as const,
        input: { key: "extendedContext" as const, value: false, persist: true },
        requestId: "request-settings-set" as CommandRequestId,
        idempotencyKey: "idem-settings-set" as IdempotencyKey,
      },
      {
        commandName: "mode.plan.review.saveAndQuit" as const,
        input: { path: "plans/plan.md" },
        requestId: "request-plan-save" as CommandRequestId,
        idempotencyKey: "idem-plan-save" as IdempotencyKey,
      },
    ];
    for (const request of requests) {
      const accepted = await facade.command(request);
      assert.equal(accepted.status, "accepted");
      const receipt = await waitForReceipt(events, request.requestId);
      assert.equal(receipt.receipt.status, "completed");
    }
    assert.deepEqual(invocations, [
      { kind: "runtime.settings.get", keys: ["extendedContext"] },
      { kind: "runtime.settings.set", key: "extendedContext", value: false, persist: true },
      { kind: "mode.plan.review.saveAndQuit", path: "plans/plan.md" },
    ]);
  } finally {
    unsubscribe();
    await facade.close();
  }
});

test("Host rejects Runtime mirror extra fields and unsafe Plan paths before invoke", async () => {
  const invocations: StudioOperation[] = [];
  const facade = makeFacade(invocations);
  try {
    await assert.rejects(
      facade.command({
        commandName: "runtime.settings.set",
        input: { key: "extendedContext", value: "yes", persist: true } as never,
        requestId: "request-invalid-setting" as CommandRequestId,
        idempotencyKey: "idem-invalid-setting" as IdempotencyKey,
      }),
    );
    await assert.rejects(
      facade.command({
        commandName: "mode.plan.review.saveAndQuit",
        input: { path: "../plan.md" },
        requestId: "request-invalid-path" as CommandRequestId,
        idempotencyKey: "idem-invalid-path" as IdempotencyKey,
      }),
    );
    assert.deepEqual(invocations, []);
  } finally {
    await facade.close();
  }
});

test("resident lifecycle loss publishes runtime.changed before the broker summary", async () => {
  let live = true;
  let publishResidents: ((residents: ResidentsReadModel) => void) | undefined;
  const facade = new StudioHostClientFacade({
    authority: { authorityId: "authority-1" as PublicAuthorityIdentity["authorityId"], authorityEpoch: 1 as PublicAuthorityIdentity["authorityEpoch"] },
    platform: "win32",
    arch: "x64",
    backend: {} as HostBackend,
    capabilityManifest: () => undefined,
    commandManifest: () => undefined,
    runtime: {
      hello: () => live ? ({ runtimeId: "runtime-1", runtimeEpoch: 1, classification: "managed" }) : undefined,
      // Preserve the stale controller publication to match the lease-loss
      // incident: hello is gone before the old snapshot holder is replaced.
      snapshot: () => snapshot,
      disconnect: () => live ? undefined : ({ code: "pipe-closed", reason: "Bridge pipe closed" }),
    },
    residents: {
      list: () => ({ residents: [], generatedAt: "2026-08-30T12:00:00.000Z" }),
      onChanged(listener) {
        publishResidents = listener;
        return () => { publishResidents = undefined; };
      },
    },
    catalog: { list: () => [] },
    diagnostics: createDefaultHostDiagnosticsFactory(),
    install: async (): Promise<RuntimeInstallState> => ({ status: "installed", signature: "unknown" }),
  });
  const events: ClientEvent[] = [];
  const unsubscribe = facade.subscribe({ scope: "all" }, (event) => events.push(event));
  try {
    live = false;
    publishResidents?.({ residents: [], generatedAt: "2026-08-30T12:00:01.000Z" });

    const runtimeChangedIndex = events.findIndex((event) => event.kind === "runtime.changed");
    const residentsChangedIndex = events.findIndex((event) => event.kind === "residents.changed");
    assert.equal(runtimeChangedIndex, 0);
    assert.ok(residentsChangedIndex > runtimeChangedIndex);
    const runtimeChanged = events[runtimeChangedIndex];
    if (runtimeChanged?.kind === "runtime.changed") {
      assert.equal(runtimeChanged.connection.status, "disconnected");
      assert.equal(runtimeChanged.connection.disconnectCode, "pipe-closed");
    }
  } finally {
    unsubscribe();
    await facade.close();
  }
});

test("dormant workspace unbinding keeps connected state without emitting false disconnect", async () => {
  let bound = true;
  let publishResidents: ((residents: ResidentsReadModel) => void) | undefined;
  const facade = new StudioHostClientFacade({
    authority: { authorityId: "authority-1" as PublicAuthorityIdentity["authorityId"], authorityEpoch: 1 as PublicAuthorityIdentity["authorityEpoch"] },
    platform: "win32",
    arch: "x64",
    backend: {} as HostBackend,
    capabilityManifest: () => undefined,
    commandManifest: () => undefined,
    runtime: {
      hello: () => bound ? ({ runtimeId: "runtime-1", runtimeEpoch: 1, classification: "managed" }) : undefined,
      snapshot: () => bound ? snapshot : undefined,
      disconnect: () => undefined,
      unavailable: () => undefined,
    },
    residents: {
      list: () => ({
        residents: [{
          sessionId: "session-1" as SessionId,
          workspaceId: "workspace-a" as WorkspaceId,
          phase: "running",
          pendingMessages: 0,
          lastActivityAt: "2026-08-30T12:00:00.000Z",
        }],
        generatedAt: "2026-08-30T12:00:00.000Z",
      }),
      onChanged(listener) {
        publishResidents = listener;
        return () => { publishResidents = undefined; };
      },
    },
    catalog: { list: () => [] },
    diagnostics: createDefaultHostDiagnosticsFactory(),
    install: async (): Promise<RuntimeInstallState> => ({ status: "installed", signature: "unknown" }),
  });
  const events: ClientEvent[] = [];
  const unsubscribe = facade.subscribe({ scope: "all" }, (event) => events.push(event));
  try {
    // Unbind the active session (e.g. workspace switch to a dormant project without resident).
    bound = false;
    publishResidents?.({
      residents: [{
        sessionId: "session-1" as SessionId,
        workspaceId: "workspace-a" as WorkspaceId,
        phase: "running",
        pendingMessages: 0,
        lastActivityAt: "2026-08-30T12:00:00.000Z",
      }],
      generatedAt: "2026-08-30T12:00:01.000Z",
    });

    const runtimeChangedEvents = events.filter((event) => event.kind === "runtime.changed");
    // No false disconnect event should be emitted.
    assert.deepEqual(runtimeChangedEvents, []);
    const bootstrap = await facade.bootstrap();
    assert.equal(bootstrap.runtime.status, "connected");
  } finally {
    unsubscribe();
    await facade.close();
  }
});
