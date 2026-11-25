import assert from "node:assert/strict";
import test from "node:test";
import type { ClientCommandRequest, CommandReceipt, CommandRequestId, IdempotencyKey, ModelConfigReadModel, PublicAuthorityIdentity } from "@omp-studio/client-contract";
import type { ModelAvailableOperation, ModelAvailablePage, RuntimeAvailableModel, OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import type { HostBackend, StudioRuntimeSessionController } from "@omp-studio/studio-host";
import { StudioHostClientFacade, createDefaultHostDiagnosticsFactory } from "../src/index.js";
import type { HostModelsService, HostSemanticCommandService } from "../src/services.js";
import { RuntimeModelSnapshotReads, type RuntimeModelReadTarget } from "../src/runtime-model-snapshot.js";
import { SharedProjectReads } from "../src/shared-reads.js";

const row = (id: string, price = 1): RuntimeAvailableModel & { kind: "judge" } => ({
  id, selector: `gateway/${id}`, name: id, provider: "gateway", api: "google-decisions", kind: "judge", source: "registry",
  reasoning: false, image: true, tools: false, contextWindow: 32000,
  cost: { input: price, output: 0, cacheRead: 0, cacheWrite: 0 },
  pricingStatus: "fixed", discovery: { source: "provider", status: "ok", optional: false, stale: false },
});
const config = (label = "configuration"): ModelConfigReadModel => ({
  providers: [], presets: [], roles: [{ id: "default", alias: "@default", name: "Default", desc: "", builtin: true, primary: "gateway/deleted", scope: "global", thinking: "high" }],
  cycleOrder: [], availableModels: [], loginProviders: [], generatedModelsYml: "providers: {}\n", generatedConfigYml: label,
  runtimeEffectHint: "", loginAvailable: false, ompAvailable: true, modelRoleStorage: "global", projectScopeAvailable: false,
  modelProviderOrder: [], fallbackChains: {}, subagentFallbackChains: [], fallbackRevertPolicy: "cooldown-expiry",
  webSearch: { enabled: true, order: [], exclude: [], timeoutSeconds: 60, geminiModel: "", providers: [], advanced: { searxng: { endpoint: "", tokenSet: false, basicUsername: "", passwordSet: false }, exa: { enabled: true, searchDelayMs: 1000 } } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Fake private Runtime channel: immutable native generations, no second Host authorization policy. */
class ModelRuntime {
  version = "generation-a";
  rows = [row("a"), row("b")];
  opened = 0;
  leases = new Map<string, { version: string; rows: RuntimeAvailableModel[] }>();
  beforeRead?: (operation: ModelAvailableOperation) => void;
  read = async (operation: ModelAvailableOperation): Promise<ModelAvailablePage | { released: boolean }> => {
    this.beforeRead?.(operation);
    if (operation.kind === "models.available.release") return { released: this.leases.delete(operation.snapshotId) };
    let id: string, offset: number;
    if (operation.cursor) {
      const split = operation.cursor.lastIndexOf(":");
      id = operation.cursor.slice(0, split); offset = Number(operation.cursor.slice(split + 1));
    } else {
      id = `lease-${++this.opened}`; offset = 0;
      this.leases.set(id, { version: this.version, rows: structuredClone(this.rows) });
    }
    const lease = this.leases.get(id);
    if (!lease || lease.version !== this.version) throw Object.assign(new Error("Model snapshot expired"), { code: "COMMAND_BLOCKED", retryable: true });
    return {
      sessionId: operation.sessionId, snapshotId: id, version: lease.version, expiresAt: Date.now() + 60_000,
      cursor: `${id}:${offset}`, ...(offset + 1 < lease.rows.length ? { nextCursor: `${id}:${offset + 1}` } : {}),
      total: lease.rows.length, truncated: false, models: lease.rows.slice(offset, offset + 1),
    };
  };
  target(key = "runtime/session/workspace"): RuntimeModelReadTarget {
    return { owner: this, key, sessionId: "session", isCurrent: () => true, read: this.read };
  }
}

test("auth changes during pagination restart the complete snapshot without preserving old ids or prices", async () => {
  const runtime = new ModelRuntime(), reads = new RuntimeModelSnapshotReads();
  let changed = false;
  runtime.beforeRead = operation => {
    if (!changed && operation.kind === "models.available.read" && operation.cursor?.endsWith(":1")) {
      changed = true; runtime.version = "generation-b"; runtime.rows = [row("new-a", 7), row("new-b", 9)];
    }
  };
  const result = await reads.read(runtime.target(), () => config(), new AbortController().signal);
  assert.equal(result.availability?.version, "generation-b");
  assert.deepEqual(result.availableModels.map(model => [model.id, model.cost?.input, model.kind]), [["new-a", 7, "judge"], ["new-b", 9, "judge"]]);
  assert.equal(result.roles[0]?.primary, "gateway/deleted");
  assert.equal(result.roles[0]?.thinking, "high");
  assert.equal(result.roles[0]?.issue?.kind, "model-missing");
  assert.equal(runtime.leases.size, 0);
});

test("only same-generation ongoing requests merge; external auth changes and sequential reads bypass them", async () => {
  const runtime = new ModelRuntime(), reads = new RuntimeModelSnapshotReads();
  const firstConfig = deferred<ModelConfigReadModel>(), nextConfig = deferred<ModelConfigReadModel>();
  let loads = 0;
  const load = () => ++loads === 1 ? firstConfig.promise : loads === 2 ? nextConfig.promise : config("fresh");
  const signal = new AbortController().signal;
  const a = reads.read(runtime.target(), load, signal), b = reads.read(runtime.target(), load, signal);
  await tick(); assert.equal(loads, 1);
  runtime.version = "generation-b"; runtime.rows = [row("new-account", 8)];
  const c = reads.read(runtime.target(), load, signal);
  await tick(); assert.equal(loads, 2);
  firstConfig.resolve(config("old"));
  await tick();
  nextConfig.resolve(config("new"));
  for (const result of await Promise.all([a, b, c])) {
    assert.equal(result.generatedConfigYml, "new");
    assert.equal(result.availability?.version, "generation-b");
    assert.equal(result.availableModels[0]?.id, "new-account");
  }
  assert.equal(runtime.leases.size, 0);
  const fresh = await reads.read(runtime.target(), load, signal);
  assert.equal(loads, 3); assert.equal(fresh.generatedConfigYml, "fresh");
});

test("identical ids and opaque versions from different Runtime owners never share a flight", async () => {
  const reads = new RuntimeModelSnapshotReads(), a = new ModelRuntime(), b = new ModelRuntime();
  b.rows = [row("other-profile", 99)];
  const gate = deferred<ModelConfigReadModel>();
  let loads = 0;
  const first = reads.read(a.target(), () => { loads++; return gate.promise; }, new AbortController().signal);
  const second = reads.read(b.target(), () => { loads++; return config("other-profile"); }, new AbortController().signal);
  const other = await second;
  assert.equal(loads, 2); assert.equal(other.availableModels[0]?.id, "other-profile");
  gate.resolve(config()); await first;
});

test("closing the consumer releases its lease even while the config read is still pending", async () => {
  const reads = new RuntimeModelSnapshotReads(), runtime = new ModelRuntime(), gate = deferred<ModelConfigReadModel>();
  const lifetime = new AbortController();
  const pending = reads.read(runtime.target(), () => gate.promise, lifetime.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await tick(); assert.equal(runtime.leases.size, 1);
  lifetime.abort(); await tick(); assert.equal(runtime.leases.size, 0);
  gate.resolve(config()); await rejected;
});

function facade(models: HostModelsService, runtime?: {
  hello: () => { runtimeId: string; runtimeEpoch: number; classification: "managed" } | undefined;
  snapshot: () => OperatorStateSnapshot | undefined;
  currentSession: () => StudioRuntimeSessionController | undefined;
  ensure?: () => Promise<void>;
}, invoke?: HostSemanticCommandService["invoke"]) {
  return new StudioHostClientFacade({
    authority: { authorityId: "authority" as PublicAuthorityIdentity["authorityId"], authorityEpoch: 1 as PublicAuthorityIdentity["authorityEpoch"] },
    platform: "win32", arch: "x64", backend: {} as HostBackend,
    capabilityManifest: () => undefined, commandManifest: () => undefined, catalog: { list: () => [] },
    diagnostics: createDefaultHostDiagnosticsFactory(), install: async () => ({ status: "installed", signature: "unknown" }),
    models, projectReads: new SharedProjectReads(), workspaceCwd: () => "workspace",
    ...(invoke ? { commands: { invoke } as HostSemanticCommandService } : {}),
    ...(runtime ? { runtime: { ...runtime, onConversationEvent: () => () => {}, onConversationResync: () => () => {}, onTelemetryEvent: () => () => {}, onBtwEvent: () => () => {}, onComputerEvent: () => () => {} } } : {}),
  });
}

function liveModels(runtime: ModelRuntime) {
  const controller = { readRuntimeView: runtime.read } as unknown as StudioRuntimeSessionController;
  const snapshot = { runtimeId: "runtime", runtimeEpoch: 1, sessionId: "session", stateVersion: 1, isStreaming: false, isCompacting: false, activeMode: "normal", approvalMode: "always-ask", pendingMessages: 0, activeCommandIds: [], agentsRevision: 0, jobsRevision: 0, agents: [], jobs: [] } as unknown as OperatorStateSnapshot;
  return {
    hello: () => ({ runtimeId: "runtime", runtimeEpoch: 1, classification: "managed" as const }),
    snapshot: (): OperatorStateSnapshot | undefined => snapshot,
    currentSession: () => controller,
  };
}
function discoveryRequest(id = "model-refresh"): ClientCommandRequest<"models.discovery.refresh"> {
  return { commandName: "models.discovery.refresh", input: {}, requestId: id as CommandRequestId, idempotencyKey: id as IdempotencyKey };
}
function submit(api: StudioHostClientFacade, request: ClientCommandRequest) {
  const terminal = deferred<CommandReceipt>();
  const unsubscribe = api.subscribe({ scope: "all" }, event => {
    if (event.kind === "command.receipt" && event.receipt.requestId === request.requestId) terminal.resolve(event.receipt);
  });
  return { accepted: api.command(request), receipt: terminal.promise.finally(unsubscribe) };
}

test("Host discovery refresh updates the connected Runtime once and reports immediate availability after completion", async () => {
  const runtime = new ModelRuntime(), finish = deferred<void>();
  const calls: Array<{ kind: string; sessionId: string | undefined; requestId: string | undefined }> = [];
  let cliRefreshes = 0;
  const api = facade({ get: () => config(), refreshDiscovery: async () => { cliRefreshes++; throw new Error("Detached CLI refresh is forbidden"); } } as unknown as HostModelsService,
    liveModels(runtime), async (operation, requestId) => {
      calls.push({ kind: operation.kind, sessionId: "sessionId" in operation ? operation.sessionId : undefined, requestId });
      await finish.promise;
      runtime.version = "refreshed-generation"; runtime.rows = [row("refreshed", 12)];
      return { sessionId: "session", refreshed: true };
    });
  const request = discoveryRequest();
  try {
    const before = await api.query({ queryName: "models.get", input: {} });
    assert.ok(before.ok); assert.equal(before.result.availableModels[0]?.id, "a");
    const pending = submit(api, request);
    await pending.accepted;
    await api.command(request);
    assert.deepEqual(calls, [{ kind: "models.available.refresh", sessionId: "session", requestId: request.requestId }]);
    finish.resolve();
    const receipt = await pending.receipt;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.commandName, "models.discovery.refresh");
    if (receipt.status === "completed") {
      const result = receipt.result as { applied: boolean; runtimeEffect: string };
      assert.equal(result.applied, true); assert.equal(result.runtimeEffect, "immediate");
    }
    const after = await api.query({ queryName: "models.get", input: {} });
    assert.ok(after.ok);
    assert.equal(after.result.availability?.version, "refreshed-generation");
    assert.deepEqual(after.result.availableModels.map(model => [model.id, model.cost?.input]), [["refreshed", 12]]);
    assert.equal(cliRefreshes, 0);
  } finally { finish.resolve(); await api.close(); }
});

test("the explicit native model refresh keeps its lightweight result on the normal Runtime command path", async () => {
  const runtime = new ModelRuntime();
  const api = facade({ get: () => config() } as unknown as HostModelsService, liveModels(runtime), operation => {
    assert.deepEqual(operation, { kind: "models.available.refresh", sessionId: "session" });
    return { sessionId: "session", refreshed: true };
  });
  try {
    const pending = submit(api, { commandName: "models.available.refresh", input: { sessionId: "session" }, requestId: "native-refresh" as CommandRequestId, idempotencyKey: "native-refresh" as IdempotencyKey });
    await pending.accepted;
    const receipt = await pending.receipt;
    assert.equal(receipt.status, "completed");
    if (receipt.status === "completed") assert.deepEqual(receipt.result, { sessionId: "session", refreshed: true });
  } finally { await api.close(); }
});

for (const state of ["unsupported", "missing-command-channel", "missing-snapshot"] as const) {
  test(`connected Runtime model refresh failure (${state}) never falls back to a detached CLI`, async () => {
    let cliRefreshes = 0;
    const live = liveModels(new ModelRuntime());
    if (state === "missing-snapshot") live.snapshot = () => undefined;
    const api = facade({ get: () => config(), refreshDiscovery: async () => { cliRefreshes++; return { applied: true, runtimeEffect: "new-session" }; } } as unknown as HostModelsService,
      live, state === "missing-command-channel" ? undefined : async () => { throw { code: "CAPABILITY_UNAVAILABLE", message: "Native refresh is unavailable" }; });
    try {
      const pending = submit(api, discoveryRequest(state));
      await pending.accepted;
      const receipt = await pending.receipt;
      assert.equal(receipt.status, "failed");
      if (receipt.status === "failed") assert.equal(receipt.error.code, "CAPABILITY_UNAVAILABLE");
      assert.equal(cliRefreshes, 0);
    } finally { await api.close(); }
  });
}

test("without a Runtime discovery refresh preserves the explicit CLI fallback and does not verify availability", async () => {
  let cliRefreshes = 0;
  const api = facade({ get: () => config(), refreshDiscovery: async () => { cliRefreshes++; return { applied: true, runtimeEffect: "new-session" }; } } as unknown as HostModelsService);
  try {
    const pending = submit(api, discoveryRequest());
    await pending.accepted;
    const receipt = await pending.receipt;
    assert.equal(receipt.status, "completed");
    if (receipt.status === "completed") assert.deepEqual(receipt.result, { applied: true, runtimeEffect: "new-session" });
    assert.equal(cliRefreshes, 1);
    const result = await api.query({ queryName: "models.get", input: {} });
    assert.ok(result.ok); assert.equal(result.result.availability?.status, "unverified");
  } finally { await api.close(); }
});

test("models.get without Runtime rereads configuration instead of serving the 30-second project cache", async () => {
  let count = 0;
  const api = facade({ get: () => ({ ...config(String(++count)), availableModels: [row("stale-cache")] }) } as unknown as HostModelsService);
  try {
    const first = await api.query({ queryName: "models.get", input: {} });
    const second = await api.query({ queryName: "models.get", input: {} });
    assert.ok(first.ok && second.ok);
    assert.equal(first.result.generatedConfigYml, "1"); assert.equal(second.result.generatedConfigYml, "2");
    assert.deepEqual(second.result.availableModels, []);
    assert.equal(second.result.availability?.status, "unverified");
    assert.equal(second.result.roles[0]?.primary, "gateway/deleted");
    assert.equal(second.result.roles[0]?.issue, undefined);
  } finally { await api.close(); }
});

test("a Runtime restart during models.get retries on the new owner and releases the old snapshot", async () => {
  const old = new ModelRuntime(), next = new ModelRuntime();
  next.rows = [row("new-runtime", 42)];
  const controller = (runtime: ModelRuntime) => ({ readRuntimeView: runtime.read }) as unknown as StudioRuntimeSessionController;
  let current = controller(old), epoch = 1;
  const snapshot = () => ({ runtimeId: `runtime-${epoch}`, runtimeEpoch: epoch, sessionId: "session", stateVersion: 1, isStreaming: false, isCompacting: false, activeMode: "normal", approvalMode: "always-ask", pendingMessages: 0, activeCommandIds: [], agentsRevision: 0, jobsRevision: 0, agents: [], jobs: [] }) as unknown as OperatorStateSnapshot;
  const gate = deferred<ModelConfigReadModel>();
  let count = 0;
  const api = facade({ get: () => ++count === 1 ? gate.promise : config("new-runtime") } as unknown as HostModelsService, {
    hello: () => ({ runtimeId: `runtime-${epoch}`, runtimeEpoch: epoch, classification: "managed" }),
    snapshot, currentSession: () => current,
  });
  try {
    const pending = api.query({ queryName: "models.get", input: {} });
    await tick(); epoch = 2; current = controller(next); gate.resolve(config("old-runtime"));
    const response = await pending;
    assert.ok(response.ok);
    assert.equal(response.result.generatedConfigYml, "new-runtime");
    assert.deepEqual(response.result.availableModels.map(model => model.id), ["new-runtime"]);
    assert.equal(response.result.availability?.status, "verified");
    assert.equal(old.leases.size, 0); assert.equal(next.leases.size, 0);
  } finally { await api.close(); }
});

function detachedModels() {
  const live = liveModels(new ModelRuntime());
  let connected = false, ensures = 0;
  return {
    hello: () => connected ? live.hello() : undefined,
    snapshot: () => connected ? live.snapshot() : undefined,
    currentSession: () => connected ? live.currentSession() : undefined,
    ensure: async () => { ensures++; connected = true; },
    ensureCount: () => ensures,
  };
}

test("a detached workspace connects before reading verified models and reuses that Runtime", async () => {
  const runtime = detachedModels();
  const api = facade({ get: () => config() } as HostModelsService, runtime);
  try {
    for (let i = 0; i < 2; i++) {
      const result = await api.query({ queryName: "models.get", input: {} });
      assert.ok(result.ok);
      assert.equal(result.result.availability?.status, "verified");
      assert.deepEqual(result.result.availableModels.map(model => model.id), ["a", "b"]);
    }
    assert.equal(runtime.ensureCount(), 1);
  } finally { await api.close(); }
});

test("a detached workspace refresh connects and refreshes the same Runtime instead of the CLI", async () => {
  const runtime = detachedModels();
  let nativeRefreshes = 0, cliRefreshes = 0;
  const api = facade({ get: () => config(), refreshDiscovery: async () => { cliRefreshes++; } } as unknown as HostModelsService,
    runtime, operation => {
      assert.deepEqual(operation, { kind: "models.available.refresh", sessionId: "session" });
      nativeRefreshes++;
      return { sessionId: "session", refreshed: true };
    });
  try {
    const pending = submit(api, discoveryRequest());
    await pending.accepted;
    assert.equal((await pending.receipt).status, "completed");
    assert.equal(runtime.ensureCount(), 1);
    assert.equal(nativeRefreshes, 1);
    assert.equal(cliRefreshes, 0);
  } finally { await api.close(); }
});

test("failed workspace connection keeps config editable without authorizing cached models", async () => {
  const runtime = { ...detachedModels(), ensure: async () => { throw new Error("Test Runtime unavailable"); } };
  let cliRefreshes = 0;
  const api = facade({ get: () => ({ ...config(), availableModels: [row("cached")] }), refreshDiscovery: async () => { cliRefreshes++; } } as unknown as HostModelsService, runtime);
  try {
    const result = await api.query({ queryName: "models.get", input: {} });
    assert.ok(result.ok);
    assert.equal(result.result.generatedConfigYml, "configuration");
    assert.equal(result.result.availability?.status, "unverified");
    assert.deepEqual(result.result.availableModels, []);
    assert.match(result.result.availability?.reason ?? "", /Test Runtime unavailable/);
    const pending = submit(api, discoveryRequest());
    await pending.accepted;
    assert.equal((await pending.receipt).status, "failed");
    assert.equal(cliRefreshes, 0);
  } finally { await api.close(); }
});

for (const refresh of [false, true]) {
  test(`stalled model Runtime connection settles ${refresh ? "refresh" : "query"} after its deadline`, async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const runtime = { ...detachedModels(), ensure: () => new Promise<void>(() => {}) };
    const api = facade({ get: () => config() } as HostModelsService, runtime);
    try {
      if (refresh) {
        const pending = submit(api, discoveryRequest());
        await pending.accepted;
        context.mock.timers.tick(30_000);
        assert.equal((await pending.receipt).status, "failed");
      } else {
        const pending = api.query({ queryName: "models.get", input: {} });
        await tick();
        context.mock.timers.tick(30_000);
        const result = await pending;
        assert.ok(result.ok);
        assert.equal(result.result.availability?.status, "unverified");
        assert.deepEqual(result.result.availableModels, []);
      }
    } finally { await api.close(); }
  });
}
