/**
 * Plan 07 Desktop composition gate: persisted workspace, fake Runtime,
 * transcript hydrate, core.prompt, reload. No user project, no real OMP.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  StudioClientImpl,
  selectComposerReceipt,
  selectConversationViews,
  type ClientClockAndIds,
} from "@omp-studio/client";
import type { CommandRequestId, IdempotencyKey } from "@omp-studio/client-contract";
import type { HostRuntimeHelloView } from "@omp-studio/host-client-api";
import { privateEndpoint, type PlatformPort } from "@omp-studio/platform";
import type { RuntimeProbePort, RuntimePublication, StudioConversationForward, StudioRuntimeSessionController } from "@omp-studio/studio-host";
import {
  FULL_PARITY_REQUIRED_CAPABILITIES,
  type CommandId,
  type ConversationTranscriptPage,
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
  CONVERSATION_FIXTURE_IDS,
  conversationLiveSequence,
  conversationPages,
  conversationStudioEnvelope,
} from "@omp-studio/testkit";

import {
  createDesktopHostComposition,
  type DesktopAuthorityLock,
  type DesktopPrivateEndpoint,
  type DesktopRuntimeSession,
  type DesktopRuntimeSessionContext,
  type DesktopRuntimeSessionPort,
} from "../src/host-composition.js";

const UPSTREAM_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const T0 = "2026-08-15T12:00:00.000Z";
const EPOCH = CONVERSATION_FIXTURE_IDS.runtimeEpoch;
const SESSION = CONVERSATION_FIXTURE_IDS.sessionId as SessionId;

const SNAPSHOT: OperatorStateSnapshot = {
  runtimeId: "rt-0001" as RuntimeId,
  runtimeEpoch: EPOCH,
  stateVersion: 1 as StateVersion,
  sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
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
  runtimeEpoch: Number(EPOCH),
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
  runtimeEpoch: EPOCH,
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

function clock(): ClientClockAndIds {
  let n = 0;
  return {
    now: () => T0,
    newRequestId: () => `req-desk-${++n}` as CommandRequestId,
    newIdempotencyKey: () => `idem-desk-${n}` as IdempotencyKey,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for desktop conversation gate");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function fakePlatform(profileDirectory: string): PlatformPort {
  return {
    platform: "win32",
    appDataDirectory: async () => profileDirectory,
    runtimeExecutableName: () => "omp.exe",
    createPrivateEndpoint: async () => {
      throw new Error("unused in plan 07 desktop gate");
    },
    createProcessContainment: () => {
      throw new Error("unused in plan 07 desktop gate");
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
  page: ConversationTranscriptPage;
  conversationListeners: Array<(event: StudioConversationForward) => void>;
  session: DesktopRuntimeSession;
  setInvoke(impl: (request: StudioRequest) => Promise<StudioReceipt>): void;
}

function createLiveSession(): LiveHandle {
  const listeners = new Set<(publication: RuntimePublication) => void>();
  const handle: LiveHandle = {
    page: conversationPages.empty,
    conversationListeners: [],
    session: undefined as unknown as DesktopRuntimeSession,
    setInvoke() {},
  };
  let invokeImpl: (request: StudioRequest) => Promise<StudioReceipt> = async (request) => ({
    type: "studio.receipt",
    requestId: request.requestId,
    runtimeEpoch: SNAPSHOT.runtimeEpoch,
    stateVersion: SNAPSHOT.stateVersion,
    status: "completed",
  });
  const publication = (): RuntimePublication => ({
    commitSeq: 1,
    publishedAt: T0,
    snapshot: structuredClone(SNAPSHOT),
    terminalOutcomes: [],
  });
  handle.setInvoke = (impl) => {
    invokeImpl = impl;
  };
  handle.session = {
    controller: {
      refresh: async () => publication(),
      invoke: async (request: StudioRequest) => invokeImpl(request),
      runtimeLost: () => [],
      publication,
      dispose: () => {},
      readTranscript: async () => handle.page,
      messagesCursor: () => handle.page.headCursor,
      onConversationEvent: (listener: (event: StudioConversationForward) => void) => {
        handle.conversationListeners.push(listener);
        return () => {
          handle.conversationListeners = handle.conversationListeners.filter((item) => item !== listener);
        };
      },
      onConversationResync: () => () => {},
      onInteractionEvent: () => () => {},
    } as unknown as StudioRuntimeSessionController,
    hello: () => HELLO_VIEW,
    capabilityManifest: () => HELLO.capabilityManifest,
    commandManifest: () => COMMAND_MANIFEST,
    onPublication: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return handle;
}

async function withReady(
  run: (args: {
    composition: Awaited<ReturnType<typeof createDesktopHostComposition>>;
    live: LiveHandle;
  }) => Promise<void>,
): Promise<void> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "omp-p07-profile-"));
  const exeDir = await mkdtemp(join(tmpdir(), "omp-p07-exe-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "omp-p07-ws-"));
  const executablePath = join(exeDir, "omp-test.exe");
  await writeFile(executablePath, "fake runtime payload for fingerprinting");
  try {
    const live = createLiveSession();
    const port: DesktopRuntimeSessionPort = {
      async start(context: DesktopRuntimeSessionContext) {
        assert.ok(context.workspace, "persisted workspace must be injected");
        assert.equal(context.workspace.cwd, workspaceDir);
        return live.session;
      },
      async stop() {},
    };
    const composition = await createDesktopHostComposition({
      platform: fakePlatform(profileDirectory),
      authorityLock: fakeAuthorityLock(),
      privateEndpoint: fakePrivateEndpoint(),
      runtimeSession: port,
      resolver: {
        probe: {
          async probe() {
            return {
              hello: HELLO,
              commandManifest: COMMAND_MANIFEST,
              smoke: "passed" as const,
              shutdown: "passed" as const,
            };
          },
        } satisfies RuntimeProbePort,
      },
      preference: { kind: "system", executable: executablePath, allowLimited: false },
      facade: { getActiveWorkspace: () => ({ workspaceId: "ws-gate", cwd: workspaceDir }) },
    });
    try {
      await run({ composition, live });
    } finally {
      await composition.shutdown();
    }
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
    await rm(exeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

test("MVP-A desktop: persisted workspace hello → empty transcript → prompt accepted → two messages after reload", async () => {
  await withReady(async ({ composition, live }) => {
    assert.equal(composition.status, "ready");
    const client = new StudioClientImpl(composition.facade, clock());
    const bootstrap = await client.bootstrap();
    assert.equal(bootstrap.runtime.status, "connected");
    assert.ok(bootstrap.capabilityManifest.capabilities.some((entry) => entry.id === "core.prompt"));
    assert.equal(bootstrap.snapshot?.sessionId, CONVERSATION_FIXTURE_IDS.sessionId as SessionId);

    const genEmpty = client.beginTranscriptHydrate({ sessionId: CONVERSATION_FIXTURE_IDS.sessionId });
    const empty = await client.query("session.transcript.read", { limit: 50 });
    assert.equal(empty.items.length, 0);
    client.hydrateTranscript(empty, genEmpty);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    live.setInvoke(async (request) => {
      live.page = conversationPages.userAssistant;
      await gate;
      return {
        type: "studio.receipt",
        requestId: request.requestId,
        commandId: "runtime-command-prompt" as CommandId,
        runtimeEpoch: EPOCH,
        stateVersion: 2 as StateVersion,
        status: "completed",
      };
    });
    const handle = await client.command("core.prompt", { text: "hello" });
    await waitUntil(() => selectComposerReceipt(client.getState().commands, handle.requestId).phase === "accepted");
    assert.notEqual(selectComposerReceipt(client.getState().commands, handle.requestId).phase, "completed");
    await waitUntil(() => live.page.items.length === 2);
    const page = await client.query("session.transcript.read", { limit: 50 });
    assert.equal(page.items.length, 2);
    const gen = client.beginTranscriptHydrate({ sessionId: CONVERSATION_FIXTURE_IDS.sessionId });
    client.hydrateTranscript(page, gen);
    const views = selectConversationViews(client.getState().conversation).filter(
      (view) => view.kind === "item" && view.item.kind === "message",
    );
    assert.equal(views.length, 2);
    release?.();

    await composition.reload();
    const reloaded = new StudioClientImpl(composition.facade, clock());
    await reloaded.bootstrap();
    const genReload = reloaded.beginTranscriptHydrate({ sessionId: CONVERSATION_FIXTURE_IDS.sessionId });
    const again = await reloaded.query("session.transcript.read", { limit: 50 });
    reloaded.hydrateTranscript(again, genReload);
    const reloadViews = selectConversationViews(reloaded.getState().conversation).filter(
      (view) => view.kind === "item" && view.item.kind === "message",
    );
    assert.equal(reloadViews.length, 2);
    assert.equal(new Set(reloadViews.map((view) => (view.kind === "item" ? view.item.itemId : ""))).size, 2);
  });
});

test("MVP-B desktop: live sequence through composition is a single assistant + completed tool", async () => {
  await withReady(async ({ composition, live }) => {
    const client = new StudioClientImpl(composition.facade, clock());
    await client.bootstrap();
    const gen = client.beginTranscriptHydrate({ sessionId: CONVERSATION_FIXTURE_IDS.sessionId });
    client.hydrateTranscript(conversationPages.empty, gen);
    const seqs: number[] = [];
    client.subscribe({ scope: "runtime" }, (event) => {
      if (event.kind === "conversation.changed") seqs.push(event.eventSeq);
    });
    await waitUntil(() => live.conversationListeners.length > 0);
    for (const [index, update] of conversationLiveSequence.entries()) {
      for (const listener of live.conversationListeners) {
        listener({ envelope: conversationStudioEnvelope(update, index + 1) });
      }
    }
    const views = selectConversationViews(client.getState().conversation);
    const assistants = views.filter((view) => {
      if (view.kind === "item") return view.item.kind === "message" && view.item.role === "assistant";
      return view.message.role === "assistant";
    });
    assert.equal(assistants.length, 1);
    assert.equal(client.getState().conversation.liveMessages[CONVERSATION_FIXTURE_IDS.assistantItemId], undefined);
    const tools = Object.values(client.getState().conversation.liveTools);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.status, "completed");
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i]! > seqs[i - 1]!);
    }
    live.page = conversationPages.thinkingTool;
    const genReload = client.beginTranscriptHydrate({ sessionId: CONVERSATION_FIXTURE_IDS.sessionId });
    const history = await client.query("session.transcript.read", { limit: 50 });
    client.hydrateTranscript(history, genReload);
    const reloadAssistants = selectConversationViews(client.getState().conversation).filter(
      (view) => view.kind === "item" && view.item.kind === "message" && view.item.role === "assistant",
    );
    assert.equal(reloadAssistants.length, 1);
  });
});
