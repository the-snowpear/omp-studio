import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublicAuthorityIdentity, RuntimeInstallState, SessionId } from "@omp-studio/client-contract";
import type { HostBackend, StudioRuntimeSessionController } from "@omp-studio/studio-host";
import type { ConversationOpenResult, RuntimeEpoch } from "@omp-studio/studio-protocol";

import { createDefaultHostDiagnosticsFactory, StudioHostClientFacade } from "../src/index.js";

test("facade exposes conversation.open as a typed query", async () => {
  const sessionId = "session-open" as SessionId;
  const result: ConversationOpenResult = {
    target: { kind: "session", sessionId, conversationSessionId: sessionId },
    page: {
      runtimeEpoch: 1 as RuntimeEpoch,
      sessionId,
      branchLeafId: null,
      items: [],
      headCursor: "head" as never,
      hasMoreBefore: false,
    },
    live: { status: "complete", watermark: 0, events: [] },
  };
  const runtimeSession = {
    openConversation: async () => result,
    onConversationEvent: () => () => undefined,
    onConversationResync: () => () => undefined,
  } as unknown as StudioRuntimeSessionController;
  const facade = new StudioHostClientFacade({
    authority: {
      authorityId: "authority-1" as PublicAuthorityIdentity["authorityId"],
      authorityEpoch: 1 as PublicAuthorityIdentity["authorityEpoch"],
    },
    platform: "win32",
    arch: "x64",
    backend: {} as HostBackend,
    capabilityManifest: () => undefined,
    commandManifest: () => undefined,
    runtime: {
      hello: () => ({ runtimeId: "runtime-1", runtimeEpoch: 1, classification: "managed" }),
      snapshot: () => ({ sessionId, runtimeEpoch: 1 }) as never,
      currentSession: () => runtimeSession,
    },
    catalog: { list: () => [] },
    diagnostics: createDefaultHostDiagnosticsFactory(),
    install: async (): Promise<RuntimeInstallState> => ({ status: "installed", signature: "unknown" }),
  });
  try {
    const response = await facade.query({
      queryName: "conversation.open",
      input: { target: { kind: "session", sessionId } },
    });
    assert.equal(response.ok, true);
    if (response.ok) assert.deepEqual(response.result, result);
  } finally {
    await facade.close();
  }
});
