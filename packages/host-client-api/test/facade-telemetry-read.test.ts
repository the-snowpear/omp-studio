import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AuthorityEpoch,
  AuthorityId,
  ClientEvent,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
} from "@omp-studio/client-contract";
import type { OperatorStateSnapshot, SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";
import { HostBackend, type StudioTelemetryForward } from "@omp-studio/studio-host";

import {
  StudioHostClientFacade,
  type HostRuntimeAccess,
  type HostRuntimeHelloView,
  type HostSessionArchiveProvider,
  type HostSessionTelemetryProbePort,
  type HostSessionTelemetryStorePort,
  type HostTelemetryProbeWorkspacePort,
} from "../src/index.js";

const T0 = "2026-08-16T00:00:00.000Z";
const SESSION = "session-archive-1" as SessionId;
const LIVE_SESSION = "session-live" as SessionId;

function telemetrySnapshot(sessionId: string, input: number): SessionTelemetrySnapshot {
  return {
    sessionId: sessionId as SessionId,
    capturedAt: T0,
    tokens: { input, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: input + 2, cost: 0.1 },
    context: {
      contextWindow: 128_000,
      usedTokens: 500,
      percent: 0.39,
      anchored: false,
      systemPromptTokens: 100,
      systemContextTokens: 100,
      systemToolsTokens: 100,
      skillsTokens: 10,
      messagesTokens: 190,
    },
  };
}

function operatorSnapshot(sessionId: string, telemetry?: SessionTelemetrySnapshot): OperatorStateSnapshot {
  return {
    runtimeId: "rt-1" as RuntimeId,
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 4 as StateVersion,
    sessionId,
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal",
    approvalMode: "yolo",
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
    ...(telemetry === undefined ? {} : { telemetry }),
  } as unknown as OperatorStateSnapshot;
}

function runtimeAccess(snapshot: () => OperatorStateSnapshot | undefined, onTelemetry?: (listener: (event: StudioTelemetryForward) => void) => () => void): HostRuntimeAccess {
  return {
    hello: (): HostRuntimeHelloView => ({ runtimeId: "rt-1", runtimeEpoch: 1, classification: "managed" }),
    snapshot,
    ...(onTelemetry === undefined ? {} : { onTelemetryEvent: onTelemetry }),
  } as unknown as HostRuntimeAccess;
}

interface Harness {
  readonly archive: HostSessionArchiveProvider;
  readonly store: {
    recorded: Array<{ sessionId: string; telemetry: SessionTelemetrySnapshot }>;
    reads: string[];
    persisted: Map<string, SessionTelemetrySnapshot | undefined>;
    flushes: number;
  } & HostSessionTelemetryStorePort;
  readonly probe: {
    calls: Array<{ sessionId: string; sessionFile: string; allowedCwd: string; transcriptRevision: string }>;
    outcome: () => { ok: true; telemetry: SessionTelemetrySnapshot } | { ok: false; reason: "UNAVAILABLE" };
  } & HostSessionTelemetryProbePort;
  readonly workspace: {
    created: string[];
    removed: string[];
  } & HostTelemetryProbeWorkspacePort;
}

function harness(options: { readonly revision?: string } = {}): Harness {
  const revision = options.revision ?? "sha256:rev-1";
  const archive: HostSessionArchiveProvider = {
    readPage: async () => {
      throw new Error("readPage is not part of this test");
    },
    readRevision: async (sessionId: string) => ({ sessionId, transcriptRevision: revision }),
    createProbeCopy: async (sessionId: string, directory: string) => ({
      sessionId,
      transcriptRevision: revision,
      temporarySessionFile: `${directory}\\probe-copy.jsonl`,
    }),
  };
  const storeState = {
    recorded: [] as Array<{ sessionId: string; telemetry: SessionTelemetrySnapshot }>,
    reads: [] as string[],
    persisted: new Map<string, SessionTelemetrySnapshot | undefined>(),
    flushes: 0,
  };
  const store = {
    ...storeState,
    record(sessionId: string, telemetry: SessionTelemetrySnapshot): void {
      storeState.recorded.push({ sessionId, telemetry });
    },
    async read(sessionId: string, rev: string): Promise<{ telemetry: SessionTelemetrySnapshot } | undefined> {
      storeState.reads.push(`${sessionId}@${rev}`);
      const value = storeState.persisted.get(rev);
      return value === undefined ? undefined : { telemetry: value };
    },
    async flush(): Promise<void> {
      storeState.flushes += 1;
    },
    dispose(): void {},
  } as Harness["store"];
  const probeState = {
    calls: [] as Array<{ sessionId: string; sessionFile: string; allowedCwd: string; transcriptRevision: string }>,
  };
  let outcome: Harness["probe"]["outcome"] = () => ({ ok: true, telemetry: telemetrySnapshot(SESSION, 77) });
  const probe = {
    setOutcome(next: Harness["probe"]["outcome"]): void {
      outcome = next;
    },
    async run(input: { sessionId: string; sessionFile: string; allowedCwd: string; transcriptRevision: string }) {
      probeState.calls.push(input);
      return outcome();
    },
    calls: probeState.calls,
  } as unknown as Harness["probe"];
  const workspaceState = { created: [] as string[], removed: [] as string[] };
  const workspace = {
    ...workspaceState,
    async create(): Promise<string> {
      const directory = `C:\\probe-scratch-${workspaceState.created.length + 1}`;
      workspaceState.created.push(directory);
      return directory;
    },
    async remove(path: string): Promise<void> {
      workspaceState.removed.push(path);
    },
  } as Harness["workspace"];
  return { archive, store, probe, workspace };
}

async function withFacade(
  parts: {
    readonly runtime?: HostRuntimeAccess;
    readonly archive?: HostSessionArchiveProvider;
    readonly telemetryStore?: HostSessionTelemetryStorePort;
    readonly telemetryProbe?: HostSessionTelemetryProbePort;
    readonly telemetryProbeWorkspace?: HostTelemetryProbeWorkspacePort;
    readonly workspaceCwd?: () => string | undefined;
  },
  run: (facade: StudioHostClientFacade) => Promise<void>,
): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "omp-facade-telemetry-"));
  try {
    const backend = new HostBackend({ stateDirectory: profile });
    await backend.initialize();
    const facade = new StudioHostClientFacade({
      authority: { authorityId: "auth-telemetry" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
      platform: "win32",
      arch: "x64",
      backend,
      capabilityManifest: () => undefined,
      commandManifest: () => undefined,
      catalog: { list: async () => [] },
      ...(parts.archive === undefined ? {} : { archive: parts.archive }),
      ...(parts.telemetryStore === undefined ? {} : { telemetryStore: parts.telemetryStore }),
      ...(parts.telemetryProbe === undefined ? {} : { telemetryProbe: parts.telemetryProbe }),
      ...(parts.telemetryProbeWorkspace === undefined ? {} : { telemetryProbeWorkspace: parts.telemetryProbeWorkspace }),
      ...(parts.workspaceCwd === undefined ? {} : { workspaceCwd: parts.workspaceCwd }),
      diagnostics: { now: () => T0, newEntryId: () => "diag-telemetry" as never },
      install: async () => {
        throw new Error("runtime.install is not wired in telemetry tests");
      },
      ...(parts.runtime === undefined ? {} : { runtime: parts.runtime }),
    });
    try {
      await run(facade);
    } finally {
      await facade.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

test("session.telemetry.read prefers the live runtime snapshot for the matching session", async () => {
  const parts = harness();
  await withFacade(
    {
      runtime: runtimeAccess(() => operatorSnapshot(SESSION, telemetrySnapshot(SESSION, 42))),
      archive: parts.archive,
      telemetryStore: parts.store,
      telemetryProbe: parts.probe,
      telemetryProbeWorkspace: parts.workspace,
      workspaceCwd: () => "C:\\workspace",
    },
    async (facade) => {
      const response = await facade.query({ queryName: "session.telemetry.read", input: { sessionId: SESSION } });
      assert.equal(response.ok, true);
      if (!response.ok) return;
      assert.equal(response.result.source, "live");
      assert.equal(response.result.semantics, "current-live");
      assert.equal(response.result.telemetry.tokens.input, 42);
      assert.equal(parts.store.reads.length, 0);
      assert.equal(parts.probe.calls.length, 0);
      // A live session must never answer for a different session id: the
      // probe result for the other session is rejected and the query fails.
      const other = await facade.query({ queryName: "session.telemetry.read", input: { sessionId: LIVE_SESSION } });
      assert.equal(other.ok, false);
      if (!other.ok) assert.equal(other.error.code, "UNAVAILABLE");
    },
  );
});

test("session.telemetry.read falls back to the persisted record when the revision matches", async () => {
  const parts = harness();
  parts.store.persisted.set("sha256:rev-1", telemetrySnapshot(SESSION, 33));
  await withFacade(
    {
      runtime: runtimeAccess(() => operatorSnapshot(LIVE_SESSION, telemetrySnapshot(LIVE_SESSION, 42))),
      archive: parts.archive,
      telemetryStore: parts.store,
      telemetryProbe: parts.probe,
      telemetryProbeWorkspace: parts.workspace,
      workspaceCwd: () => "C:\\workspace",
    },
    async (facade) => {
      const response = await facade.query({ queryName: "session.telemetry.read", input: { sessionId: SESSION } });
      assert.equal(response.ok, true);
      if (!response.ok) return;
      assert.equal(response.result.source, "persisted");
      assert.equal(response.result.semantics, "last-observed");
      assert.equal(response.result.telemetry.tokens.input, 33);
      assert.deepEqual(parts.store.reads, [`${SESSION}@sha256:rev-1`]);
      assert.equal(parts.probe.calls.length, 0);
    },
  );
});

test("session.telemetry.read recomputes through the one-shot probe and cleans up its scratch dir", async () => {
  const parts = harness();
  await withFacade(
    {
      archive: parts.archive,
      telemetryStore: parts.store,
      telemetryProbe: parts.probe,
      telemetryProbeWorkspace: parts.workspace,
      workspaceCwd: () => "C:\\workspace",
    },
    async (facade) => {
      const response = await facade.query({ queryName: "session.telemetry.read", input: { sessionId: SESSION } });
      assert.equal(response.ok, true);
      if (!response.ok) return;
      assert.equal(response.result.source, "archive-recomputed");
      assert.equal(response.result.semantics, "current-environment-recomputed");
      assert.equal(response.result.telemetry.tokens.input, 77);
      assert.equal(parts.probe.calls.length, 1);
      assert.equal(parts.probe.calls[0]?.sessionFile, "C:\\probe-scratch-1\\probe-copy.jsonl");
      assert.equal(parts.probe.calls[0]?.allowedCwd, "C:\\workspace");
      assert.equal(parts.probe.calls[0]?.transcriptRevision, "sha256:rev-1");
      assert.deepEqual(parts.workspace.removed, parts.workspace.created);
    },
  );
});

test("session.telemetry.read fails closed with UNAVAILABLE when every source is exhausted", async () => {
  const parts = harness();
  (parts.probe as unknown as { setOutcome(next: () => { ok: false; reason: "UNAVAILABLE" }): void }).setOutcome(
    () => ({ ok: false, reason: "UNAVAILABLE" }),
  );
  await withFacade(
    {
      archive: parts.archive,
      telemetryStore: parts.store,
      telemetryProbe: parts.probe,
      telemetryProbeWorkspace: parts.workspace,
      workspaceCwd: () => "C:\\workspace",
    },
    async (facade) => {
      const response = await facade.query({ queryName: "session.telemetry.read", input: { sessionId: SESSION } });
      assert.equal(response.ok, false);
      if (response.ok) return;
      assert.equal(response.error.code, "UNAVAILABLE");
      assert.deepEqual(parts.workspace.removed, parts.workspace.created);
      // Malformed probe payloads (wrong session) must also collapse to UNAVAILABLE.
      (parts.probe as unknown as { setOutcome(next: () => { ok: true; telemetry: SessionTelemetrySnapshot }): void }).setOutcome(
        () => ({ ok: true, telemetry: telemetrySnapshot("someone-else", 5) }),
      );
      const mismatch = await facade.query({ queryName: "session.telemetry.read", input: { sessionId: SESSION } });
      assert.equal(mismatch.ok, false);
      if (mismatch.ok) return;
      assert.equal(mismatch.error.code, "UNAVAILABLE");
    },
  );
});

test("session.telemetry.read requires the archive extensions and maps missing sessions to UNAVAILABLE", async () => {
  await withFacade(
    {
      archive: {
        readPage: async () => {
          throw new Error("unused");
        },
      },
    },
    async (facade) => {
      const response = await facade.query({ queryName: "session.telemetry.read", input: { sessionId: SESSION } });
      assert.equal(response.ok, false);
      if (response.ok) return;
      assert.equal(response.error.code, "UNAVAILABLE");
    },
  );
  const parts = harness();
  const missing: HostSessionArchiveProvider = {
    readPage: async () => {
      throw new Error("unused");
    },
    readRevision: async () => {
      throw Object.assign(new Error("Session is not available"), { code: "SESSION_NOT_FOUND" });
    },
    ...(parts.archive.createProbeCopy === undefined ? {} : { createProbeCopy: parts.archive.createProbeCopy }),
  };
  await withFacade(
    { archive: missing, telemetryProbe: parts.probe, telemetryProbeWorkspace: parts.workspace, workspaceCwd: () => "C:\\workspace" },
    async (facade) => {
      const response = await facade.query({ queryName: "session.telemetry.read", input: { sessionId: SESSION } });
      assert.equal(response.ok, false);
      if (response.ok) return;
      assert.equal(response.error.code, "UNAVAILABLE");
      assert.match(response.error.message, /not available/u);
      assert.equal(parts.probe.calls.length, 0);
    },
  );
});

test("a late probe result yields to a runtime that resumed the same session", async () => {
  const parts = harness();
  let current = operatorSnapshot(LIVE_SESSION);
  let releaseProbe: (() => void) | undefined;
  let deferredCalls = 0;
  const deferredProbe = {
    async run(input: { sessionId: string; sessionFile: string; allowedCwd: string; transcriptRevision: string }) {
      void input;
      deferredCalls += 1;
      await new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      return { ok: true as const, telemetry: telemetrySnapshot(SESSION, 77) };
    },
    getCalls: (): number => deferredCalls,
  } as unknown as HostSessionTelemetryProbePort;
  await withFacade(
    {
      runtime: runtimeAccess(() => current),
      archive: parts.archive,
      telemetryProbe: deferredProbe,
      telemetryProbeWorkspace: parts.workspace,
      workspaceCwd: () => "C:\\workspace",
    },
    async (facade) => {
      const pending = facade.query({ queryName: "session.telemetry.read", input: { sessionId: SESSION } });
      await new Promise((resolve) => setImmediate(resolve));
      current = operatorSnapshot(SESSION, telemetrySnapshot(SESSION, 42));
      releaseProbe?.();
      const response = await pending;
      assert.equal(response.ok, true);
      if (!response.ok) return;
      assert.equal(response.result.source, "live");
      assert.equal(response.result.telemetry.tokens.input, 42);
      assert.deepEqual(parts.workspace.removed, parts.workspace.created);
    },
  );
});

test("telemetry forwarding persists into the store for archived reads", async () => {
  const parts = harness();
  parts.store.persisted.set("sha256:rev-1", undefined);
  let publish: (event: StudioTelemetryForward) => void = () => {};
  const runtime = runtimeAccess(
    () => operatorSnapshot(LIVE_SESSION),
    (listener) => {
      publish = listener;
      return () => {
        publish = () => {};
      };
    },
  );
  await withFacade(
    {
      runtime,
      archive: parts.archive,
      telemetryStore: parts.store,
      telemetryProbeWorkspace: parts.workspace,
      workspaceCwd: () => "C:\\workspace",
    },
    async (facade) => {
      const events: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => events.push(event));
      const telemetry = telemetrySnapshot(LIVE_SESSION, 42);
      publish({
        envelope: {
          type: "studio.event",
          runtimeEpoch: 1 as RuntimeEpoch,
          eventSeq: 8 as never,
          stateVersion: 4 as StateVersion,
          occurredAt: T0,
          event: { kind: "session.telemetry.changed", sessionId: LIVE_SESSION, telemetry },
        },
      });
      assert.equal(events.filter((event) => event.kind === "telemetry.changed").length, 1);
      assert.equal(parts.store.recorded.length, 1);
      assert.equal(parts.store.recorded[0]?.sessionId, LIVE_SESSION);
      assert.equal(parts.store.recorded[0]?.telemetry.tokens.input, 42);
    },
  );
});
