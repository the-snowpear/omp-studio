import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublicAuthorityIdentity } from "@omp-studio/client-contract";
import type { HostBackend, StudioRuntimeSessionController } from "@omp-studio/studio-host";

import { createDefaultHostDiagnosticsFactory, StudioHostClientFacade } from "../src/index.js";

/**
 * The composer's picker reads `models.get`. A Runtime that can list its own
 * models must win over the Host's config-file view, and a Runtime that cannot
 * must leave that view exactly as it was.
 */
function makeFacade(runtimeSession: StudioRuntimeSessionController | undefined) {
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
    runtime: {
      hello: () => ({ runtimeId: "runtime-1", runtimeEpoch: 1, classification: "managed" }),
      snapshot: () => ({ sessionId: "session-1", runtimeEpoch: 1 }) as never,
      currentSession: () => runtimeSession,
    },
    catalog: { list: () => [] },
    diagnostics: createDefaultHostDiagnosticsFactory(),
    install: async () => ({ status: "installed", signature: "unknown" }),
  } as never);
}

const RUNTIME_MODELS = [
  // The id carries its own slash; the selector must still read provider/id.
  { provider: "local-gateway", id: "zed/claude-haiku-5-5", selector: "local-gateway/zed/claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: false },
];

test("models.get uses the Runtime's catalog when the Runtime answers", async () => {
  const session = {
    readModels: async () => ({ models: RUNTIME_MODELS }),
    onConversationEvent: () => () => undefined,
    onConversationResync: () => () => undefined,
  } as unknown as StudioRuntimeSessionController;
  const response = await makeFacade(session).query({ queryName: "models.get", input: {} });
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(
    response.result.availableModels.map(model => model.selector),
    ["local-gateway/zed/claude-haiku-5-5"],
  );
  // A live catalog is not a failure to read the config file.
  assert.equal(response.result.unavailableReason, undefined);
});

test("models.get keeps the config view when the Runtime cannot list models", async () => {
  const session = {
    // A Runtime that does not implement the operation rejects; the Host must
    // fall back rather than surface an empty catalog as an error.
    readModels: async () => {
      throw new Error("COMMAND_UNKNOWN: Operation is not implemented by this Runtime");
    },
    onConversationEvent: () => () => undefined,
    onConversationResync: () => () => undefined,
  } as unknown as StudioRuntimeSessionController;
  const response = await makeFacade(session).query({ queryName: "models.get", input: {} });
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(response.result.availableModels, []);
  assert.match(response.result.unavailableReason ?? "", /模型配置适配器/u);
});

test("models.get keeps the config view when no Runtime session exists", async () => {
  const response = await makeFacade(undefined).query({ queryName: "models.get", input: {} });
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(response.result.availableModels, []);
});
