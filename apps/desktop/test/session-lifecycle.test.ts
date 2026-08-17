/**
 * Plan 06: session lifecycle, client requestId invoke, live conversation hooks.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ClientEvent, CommandRequestId, IdempotencyKey, ThreadId } from "@omp-studio/client-contract";
import { threadIdFor } from "@omp-studio/host-client-api";
import type { HostRuntimeHelloView } from "@omp-studio/host-client-api";
import { privateEndpoint, type PlatformPort } from "@omp-studio/platform";
import type { RuntimeProbePort, StudioConversationForward, StudioRuntimeSessionController } from "@omp-studio/studio-host";
import {
  FULL_PARITY_REQUIRED_CAPABILITIES,
  type OperatorCommandManifest,
  type OperatorStateSnapshot,
  type RequestId,
  type RuntimeEpoch,
  type RuntimeId,
  type RuntimeInstanceId,
  type SessionId,
  type StateVersion,
  type StudioHelloResponse,
  type StudioReceipt,
  type StudioRequest,
} from "@omp-studio/studio-protocol";

import {
  createDesktopHostComposition,
  type DesktopAuthorityLock,
  type DesktopPrivateEndpoint,
  type DesktopRuntimeSession,
  type DesktopRuntimeSessionPort,
} from "../src/host-composition.js";

const UPSTREAM_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const T0 = "2026-08-15T00:00:00.000Z";
const SESSION_A = "sess-aaa" as SessionId;
const SESSION_B = "sess-bbb" as SessionId;

const SNAPSHOT: OperatorStateSnapshot = {
  runtimeId: "rt-0001" as RuntimeId,
  runtimeEpoch: 1 as RuntimeEpoch,
  stateVersion: 1 as StateVersion,
  sessionId: SESSION_A,
  isStreaming: false,
  isCompacting: false,
  activeMode: "normal", approvalMode: "yolo",
  pendingMessages: 0,
  activeCommandIds: [],
  agentsRevision: 0,
  jobsRevision: 0,
  agents: [],
  jobs: [],
};

const HELLO_VIEW: HostRuntimeHelloView = {
  runtimeId: "rt-0001",
  runtimeEpoch: 1,
  classification: "compatible-system",
  backend: "studio-host",
  runtimeVersion: "1.2.3",
  upstreamVersion: "0.9.0",
  upstreamCommit: UPSTREAM_COMMIT,
};

const HELLO: StudioHelloResponse = {
  type: "studio.hello.result",
  requestId: "probe-req-1" as RequestId,
  selectedProtocolVersion: 1,
  runtimeVersion: "1.2.3",
  upstreamVersion: "0.9.0",
  upstreamCommit: UPSTREAM_COMMIT,
  runtimeInstanceId: "rt-inst-0001" as RuntimeInstanceId,
  runtimeEpoch: 1 as RuntimeEpoch,
  capabilityManifest: {
    profile: "full-parity-v1",
    generatedAt: T0,
    hash: "cap-hash-0001",
    capabilities: FULL_PARITY_REQUIRED_CAPABILITIES.map((id) => ({
      id,
      grade: "stable" as const,
      version: 1,
      evidence: "probed",
    })),
  },
  commandManifestHash: "cmd-hash-0001",
  stateVersion: 1 as StateVersion,
  challengeProof: "proof-0001",
};

const COMMAND_MANIFEST: OperatorCommandManifest = {
  generatedAt: T0,
  upstreamCommit: UPSTREAM_COMMIT,
  hash: "cmd-hash-0001",
  commands: [],
  unclassifiedBuiltins: [],
};

function fullParityProbe(): RuntimeProbePort {
  return {
    async probe() {
      return {
        hello: HELLO,
        commandManifest: COMMAND_MANIFEST,
        smoke: "passed" as const,
        shutdown: "passed" as const,
      };
    },
  };
}

function fakePlatform(profileDirectory: string): PlatformPort {
  return {
    platform: "win32",
    appDataDirectory: async () => profileDirectory,
    runtimeExecutableName: () => "omp.exe",
    createPrivateEndpoint: async () => {
      throw new Error("unused");
    },
    createProcessContainment: () => {
      throw new Error("unused");
    },
    revealPath: async () => {},
    openExternal: async () => {},
  };
}

function fakeAuthorityLock(): DesktopAuthorityLock {
  return {
    async acquire() {
      return { authorityId: "auth-0001", epoch: "epoch-0001", release: async () => {} };
    },
  };
}

function fakePrivateEndpoint(): DesktopPrivateEndpoint {
  return {
    async createCurrentUserOnly() {
      return { endpoint: privateEndpoint("in-memory", "authority-0001"), release: async () => {} };
    },
  };
}

interface LiveHandle {
  snapshot: OperatorStateSnapshot;
  invokes: StudioRequest[];
  conversationListeners: Array<(event: StudioConversationForward) => void>;
  session: DesktopRuntimeSession;
  setSnapshot(next: OperatorStateSnapshot): void;
}

function liveSession(initial: OperatorStateSnapshot = SNAPSHOT): LiveHandle {
  const handle: LiveHandle = {
    snapshot: { ...initial },
    invokes: [],
    conversationListeners: [],
    session: undefined as unknown as DesktopRuntimeSession,
    setSnapshot(next) {
      handle.snapshot = { ...next };
    },
  };
  handle.session = {
    controller: {
      refresh: async () => ({ commitSeq: 1, publishedAt: T0, snapshot: handle.snapshot, terminalOutcomes: [] }),
      invoke: async (request: StudioRequest): Promise<StudioReceipt> => {
        handle.invokes.push(request);
        const operation = "operation" in request ? request.operation : undefined;
        const receipt: StudioReceipt = {
          type: "studio.receipt",
          requestId: request.requestId,
          runtimeEpoch: handle.snapshot.runtimeEpoch,
          stateVersion: handle.snapshot.stateVersion,
          status: "completed",
        };
        if (operation !== undefined && operation.kind === "operator.invoke") {
          receipt.result = { output: ["Session exported to: omp-session-x.html"], result: { consumed: true } };
        }
        return receipt;
      },
      runtimeLost: () => [],
      publication: () => ({ commitSeq: 1, publishedAt: T0, snapshot: handle.snapshot, terminalOutcomes: [] }),
      dispose: () => {},
      onConversationEvent: (listener: (event: StudioConversationForward) => void) => {
        handle.conversationListeners.push(listener);
        return () => {
          handle.conversationListeners = handle.conversationListeners.filter((item) => item !== listener);
        };
      },
      onConversationResync: () => () => {},
      onInteractionEvent: () => () => {},
      messagesCursor: () => "opaque-head-hint",
      readTranscript: async () => ({
        runtimeEpoch: handle.snapshot.runtimeEpoch,
        sessionId: handle.snapshot.sessionId,
        branchLeafId: "leaf-1",
        items: [],
        headCursor: "opaque-head-hint",
        hasMoreBefore: false,
      }),
    } as unknown as StudioRuntimeSessionController,
    hello: () => HELLO_VIEW,
    capabilityManifest: () => HELLO.capabilityManifest,
    commandManifest: () => COMMAND_MANIFEST,
    onPublication: () => () => {},
  };
  return handle;
}

async function withReady(
  run: (args: {
    composition: Awaited<ReturnType<typeof createDesktopHostComposition>>;
    live: LiveHandle;
    switches: Array<{ kind: string; sessionId?: string }>;
  }) => Promise<void>,
  options: {
    catalog?: Array<{ sessionId: string }>;
    streaming?: boolean;
    startSession?: boolean;
    concurrentSessions?: boolean;
  } = {},
): Promise<void> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "omp-p06-profile-"));
  const exeDir = await mkdtemp(join(tmpdir(), "omp-p06-exe-"));
  const executablePath = join(exeDir, "omp-test.exe");
  await writeFile(executablePath, "fake");
  try {
    const live = liveSession({ ...SNAPSHOT, isStreaming: options.streaming === true });
    const switches: Array<{ kind: string; sessionId?: string }> = [];
    const port: DesktopRuntimeSessionPort = {
      ...(options.concurrentSessions === true ? { supportsConcurrentSessions: true } : {}),
      async start() {
        if (options.startSession === false) {
          return undefined;
        }
        return live.session;
      },
      async stop() {},
      async switchSession(intent) {
        switches.push(intent.kind === "resume" ? intent : { kind: "fresh" });
        if (intent.kind === "resume") {
          live.setSnapshot({
            ...live.snapshot,
            sessionId: intent.sessionId as SessionId,
            runtimeEpoch: (Number(live.snapshot.runtimeEpoch) + 1) as RuntimeEpoch,
          });
        } else {
          live.setSnapshot({
            ...live.snapshot,
            sessionId: "session-fresh" as SessionId,
            runtimeEpoch: (Number(live.snapshot.runtimeEpoch) + 1) as RuntimeEpoch,
          });
        }
        return live.session;
      },
    };
    const composition = await createDesktopHostComposition({
      platform: fakePlatform(profileDirectory),
      authorityLock: fakeAuthorityLock(),
      privateEndpoint: fakePrivateEndpoint(),
      runtimeSession: port,
      resolver: { probe: fullParityProbe() },
      preference: { kind: "system", executable: executablePath, allowLimited: false },
      facade: {
        getActiveWorkspace: () => ({ workspaceId: "ws-1", cwd: profileDirectory }),
        catalog: {
          list: async () =>
            (options.catalog ?? [{ sessionId: SESSION_A }, { sessionId: SESSION_B }]).map((entry) => ({
              sessionId: entry.sessionId,
              modifiedAt: T0,
              messageCount: 0,
              status: "active" as const,
            })),
        },
      },
    });
    try {
      await run({ composition, live, switches });
    } finally {
      await composition.shutdown();
    }
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
    await rm(exeDir, { recursive: true, force: true });
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("P4 invoke forwards the client requestId instead of minting gui-* ids", async () => {
  await withReady(async ({ composition, live }) => {
    const requestId = "client-req-prompt-1" as CommandRequestId;
    await composition.facade.command({
      commandName: "core.prompt",
      input: { text: "hi" },
      idempotencyKey: "idem-prompt-1" as IdempotencyKey,
      requestId,
    });
    await waitUntil(() => live.invokes.length === 1);
    assert.equal(live.invokes[0]?.requestId, requestId);
    assert.equal(String(live.invokes[0]?.requestId).startsWith("gui-"), false);
  });
});

test("core.abort omits expectedStateVersion so a live turn can be interrupted", async () => {
  await withReady(async ({ composition, live }) => {
    live.setSnapshot({ ...live.snapshot, isStreaming: true, stateVersion: 4 as StateVersion });
    await composition.facade.command({
      commandName: "core.abort",
      input: {},
      idempotencyKey: "idem-abort-1" as IdempotencyKey,
      requestId: "client-req-abort-1" as CommandRequestId,
    });
    await waitUntil(() => live.invokes.length === 1);
    const abort = live.invokes[0];
    assert.equal(abort?.operation.kind, "core.abort");
    assert.equal("expectedStateVersion" in (abort ?? {}), false);

    await composition.facade.command({
      commandName: "core.prompt",
      input: { text: "after" },
      idempotencyKey: "idem-prompt-fenced" as IdempotencyKey,
      requestId: "client-req-prompt-fenced" as CommandRequestId,
    });
    await waitUntil(() => live.invokes.length === 2);
    assert.equal(live.invokes[1]?.operation.kind, "core.prompt");
    assert.equal(live.invokes[1]?.expectedStateVersion, live.snapshot.stateVersion);
  });
});

test("session.model.set omits expectedStateVersion so a live turn can queue the next model", async () => {
  await withReady(async ({ composition, live }) => {
    live.setSnapshot({ ...live.snapshot, isStreaming: true, stateVersion: 4 as StateVersion });
    await composition.facade.command({
      commandName: "session.model.set",
      input: { selector: "anthropic/claude-opus-4-6" },
      idempotencyKey: "idem-model-1" as IdempotencyKey,
      requestId: "client-req-model-1" as CommandRequestId,
    });
    await waitUntil(() => live.invokes.length === 1);
    const modelSet = live.invokes[0];
    assert.equal(modelSet?.operation.kind, "session.model.set");
    assert.equal("expectedStateVersion" in (modelSet ?? {}), false);
  });
});

test("mode.plan.enter omits expectedStateVersion so a live turn can queue the next mode", async () => {
  await withReady(async ({ composition, live }) => {
    live.setSnapshot({ ...live.snapshot, isStreaming: true, stateVersion: 4 as StateVersion });
    await composition.facade.command({
      commandName: "mode.plan.enter",
      input: {},
      idempotencyKey: "idem-plan-1" as IdempotencyKey,
      requestId: "client-req-plan-1" as CommandRequestId,
    });
    await waitUntil(() => live.invokes.length === 1);
    const planEnter = live.invokes[0];
    assert.equal(planEnter?.operation.kind, "mode.plan.enter");
    assert.equal("expectedStateVersion" in (planEnter ?? {}), false);
  });
});

test("operator.invoke completion carries the command output envelope", async () => {
  await withReady(async ({ composition, live }) => {
    const events: ClientEvent[] = [];
    composition.facade.subscribe({ scope: "all" }, (event) => events.push(event));
    await composition.facade.command({
      commandName: "operator.invoke",
      input: { commandId: "builtin.export" },
      idempotencyKey: "idem-invoke-export" as IdempotencyKey,
      requestId: "client-req-export-1" as CommandRequestId,
    });
    await waitUntil(() => live.invokes.length === 1);
    await waitUntil(() => events.some((event) => event.kind === "command.receipt"));
    const receiptEvent = events.find((event) => event.kind === "command.receipt");
    assert.equal(receiptEvent?.kind, "command.receipt");
    if (receiptEvent?.kind !== "command.receipt") return;
    assert.equal(receiptEvent.receipt.status, "completed");
    assert.deepEqual(receiptEvent.receipt.result, {
      snapshot: live.snapshot,
      output: ["Session exported to: omp-session-x.html"],
      result: { consumed: true },
    });
  });
});

test("bootstrap messagesCursor is only the opaque hint", async () => {
  await withReady(async ({ composition }) => {
    const bootstrap = await composition.facade.bootstrap();
    assert.equal(bootstrap.messagesCursor, "opaque-head-hint");
    assert.equal("items" in bootstrap, false);
  });
});

test("transcript query follows the live session after resume", async () => {
  await withReady(async ({ composition, live, switches }) => {
    const accepted = await composition.facade.command({
      commandName: "session.resume",
      input: { threadId: threadIdFor(SESSION_B) },
      idempotencyKey: "idem-resume-b" as IdempotencyKey,
      requestId: "req-resume-b" as CommandRequestId,
    });
    assert.equal(accepted.status, "accepted");
    await waitUntil(() => switches.length === 1);
    assert.deepEqual(switches[0], { kind: "resume", sessionId: SESSION_B });
    assert.equal(live.snapshot.sessionId, SESSION_B);
    const page = await composition.facade.query({ queryName: "session.transcript.read", input: {} });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.equal(page.result.sessionId, SESSION_B);
  });
});

test("session.create starts a fresh sibling Runtime session", async () => {
  await withReady(async ({ composition, live, switches }) => {
    const receipts: string[] = [];
    composition.facade.subscribe({ scope: "all" }, (event) => {
      if (event.kind === "command.receipt") receipts.push(event.receipt.status);
    });
    const accepted = await composition.facade.command({
      commandName: "session.create",
      input: {},
      idempotencyKey: "idem-create-fresh" as IdempotencyKey,
      requestId: "req-create-fresh" as CommandRequestId,
    });
    assert.equal(accepted.status, "accepted");
    await waitUntil(() => receipts.includes("completed"));
    assert.deepEqual(switches, [{ kind: "fresh" }]);
    assert.equal(live.snapshot.sessionId, "session-fresh");
  });
});

test("resume of an unknown threadId does not switch the session", async () => {
  await withReady(async ({ composition, live, switches }) => {
    const receipts: string[] = [];
    composition.facade.subscribe({ scope: "all" }, (event) => {
      if (event.kind === "command.receipt") receipts.push(event.receipt.status);
    });
    await composition.facade.command({
      commandName: "session.resume",
      input: { threadId: "thread-unknown" as ThreadId },
      idempotencyKey: "idem-resume-unknown" as IdempotencyKey,
      requestId: "req-resume-unknown" as CommandRequestId,
    });
    await waitUntil(() => receipts.includes("failed"));
    assert.deepEqual(switches, []);
    assert.equal(live.snapshot.sessionId, SESSION_A);
  });
});

test("resume while streaming is rejected and keeps the current session", async () => {
  await withReady(
    async ({ composition, live, switches }) => {
      const receipts: string[] = [];
      composition.facade.subscribe({ scope: "all" }, (event) => {
        if (event.kind === "command.receipt") receipts.push(event.receipt.status);
      });
      await composition.facade.command({
        commandName: "session.resume",
        input: { threadId: threadIdFor(SESSION_B) },
        idempotencyKey: "idem-resume-busy" as IdempotencyKey,
        requestId: "req-resume-busy" as CommandRequestId,
      });
      await waitUntil(() => receipts.includes("failed"));
      assert.deepEqual(switches, []);
      assert.equal(live.snapshot.sessionId, SESSION_A);
    },
    { streaming: true },
  );
});

test("multi-session port may select a sibling while the current Session keeps streaming", async () => {
  await withReady(
    async ({ composition, live, switches }) => {
      const receipts: string[] = [];
      composition.facade.subscribe({ scope: "all" }, (event) => {
        if (event.kind === "command.receipt") receipts.push(event.receipt.status);
      });
      await composition.facade.command({
        commandName: "session.resume",
        input: { threadId: threadIdFor(SESSION_B) },
        idempotencyKey: "idem-resume-concurrent" as IdempotencyKey,
        requestId: "req-resume-concurrent" as CommandRequestId,
      });
      await waitUntil(() => receipts.includes("completed"));
      assert.deepEqual(switches, [{ kind: "resume", sessionId: SESSION_B }]);
      assert.equal(live.snapshot.sessionId, SESSION_B);
    },
    { streaming: true, concurrentSessions: true },
  );
});

test("resume of the current session is a no-op", async () => {
  await withReady(async ({ composition, switches }) => {
    const receipts: string[] = [];
    composition.facade.subscribe({ scope: "all" }, (event) => {
      if (event.kind === "command.receipt") receipts.push(event.receipt.status);
    });
    await composition.facade.command({
      commandName: "session.resume",
      input: { threadId: threadIdFor(SESSION_A) },
      idempotencyKey: "idem-resume-same" as IdempotencyKey,
      requestId: "req-resume-same" as CommandRequestId,
    });
    await waitUntil(() => receipts.includes("completed"));
    assert.deepEqual(switches, []);
  });
});

test("resume without a current Runtime snapshot starts the session via switchSession", async () => {
  await withReady(
    async ({ composition, live, switches }) => {
      const receipts: string[] = [];
      composition.facade.subscribe({ scope: "all" }, (event) => {
        if (event.kind === "command.receipt") receipts.push(event.receipt.status);
      });
      const accepted = await composition.facade.command({
        commandName: "session.resume",
        input: { threadId: threadIdFor(SESSION_B) },
        idempotencyKey: "idem-resume-cold" as IdempotencyKey,
        requestId: "req-resume-cold" as CommandRequestId,
      });
      assert.equal(accepted.status, "accepted");
      await waitUntil(() => receipts.includes("completed"));
      assert.deepEqual(switches, [{ kind: "resume", sessionId: SESSION_B }]);
      assert.equal(live.snapshot.sessionId, SESSION_B);
    },
    { startSession: false },
  );
});

test("reload does not replay conversation deltas buffered on the old facade", async () => {
  await withReady(async ({ composition, live }) => {
    const first: string[] = [];
    composition.facade.subscribe({ scope: "all" }, (event) => {
      if (event.kind === "conversation.changed") first.push(event.update.kind);
    });
    const started: StudioConversationForward = {
      envelope: {
        type: "studio.event",
        runtimeEpoch: 1 as RuntimeEpoch,
        eventSeq: 2 as never,
        stateVersion: 1 as StateVersion,
        occurredAt: T0,
        event: {
          kind: "conversation.message.started",
          sessionId: SESSION_A,
          turnId: "turn-1",
          messageId: "msg-1",
          role: "assistant",
          createdAt: T0,
        },
      },
    };
    for (const listener of live.conversationListeners) listener(started);
    assert.deepEqual(first, ["conversation.message.started"]);
    const reloaded = await composition.reload();
    const second: string[] = [];
    reloaded.facade.subscribe({ scope: "all" }, (event) => {
      if (event.kind === "conversation.changed") second.push(event.update.kind);
    });
    assert.deepEqual(second, []);
  });
});
