import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ClientEvent,
  CommandRequestId,
  IdempotencyKey,
  PublicAuthorityIdentity,
  RuntimeInstallState,
  StudioRuntimeSettingsGetResult,
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

function makeFacade(invocations: StudioOperation[]): StudioHostClientFacade {
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
    install: async (): Promise<RuntimeInstallState> => ({ status: "installed", signature: "unknown" }),
    commands: {
      resume: () => snapshot,
      drop: () => snapshot,
      respond: () => snapshot,
      invoke: (operation): HostInvokeOutcome => {
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
