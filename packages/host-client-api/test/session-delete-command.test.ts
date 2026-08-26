import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ClientEvent,
  CommandRequestId,
  IdempotencyKey,
  PublicAuthorityIdentity,
  RuntimeInstallState,
  ThreadId,
} from "@omp-studio/client-contract";
import type { OperatorStateSnapshot, RuntimeEpoch, RuntimeId, SessionId, StateVersion } from "@omp-studio/studio-protocol";
import { StudioHostClientFacade, createDefaultHostDiagnosticsFactory } from "../src/index.js";
import type { HostSemanticCommandService } from "../src/services.js";
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

/** Full HostSemanticCommandService with a customizable `delete`. */
function service(overrides?: Pick<HostSemanticCommandService, "delete">): HostSemanticCommandService {
  return {
    resume: async () => snapshot,
    drop: async () => snapshot,
    respond: async () => snapshot,
    ...overrides,
  };
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

function makeFacade(commands: HostSemanticCommandService): StudioHostClientFacade {
  return new StudioHostClientFacade({
    authority: {
      authorityId: "authority-1" as PublicAuthorityIdentity["authorityId"],
      authorityEpoch: 1 as PublicAuthorityIdentity["authorityEpoch"],
    },
    platform: "win32",
    arch: "x64",
    backend: {} as HostBackend,
    capabilityManifest: () => undefined,
    commandManifest: () => undefined,
    catalog: { list: () => [] },
    diagnostics: createDefaultHostDiagnosticsFactory(),
    install: async (): Promise<RuntimeInstallState> => ({ status: "installed", signature: "unknown" }),
    commands,
  });
}

test("session.delete is accepted and completes with the ConfigWriteResult", async () => {
  const deletedThreads: ThreadId[] = [];
  const facade = makeFacade(service({
    delete: async ({ threadId }) => {
      deletedThreads.push(threadId);
      return { applied: true, runtimeEffect: "immediate", message: "Session deleted" };
    },
  }));
  const events: ClientEvent[] = [];
  const unsubscribe = facade.subscribe({ scope: "all" }, (event) => events.push(event));
  try {
    const accepted = await facade.command({
      commandName: "session.delete",
      input: { threadId: "thread-a" as ThreadId },
      requestId: "req-delete" as CommandRequestId,
      idempotencyKey: "idem-delete" as IdempotencyKey,
    });
    assert.equal(accepted.status, "accepted");
    const receipt = await waitForReceipt(events, "req-delete" as CommandRequestId);
    assert.equal(receipt.receipt.status, "completed");
    assert.deepEqual(receipt.receipt.result, { applied: true, runtimeEffect: "immediate", message: "Session deleted" });
    assert.deepEqual(deletedThreads, ["thread-a"]);
  } finally {
    unsubscribe();
    await facade.close();
  }
});

test("session.delete without a delete capability fails closed", async () => {
  const facade = makeFacade(service());
  try {
    await assert.rejects(
      facade.command({
        commandName: "session.delete",
        input: { threadId: "thread-a" as ThreadId },
        requestId: "req-delete-2" as CommandRequestId,
        idempotencyKey: "idem-delete-2" as IdempotencyKey,
      }),
      (error: unknown) =>
        typeof error === "object" && error !== null && (error as { code?: string }).code === "CAPABILITY_UNAVAILABLE",
    );
  } finally {
    await facade.close();
  }
});

test("session.delete rejects an empty threadId", async () => {
  const facade = makeFacade(service({
    delete: async () => ({ applied: true, runtimeEffect: "immediate" as const }),
  }));
  try {
    await assert.rejects(
      facade.command({
        commandName: "session.delete",
        input: { threadId: "" as ThreadId },
        requestId: "req-delete-3" as CommandRequestId,
        idempotencyKey: "idem-delete-3" as IdempotencyKey,
      }),
      (error: unknown) =>
        typeof error === "object" && error !== null && (error as { code?: string }).code === "INVALID_ARGUMENT",
    );
  } finally {
    await facade.close();
  }
});
