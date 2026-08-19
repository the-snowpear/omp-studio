import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AuthorityEpoch,
  AuthorityId,
  ClientEvent,
  CommandRequestId,
  IdempotencyKey,
  OpaqueCursor,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
} from "@omp-studio/client-contract";
import type { AgentId, ConversationTranscriptPage, StudioAgentSnapshot, StudioOperation } from "@omp-studio/studio-protocol";
import type { ConversationTranscriptReadPage } from "@omp-studio/client-contract";
import { HostBackend, type RuntimePublication, type StudioConversationForward, type StudioTelemetryForward } from "@omp-studio/studio-host";

import {
  HostEventBus,
  StudioHostClientFacade,
  type HostRuntimeAccess,
  type HostRuntimeHelloView,
  type HostSemanticCommandService,
} from "../src/index.js";

const T0 = "2026-08-15T13:00:00.000Z";
const SESSION = "session-1" as SessionId;
const PAGE: ConversationTranscriptPage = {
  runtimeEpoch: 1 as RuntimeEpoch,
  sessionId: SESSION,
  branchLeafId: "leaf-1",
  items: [
    {
      kind: "message",
      itemId: "msg-user-1",
      parentId: null,
      createdAt: T0,
      role: "user",
      content: [{ type: "text", text: "Read package.json" }],
    },
  ],
  olderCursor: "opaque-older" as OpaqueCursor,
  headCursor: "opaque-head" as OpaqueCursor,
  hasMoreBefore: true,
};

function snapshot(sessionId = SESSION) {
  return {
    runtimeId: "rt-1" as RuntimeId,
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 4 as StateVersion,
    sessionId,
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal" as const, approvalMode: "yolo" as const,
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

function hello(): HostRuntimeHelloView {
  return { runtimeId: "rt-1", runtimeEpoch: 1, classification: "managed" };
}

function startedEnvelope(sessionId = "session-1"): StudioConversationForward {
  return {
    envelope: {
      type: "studio.event",
      runtimeEpoch: 1 as RuntimeEpoch,
      eventSeq: 7 as never,
      stateVersion: 4 as StateVersion,
      occurredAt: "2026-08-15T13:00:01.000Z",
      event: {
        kind: "conversation.message.started",
        sessionId: sessionId as SessionId,
        turnId: "turn-1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: T0,
      },
    },
  };
}

type ArchiveProvider = {
  readPage: (input: {
    sessionId: string;
    agentId?: string;
    cursor?: OpaqueCursor;
    limit?: number;
  }) => Promise<ConversationTranscriptReadPage>;
  listPersistedAgents?: (sessionId: string) => Promise<readonly StudioAgentSnapshot[]>;
};

async function withFacade(
  runtime: HostRuntimeAccess | undefined,
  commands: HostSemanticCommandService | undefined,
  run: (facade: StudioHostClientFacade) => Promise<void>,
  archive?: ArchiveProvider,
): Promise<void>;
async function withFacade(
  runtime: HostRuntimeAccess | undefined,
  commands: HostSemanticCommandService | undefined,
  archive: ArchiveProvider | undefined,
  run: (facade: StudioHostClientFacade) => Promise<void>,
): Promise<void>;
async function withFacade(
  runtime: HostRuntimeAccess | undefined,
  commands: HostSemanticCommandService | undefined,
  third: ArchiveProvider | ((facade: StudioHostClientFacade) => Promise<void>) | undefined,
  fourth?: ArchiveProvider | ((facade: StudioHostClientFacade) => Promise<void>),
): Promise<void> {
  const archive: ArchiveProvider | undefined =
    typeof third === "function" ? (typeof fourth === "function" ? undefined : fourth) : third;
  const run = (typeof third === "function" ? third : fourth) as
    | ((facade: StudioHostClientFacade) => Promise<void>)
    | undefined;
  if (typeof run !== "function") throw new Error("withFacade requires a callback");
  const profile = await mkdtemp(join(tmpdir(), "omp-facade-convo-"));
  try {
    const backend = new HostBackend({ stateDirectory: profile });
    await backend.initialize();
    const facade = new StudioHostClientFacade({
      authority: { authorityId: "auth-convo" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
      platform: "win32",
      arch: "x64",
      backend,
      capabilityManifest: () => undefined,
      commandManifest: () => undefined,
      catalog: { list: async () => [] },
      ...(archive === undefined ? {} : { archive }),
      diagnostics: {
        now: () => T0,
        newEntryId: () => "diag-convo" as never,
      },
      install: async () => {
        throw new Error("runtime.install is not wired in conversation tests");
      },
      ...(runtime === undefined ? {} : { runtime }),
      ...(commands === undefined ? {} : { commands }),
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

test("agent.conversation.read returns a child session page without requiring the main sessionId", async () => {
  const childPage = { ...PAGE, sessionId: "child-session" as SessionId };
  await withFacade(
    {
      hello,
      snapshot,
      readAgentConversation: async (input) => {
        assert.equal(input.agentId, "agent-019fcb01");
        return childPage;
      },
    },
    undefined,
    undefined,
    async (facade) => {
      const response = await facade.query({
        queryName: "agent.conversation.read",
        input: { agentId: "agent-019fcb01" as AgentId, limit: 50 },
      });
      assert.equal(response.ok, true);
      if (!response.ok) return;
      assert.equal(response.result.sessionId, "child-session");
      assert.equal(response.result.items[0]?.itemId, "msg-user-1");
    },
  );
});

test("session.transcript.read returns the current session page and not a fake empty page", async () => {
  await withFacade(
    {
      hello,
      snapshot,
      readTranscript: async () => PAGE,
    },
    undefined,
    undefined,
    async (facade) => {
      const response = await facade.query({ queryName: "session.transcript.read", input: {} });
      assert.equal(response.ok, true);
      if (!response.ok) return;
      assert.equal(response.result.sessionId, SESSION);
      assert.equal(response.result.items[0]?.itemId, "msg-user-1");
    },
  );
});

test("session.transcript.read returns a typed error when Runtime is unavailable", async () => {
  await withFacade(undefined, undefined, async (facade) => {
    const response = await facade.query({ queryName: "session.transcript.read", input: {} });
    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.equal(response.error.code, "UNAVAILABLE");
    assert.notEqual(response, { ok: true, queryName: "session.transcript.read", result: { items: [] } });
  });
});

test("session.transcript.readPage uses the Runtime-independent archive provider", async () => {
  const calls: Array<{ sessionId: string; limit?: number }> = [];
  const archive: ArchiveProvider = {
    readPage: async (input) => {
      calls.push({ sessionId: input.sessionId, ...(input.limit === undefined ? {} : { limit: input.limit }) });
      return {
        sessionId: SESSION,
        transcriptRevision: "revision-1",
        branchLeafId: "leaf-1",
        items: PAGE.items,
        headCursor: "head-1" as OpaqueCursor,
        hasMoreBefore: false,
      };
    },
  };
  await withFacade(undefined, undefined, async (facade) => {
    const response = await facade.query({
      queryName: "session.transcript.readPage",
      input: { sessionId: SESSION, limit: 20 },
    });
    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.equal(response.result.transcriptRevision, "revision-1");
    assert.equal(response.result.items[0]?.itemId, "msg-user-1");
  }, archive);
  assert.deepEqual(calls, [{ sessionId: SESSION, limit: 20 }]);
});

test("session.transcript.readPage forwards agentId to the archive provider", async () => {
  const calls: Array<{ sessionId: string; agentId?: string; limit?: number }> = [];
  const archive: ArchiveProvider = {
    readPage: async (input) => {
      calls.push({
        sessionId: input.sessionId,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return {
        sessionId: "child-echo" as SessionId,
        transcriptRevision: "revision-child",
        branchLeafId: "leaf-child",
        items: PAGE.items,
        headCursor: "head-child" as OpaqueCursor,
        hasMoreBefore: false,
      };
    },
  };
  await withFacade(undefined, undefined, async (facade) => {
    const response = await facade.query({
      queryName: "session.transcript.readPage",
      input: { sessionId: SESSION, agentId: "WorkerEcho" as AgentId, limit: 20 },
    });
    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.equal(response.result.sessionId, "child-echo");
  }, archive);
  assert.deepEqual(calls, [{ sessionId: SESSION, agentId: "WorkerEcho", limit: 20 }]);
});

test("session.agents.list returns persisted child agents from the archive provider", async () => {
  const archive: ArchiveProvider = {
    readPage: async () => {
      throw new Error("list must not read a page");
    },
    listPersistedAgents: async (sessionId) => {
      assert.equal(sessionId, SESSION);
      return [{
        agentId: "WorkerEcho" as AgentId,
        generation: 1 as StudioAgentSnapshot["generation"],
        kind: "sub",
        displayName: "WorkerEcho",
        status: "parked",
        updatedAt: T0,
        hasLiveSession: false,
        hasTranscript: true,
        unreadCount: 0,
        activeJobIds: [],
      }];
    },
  };
  await withFacade(undefined, undefined, async (facade) => {
    const response = await facade.query({
      queryName: "session.agents.list",
      input: { sessionId: SESSION },
    });
    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.equal(response.result.sessionId, SESSION);
    assert.equal(response.result.agents[0]?.agentId, "WorkerEcho");
    assert.equal(response.result.agents[0]?.status, "parked");
  }, archive);
});

test("session.transcript.read rejects a page whose identity does not match the current snapshot", async () => {
  await withFacade(
    {
      hello,
      snapshot,
      readTranscript: async () => ({ ...PAGE, sessionId: "session-other" as SessionId }),
    },
    undefined,
    undefined,
    async (facade) => {
      const response = await facade.query({ queryName: "session.transcript.read", input: {} });
      assert.equal(response.ok, false);
      if (response.ok) return;
      assert.equal(response.error.code, "CURSOR_STALE");
    },
  );
});

test("live conversation events map through the allow-list and keep Bridge occurredAt", async () => {
  const listeners: Array<(event: StudioConversationForward) => void> = [];
  await withFacade(
    {
      hello,
      snapshot,
      readTranscript: async () => PAGE,
      onConversationEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    undefined,
    undefined,
    async (facade) => {
      const received: ClientEvent[] = [];
      facade.subscribe({ scope: "runtime" }, (event) => received.push(event));
      listeners[0]!(startedEnvelope());
      const changed = received.find((event) => event.kind === "conversation.changed");
      assert.ok(changed);
      if (changed?.kind !== "conversation.changed") return;
      assert.equal(changed.occurredAt, "2026-08-15T13:00:01.000Z");
      assert.equal(changed.eventSeq, 7);
      assert.equal(changed.sessionId, SESSION);
      assert.equal(changed.update.kind, "conversation.message.started");
    },
  );
});

test("forwards a child-session conversation event to runtime subscribers", async () => {
  const listeners: Array<(event: StudioConversationForward) => void> = [];
  await withFacade(
    {
      hello,
      snapshot,
      onConversationEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    undefined,
    undefined,
    async (facade) => {
      const received: ClientEvent[] = [];
      facade.subscribe({ scope: "runtime" }, (event) => received.push(event));
      listeners[0]!(startedEnvelope("child-session"));
      const changed = received.find((event) => event.kind === "conversation.changed");
      assert.ok(changed);
      if (changed?.kind !== "conversation.changed") return;
      assert.equal(changed.sessionId, "child-session");
      assert.equal(changed.update.sessionId, "child-session");
    },
  );
});

test("forged conversation.* kinds are not blind-cast; mapping failure emits resync", async () => {
  const listeners: Array<(event: StudioConversationForward) => void> = [];
  await withFacade(
    {
      hello,
      snapshot,
      onConversationEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    undefined,
    async (facade) => {
      const received: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => received.push(event));
      listeners[0]!({
        envelope: {
          type: "studio.event",
          runtimeEpoch: 1 as RuntimeEpoch,
          eventSeq: 8 as never,
          stateVersion: 4 as StateVersion,
          occurredAt: T0,
          event: { kind: "conversation.forged", sessionId: SESSION } as never,
        },
      });
      assert.equal(
        received.some((event) => event.kind === "conversation.changed"),
        false,
      );
      const resync = received.find((event) => event.kind === "resync.required");
      assert.ok(resync);
      if (resync?.kind === "resync.required") {
        assert.equal(resync.reason, "conversation mapping failed; re-read open transcripts");
      }
    },
  );
});

test("runtime loss emits runtime.changed before dropping a late conversation event", async () => {
  let currentHello: HostRuntimeHelloView | undefined = hello();
  const listeners: Array<(event: StudioConversationForward) => void> = [];
  await withFacade(
    {
      hello: () => currentHello,
      snapshot: () => (currentHello === undefined ? undefined : snapshot()),
      onConversationEvent: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    undefined,
    async (facade) => {
      const received: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => received.push(event));
      listeners[0]!(startedEnvelope());
      assert.equal(received.filter((event) => event.kind === "conversation.changed").length, 1);
      currentHello = undefined;
      received.length = 0;
      listeners[0]!(startedEnvelope());
      assert.equal(received[0]?.kind, "runtime.changed");
      assert.equal(
        received.some((event) => event.kind === "conversation.changed"),
        false,
      );
    },
  );
});

test("reload of a new facade does not replay old conversation deltas", async () => {
  const listeners = new Set<(event: StudioConversationForward) => void>();
  const runtime: HostRuntimeAccess = {
    hello,
    snapshot,
    onConversationEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  await withFacade(runtime, undefined, async (first) => {
    const firstEvents: ClientEvent[] = [];
    first.subscribe({ scope: "all" }, (event) => firstEvents.push(event));
    for (const listener of listeners) listener(startedEnvelope());
    assert.equal(firstEvents.filter((event) => event.kind === "conversation.changed").length, 1);
    await first.close();
  });
  await withFacade(runtime, undefined, async (second) => {
    const secondEvents: ClientEvent[] = [];
    second.subscribe({ scope: "all" }, (event) => secondEvents.push(event));
    assert.equal(secondEvents.length, 0);
  });
});

test("session.drop forwards the client requestId to the semantic service", async () => {
  const seen: string[] = [];
  const commands: HostSemanticCommandService = {
    resume: async () => snapshot(),
    drop: async (input) => {
      seen.push(input.requestId);
      return snapshot();
    },
    respond: async () => snapshot(),
  };
  await withFacade({ hello, snapshot }, commands, async (facade) => {
    const requestId = "gui-drop-1" as CommandRequestId;
    await facade.command({
      commandName: "session.drop",
      requestId,
      idempotencyKey: "idem-drop-1" as IdempotencyKey,
      input: { threadId: "thread-1" as never },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, [requestId]);
  });
});

test("invoke forwards the client requestId so ledger rows can align", async () => {
  const calls: Array<{ operation: StudioOperation; requestId?: string }> = [];
  const commands: HostSemanticCommandService = {
    resume: async () => snapshot(),
    drop: async () => snapshot(),
    respond: async () => snapshot(),
    invoke: async (operation, requestId) => {
      calls.push(requestId === undefined ? { operation } : { operation, requestId });
      return snapshot();
    },
  };
  await withFacade({ hello, snapshot }, commands, async (facade) => {
    const requestId = "gui-req-align" as CommandRequestId;
    const accepted = await facade.command({
      commandName: "core.prompt",
      input: { text: "hi" },
      idempotencyKey: "idem-align" as IdempotencyKey,
      requestId,
    });
    assert.equal(accepted.status, "accepted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.requestId, requestId);
    assert.equal(calls[0]?.operation.kind, "core.prompt");
  });
});

test("operator.invoke outcome envelope reaches the completed receipt verbatim", async () => {
  const outcome = {
    snapshot: snapshot(),
    output: ["Session exported to: omp-session-x.html"],
    result: { consumed: true },
  };
  const commands: HostSemanticCommandService = {
    resume: async () => snapshot(),
    drop: async () => snapshot(),
    respond: async () => snapshot(),
    invoke: async (operation) => {
      assert.equal(operation.kind, "operator.invoke");
      return operation.kind === "operator.invoke" ? outcome : snapshot();
    },
  };
  await withFacade({ hello, snapshot }, commands, async (facade) => {
    const events: ClientEvent[] = [];
    facade.subscribe({ scope: "all" }, (event) => events.push(event));
    await facade.command({
      commandName: "operator.invoke",
      input: { commandId: "builtin.export", arguments: undefined },
      idempotencyKey: "idem-invoke-outcome" as IdempotencyKey,
      requestId: "gui-invoke-outcome" as CommandRequestId,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const receipt = events.find((event) => event.kind === "command.receipt");
    assert.equal(receipt?.kind, "command.receipt");
    if (receipt?.kind === "command.receipt" && receipt.receipt.status === "completed") {
      assert.deepEqual(receipt.receipt.result, outcome);
    } else {
      assert.fail("operator.invoke receipt did not complete with the outcome envelope");
    }
  });
});

test("HostEventBus isolates a throwing sibling listener", () => {
  const bus = new HostEventBus(1 as AuthorityEpoch, () => T0, () => ({
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 1 as StateVersion,
  }));
  const second: string[] = [];
  bus.subscribe({ scope: "all" }, () => {
    throw new Error("boom");
  });
  bus.subscribe({ scope: "all" }, (event) => {
    second.push(event.kind);
  });
  bus.emit({ kind: "diagnostics.changed" });
  assert.deepEqual(second, ["diagnostics.changed"]);
});

test("bootstrap may carry a messagesCursor hint and never a transcript page", async () => {
  await withFacade(
    {
      hello,
      snapshot,
      messagesCursor: () => "opaque-head" as OpaqueCursor,
    },
    undefined,
    async (facade) => {
      const bootstrap = await facade.bootstrap();
      assert.equal(bootstrap.messagesCursor, "opaque-head");
      assert.equal("items" in bootstrap, false);
      assert.equal(JSON.stringify(bootstrap).includes("Read package.json"), false);
    },
  );
});

test("publication snapshot changes emit a full snapshot event, including a new epoch with a smaller version", async () => {
  let publish: (publication: RuntimePublication) => void = () => {};
  const live = { current: snapshot() };
  await withFacade(
    {
      hello,
      snapshot: () => live.current,
      onPublication: (listener) => {
        publish = listener;
        return () => {
          publish = () => {};
        };
      },
    },
    undefined,
    async (facade) => {
      const events: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => events.push(event));
      publish({
        commitSeq: 1,
        publishedAt: T0,
        snapshot: snapshot(),
        terminalOutcomes: [],
      });
      assert.equal(events[0]?.kind, "snapshot");
      if (events[0]?.kind === "snapshot") {
        assert.equal(events[0].snapshot.stateVersion, 4);
        assert.equal(events[0].snapshot.isStreaming, false);
      }
      live.current = { ...snapshot(), runtimeEpoch: 2 as RuntimeEpoch, stateVersion: 1 as StateVersion };
      publish({
        commitSeq: 2,
        publishedAt: T0,
        snapshot: live.current,
        terminalOutcomes: [],
      });
      const second = events.filter((event) => event.kind === "snapshot").at(-1);
      assert.equal(second?.kind, "snapshot");
      if (second?.kind === "snapshot") {
        assert.equal(second.snapshot.runtimeEpoch, 2);
        assert.equal(second.snapshot.stateVersion, 1);
      }
    },
  );
});

test("re-selecting an older resident Runtime publishes runtime.changed before its snapshot", async () => {
  let publish: (publication: RuntimePublication) => void = () => {};
  let liveHello: HostRuntimeHelloView = {
    runtimeId: "rt-b",
    runtimeEpoch: 1,
    classification: "managed",
  };
  let liveSnapshot = {
    ...snapshot("session-b" as SessionId),
    runtimeId: "rt-b" as RuntimeId,
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 8 as StateVersion,
  };
  await withFacade(
    {
      hello: () => liveHello,
      snapshot: () => liveSnapshot,
      onPublication: (listener) => {
        publish = listener;
        return () => {
          publish = () => {};
        };
      },
    },
    undefined,
    async (facade) => {
      const events: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => events.push(event));
      publish({ commitSeq: 1, publishedAt: T0, snapshot: liveSnapshot, terminalOutcomes: [] });
      assert.deepEqual(events.map((event) => event.kind), ["snapshot"]);
      events.length = 0;
      liveHello = { runtimeId: "rt-a", runtimeEpoch: 1, classification: "managed" };
      liveSnapshot = {
        ...snapshot(SESSION),
        runtimeId: "rt-a" as RuntimeId,
        runtimeEpoch: 1 as RuntimeEpoch,
        stateVersion: 2 as StateVersion,
      };
      publish({ commitSeq: 2, publishedAt: T0, snapshot: liveSnapshot, terminalOutcomes: [] });
      assert.deepEqual(events.map((event) => event.kind), ["runtime.changed", "snapshot"]);
      assert.equal(events[0]?.runtimeEpoch, 1);
      const selected = events[1];
      assert.equal(selected?.kind, "snapshot");
      if (selected?.kind === "snapshot") {
        assert.equal(selected.snapshot.runtimeId, "rt-a");
        assert.equal(selected.snapshot.stateVersion, 2);
      }
    },
  );
});

test("session telemetry forwards through the facade and preserves the current session identity", async () => {
  let publishTelemetry: (event: StudioTelemetryForward) => void = () => {};
  await withFacade(
    {
      hello,
      snapshot: () => snapshot(),
      onTelemetryEvent: (listener) => {
        publishTelemetry = listener;
        return () => { publishTelemetry = () => {}; };
      },
    },
    undefined,
    async (facade) => {
      const events: ClientEvent[] = [];
      facade.subscribe({ scope: "all" }, (event) => events.push(event));
      const telemetry = {
        sessionId: SESSION,
        capturedAt: T0,
        tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 1, cacheWrite: 0, total: 12, cost: 0.1 },
        context: {
          contextWindow: 128000,
          usedTokens: 100,
          percent: 0.078125,
          anchored: true,
          systemPromptTokens: 10,
          systemContextTokens: 20,
          systemToolsTokens: 30,
          skillsTokens: 10,
          messagesTokens: 30,
        },
      };
      publishTelemetry({
        envelope: {
          type: "studio.event",
          runtimeEpoch: 1 as RuntimeEpoch,
          eventSeq: 8 as never,
          stateVersion: 4 as StateVersion,
          occurredAt: T0,
          event: { kind: "session.telemetry.changed", sessionId: SESSION, telemetry },
        },
      });
      const last = events.at(-1);
      assert.equal(last?.kind, "telemetry.changed");
      if (last?.kind === "telemetry.changed") assert.equal(last.telemetry.context?.messagesTokens, 30);
      publishTelemetry({
        envelope: {
          type: "studio.event",
          runtimeEpoch: 1 as RuntimeEpoch,
          eventSeq: 9 as never,
          stateVersion: 4 as StateVersion,
          occurredAt: T0,
          event: { kind: "session.telemetry.changed", sessionId: "other-session" as SessionId, telemetry: { ...telemetry, sessionId: "other-session" as SessionId } },
        },
      });
      assert.equal(events.filter((event) => event.kind === "telemetry.changed").length, 1);
    },
  );
});

test("session.archive and session.unarchive dispatch to the semantic service without a Runtime snapshot", async () => {
  const calls: string[] = [];
  const commands: HostSemanticCommandService = {
    resume: async () => snapshot(),
    drop: async () => snapshot(),
    respond: async () => snapshot(),
    archive: async ({ threadId }) => {
      calls.push(`archive:${threadId}`);
      return { applied: true, runtimeEffect: "immediate", message: "archived" };
    },
    unarchive: async ({ threadId }) => {
      calls.push(`unarchive:${threadId}`);
      return { applied: true, runtimeEffect: "immediate", message: "restored" };
    },
  };
  await withFacade(undefined, commands, async (facade) => {
    const acceptedArchive = await facade.command({
      commandName: "session.archive",
      requestId: "gui-archive-1" as CommandRequestId,
      idempotencyKey: "idem-archive-1" as IdempotencyKey,
      input: { threadId: "thread-1" as never },
    });
    assert.equal(acceptedArchive.status, "accepted");
    const acceptedUnarchive = await facade.command({
      commandName: "session.unarchive",
      requestId: "gui-unarchive-1" as CommandRequestId,
      idempotencyKey: "idem-unarchive-1" as IdempotencyKey,
      input: { threadId: "thread-1" as never },
    });
    assert.equal(acceptedUnarchive.status, "accepted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, ["archive:thread-1", "unarchive:thread-1"]);
  });
});

test("session.archive fails closed when the semantic service has no archive support", async () => {
  const commands: HostSemanticCommandService = {
    resume: async () => snapshot(),
    drop: async () => snapshot(),
    respond: async () => snapshot(),
  };
  await withFacade(undefined, commands, async (facade) => {
    await assert.rejects(
      () =>
        facade.command({
          commandName: "session.archive",
          requestId: "gui-archive-2" as CommandRequestId,
          idempotencyKey: "idem-archive-2" as IdempotencyKey,
          input: { threadId: "thread-1" as never },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "CAPABILITY_UNAVAILABLE");
        assert.match(String((error as { message?: unknown }).message), /session\.archive is not available/u);
        return true;
      },
    );
  });
});

test("history.list filters by status host-side before pagination", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-facade-history-"));
  try {
    const backend = new HostBackend({ stateDirectory: profile });
    await backend.initialize();
    const facade = new StudioHostClientFacade({
      authority: { authorityId: "auth-history" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
      platform: "win32",
      arch: "x64",
      backend,
      capabilityManifest: () => undefined,
      commandManifest: () => undefined,
      catalog: {
        list: async () => [
          { sessionId: "s-active", modifiedAt: "2026-08-15T10:00:00.000Z", messageCount: 0, status: "active" as const },
          { sessionId: "s-archived", modifiedAt: "2026-08-15T11:00:00.000Z", messageCount: 0, status: "archived" as const },
          { sessionId: "s-closed", modifiedAt: "2026-08-15T09:00:00.000Z", messageCount: 0, status: "closed" as const },
        ],
      },
      diagnostics: { now: () => T0, newEntryId: () => "diag-history" as never },
      install: async () => {
        throw new Error("runtime.install is not wired in history tests");
      },
    });
    try {
      const all = await facade.query({ queryName: "history.list", input: {} });
      assert.equal(all.ok, true);
      if (all.ok) {
        assert.deepEqual(
          all.result.entries.map((entry) => entry.status).sort(),
          ["active", "archived", "closed"],
        );
      }
      const archivedOnly = await facade.query({ queryName: "history.list", input: { status: "archived" } });
      assert.equal(archivedOnly.ok, true);
      if (archivedOnly.ok) {
        assert.deepEqual(archivedOnly.result.entries.map((entry) => entry.sessionId), ["s-archived"]);
        assert.equal(archivedOnly.result.total, 1);
      }
      const activeOnly = await facade.query({ queryName: "history.list", input: { status: "active" } });
      assert.equal(activeOnly.ok, true);
      if (activeOnly.ok) {
        assert.deepEqual(activeOnly.result.entries.map((entry) => entry.sessionId), ["s-active"]);
      }
      const bogus = await facade.query({ queryName: "history.list", input: { status: "bogus" as never } });
      assert.equal(bogus.ok, false);
      if (!bogus.ok) assert.equal(bogus.error.code, "INVALID_ARGUMENT");
    } finally {
      await facade.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
