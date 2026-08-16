/**
 * Plan 07 MVP-A / MVP-B chain against a fake Runtime through Host facade + Client.
 * Isolated temp profile only. Does not spawn OMP or write a user project.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  StudioClientImpl,
  selectComposerReceipt,
  selectConversationViews,
  type ClientClockAndIds,
} from "@omp-studio/client";
import type {
  AuthorityEpoch,
  AuthorityId,
  CommandRequestId,
  IdempotencyKey,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
} from "@omp-studio/client-contract";
import { StudioHostClientFacade, type HostRuntimeAccess, type HostSemanticCommandService } from "@omp-studio/host-client-api";
import { HostBackend, type StudioConversationForward } from "@omp-studio/studio-host";
import type { ConversationTranscriptPage, OperatorStateSnapshot, StudioOperation } from "@omp-studio/studio-protocol";

import {
  CONVERSATION_FIXTURE_IDS,
  CONVERSATION_FIXTURE_T0,
  conversationLiveSequence,
  conversationPages,
  conversationStudioEnvelope,
} from "../src/conversation-fixtures.js";

const T0 = CONVERSATION_FIXTURE_T0;

function snapshot(): OperatorStateSnapshot {
  return {
    runtimeId: "rt-0001" as RuntimeId,
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    stateVersion: 41 as StateVersion,
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
}

function hello() {
  return {
    runtimeId: "rt-0001",
    runtimeEpoch: Number(CONVERSATION_FIXTURE_IDS.runtimeEpoch),
    classification: "managed" as const,
  };
}

function capabilityManifest() {
  return {
    profile: "full-parity-v1" as const,
    generatedAt: T0,
    hash: "cap-gate-0001",
    capabilities: [
      { id: "core.prompt", grade: "stable" as const, version: 1, evidence: "plan-07-gate" },
      { id: "session.history", grade: "stable" as const, version: 1, evidence: "plan-07-gate" },
    ],
  };
}

function clock(): ClientClockAndIds {
  let n = 0;
  return {
    now: () => T0,
    newRequestId: () => `req-gate-${++n}` as CommandRequestId,
    newIdempotencyKey: () => `idem-gate-${n}` as IdempotencyKey,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for conversation gate condition");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function messageRoles(page: ConversationTranscriptPage): string[] {
  return page.items.filter((item) => item.kind === "message").map((item) => item.role);
}

test("MVP-A: empty transcript → core.prompt accepted non-terminal → persist two messages → reload hydrate does not duplicate", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-gate-mvp-a-"));
  try {
    const backend = new HostBackend({ stateDirectory: profile });
    await backend.initialize();
    let page: ConversationTranscriptPage = conversationPages.empty;
    let releaseInvoke: (() => void) | undefined;
    const invokeGate = new Promise<void>((resolve) => {
      releaseInvoke = resolve;
    });
    const commands: HostSemanticCommandService = {
      resume: async () => snapshot(),
      drop: async () => snapshot(),
      respond: async () => snapshot(),
      invoke: async (operation: StudioOperation) => {
        assert.equal(operation.kind, "core.prompt");
        page = conversationPages.userAssistant;
        await invokeGate;
        return snapshot();
      },
    };
    const runtime: HostRuntimeAccess = {
      hello,
      snapshot,
      readTranscript: async () => page,
      messagesCursor: () => page.headCursor,
    };
    const facade = new StudioHostClientFacade({
      authority: { authorityId: "auth-gate" as AuthorityId, authorityEpoch: 7 as AuthorityEpoch },
      platform: "win32",
      arch: "x64",
      backend,
      capabilityManifest,
      commandManifest: () => undefined,
      catalog: { list: async () => [] },
      diagnostics: {
        now: () => T0,
        newEntryId: () => "diag-gate" as never,
      },
      install: async () => {
        throw new Error("runtime.install is not wired in plan 07 gate");
      },
      runtime,
      commands,
    });
    const client = new StudioClientImpl(facade, clock());
    try {
      const bootstrap = await client.bootstrap();
      assert.equal(bootstrap.runtime.status, "connected");
      assert.ok(bootstrap.capabilityManifest.capabilities.some((entry) => entry.id === "core.prompt"));
      assert.equal(bootstrap.snapshot?.sessionId, CONVERSATION_FIXTURE_IDS.sessionId as SessionId);

      const genEmpty = client.beginTranscriptHydrate({ sessionId: CONVERSATION_FIXTURE_IDS.sessionId });
      const empty = await client.query("session.transcript.read", { limit: 50 });
      assert.equal(empty.items.length, 0);
      client.hydrateTranscript(empty, genEmpty);
      assert.equal(client.getState().conversation.order.length, 0);

      const handle = await client.command("core.prompt", { text: "hello" });
      await waitUntil(() => selectComposerReceipt(client.getState().commands, handle.requestId).phase === "accepted");
      assert.equal(selectComposerReceipt(client.getState().commands, handle.requestId).phase, "accepted");
      assert.notEqual(selectComposerReceipt(client.getState().commands, handle.requestId).phase, "completed");

      await waitUntil(() => page.items.length === 2);
      const afterPrompt = await client.query("session.transcript.read", { limit: 50 });
      assert.deepEqual(messageRoles(afterPrompt), ["user", "assistant"]);
      assert.equal(afterPrompt.items.length, 2);

      const genHydrate = client.beginTranscriptHydrate({ sessionId: CONVERSATION_FIXTURE_IDS.sessionId });
      client.hydrateTranscript(afterPrompt, genHydrate);
      const clientViews = selectConversationViews(client.getState().conversation);
      const persisted = clientViews.filter((view) => view.kind === "item" && view.item.kind === "message");
      assert.equal(persisted.length, 2);
      assert.equal(new Set(persisted.map((view) => (view.kind === "item" ? view.item.itemId : ""))).size, 2);

      const genReload = client.beginTranscriptHydrate({ sessionId: CONVERSATION_FIXTURE_IDS.sessionId });
      const reloaded = await client.query("session.transcript.read", { limit: 50 });
      client.hydrateTranscript(reloaded, genReload);
      const reloadViews = selectConversationViews(client.getState().conversation).filter(
        (view) => view.kind === "item" && view.item.kind === "message",
      );
      assert.equal(reloadViews.length, 2);
      assert.equal(new Set(reloadViews.map((view) => (view.kind === "item" ? view.item.itemId : ""))).size, 2);
    } finally {
      releaseInvoke?.();
      await client.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("MVP-B: live start/delta/tool/completed converges on one assistant and one tool, then history reload", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-gate-mvp-b-"));
  try {
    const backend = new HostBackend({ stateDirectory: profile });
    await backend.initialize();
    let page: ConversationTranscriptPage = conversationPages.empty;
    const listeners: Array<(event: StudioConversationForward) => void> = [];
    const runtime: HostRuntimeAccess = {
      hello,
      snapshot,
      readTranscript: async () => page,
      onConversationEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const facade = new StudioHostClientFacade({
      authority: { authorityId: "auth-gate-b" as AuthorityId, authorityEpoch: 7 as AuthorityEpoch },
      platform: "win32",
      arch: "x64",
      backend,
      capabilityManifest,
      commandManifest: () => undefined,
      catalog: { list: async () => [] },
      diagnostics: {
        now: () => T0,
        newEntryId: () => "diag-gate-b" as never,
      },
      install: async () => {
        throw new Error("runtime.install is not wired in plan 07 gate");
      },
      runtime,
    });
    const client = new StudioClientImpl(facade, clock());
    try {
      await client.bootstrap();
      const gen = client.beginTranscriptHydrate({ sessionId: CONVERSATION_FIXTURE_IDS.sessionId });
      client.hydrateTranscript(conversationPages.empty, gen);
      const seqs: number[] = [];
      client.subscribe({ scope: "runtime" }, (event) => {
        if (event.kind === "conversation.changed") seqs.push(event.eventSeq);
      });
      for (const [index, update] of conversationLiveSequence.entries()) {
        listeners[0]!({ envelope: conversationStudioEnvelope(update, index + 1) });
      }
      const conversation = client.getState().conversation;
      const views = selectConversationViews(conversation);
      const assistants = views.filter((view) => {
        if (view.kind === "item") return view.item.kind === "message" && view.item.role === "assistant";
        return view.message.role === "assistant";
      });
      assert.equal(assistants.length, 1);
      const assistant = assistants[0]!;
      if (assistant.kind === "item" && assistant.item.kind === "message") {
        const text = assistant.item.content.find((block) => block.type === "text");
        assert.equal(text && text.type === "text" ? text.text : "", "正在完成");
      } else {
        assert.fail("completed item must replace the live assistant buffer");
      }
      assert.equal(Object.keys(conversation.liveMessages).length, 0);
      const tools = Object.values(conversation.liveTools);
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.status, "completed");
      assert.equal(tools[0]?.toolName, "Read");
      for (let i = 1; i < seqs.length; i++) {
        assert.ok(seqs[i]! > seqs[i - 1]!, "eventSeq must be monotonic");
      }
      page = conversationPages.thinkingTool;
      const genReload = client.beginTranscriptHydrate({ sessionId: CONVERSATION_FIXTURE_IDS.sessionId });
      const history = await client.query("session.transcript.read", { limit: 50 });
      client.hydrateTranscript(history, genReload);
      const reloadViews = selectConversationViews(client.getState().conversation);
      const reloadAssistants = reloadViews.filter(
        (view) => view.kind === "item" && view.item.kind === "message" && view.item.role === "assistant",
      );
      assert.equal(reloadAssistants.length, 1);
      assert.equal(client.getState().conversation.liveMessages[CONVERSATION_FIXTURE_IDS.assistantItemId], undefined);
    } finally {
      await client.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
