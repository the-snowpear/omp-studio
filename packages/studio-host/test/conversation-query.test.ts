import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FrameDecoder,
  encodeFrame,
  parseFoundationStudioRequest,
  parseStudioHelloRequest,
  SESSION_TRANSCRIPT_READ_KIND,
  type StudioEventEnvelope,
  type StudioHelloResponse,
  type StudioSnapshotResponse,
  type OpaqueCursor,
  type RequestId,
  type RuntimeEpoch,
  type RuntimeInstanceId,
  type StateVersion,
  type StudioRequest,
  type AgentId,
} from "@omp-studio/studio-protocol";
import {
  CommandArbiter,
  CommandLedger,
  RuntimeProjection,
  RuntimePublicationStore,
  StudioBridgeClient,
  StudioHostError,
  StudioRuntimeSessionController,
  classifyOperation,
  createChallengeProof,
} from "../src/index.js";

const epoch = 1 as RuntimeEpoch;

const PAGE = {
  runtimeEpoch: 1,
  sessionId: "session-1",
  branchLeafId: "leaf-1",
  items: [
    {
      kind: "message",
      itemId: "msg-user-1",
      parentId: null,
      createdAt: "2026-08-15T00:00:01.000Z",
      role: "user",
      content: [{ type: "text", text: "Read package.json" }],
    },
  ],
  olderCursor: "opaque-older-cursor",
  headCursor: "opaque-head-cursor",
  hasMoreBefore: true,
};

const OLDER_PAGE = {
  runtimeEpoch: 1,
  sessionId: "session-1",
  branchLeafId: "leaf-1",
  items: [
    {
      kind: "message",
      itemId: "msg-older-1",
      parentId: null,
      createdAt: "2026-08-15T00:00:00.000Z",
      role: "user",
      content: [{ type: "text", text: "Earlier turn" }],
    },
  ],
  headCursor: "opaque-head-cursor",
  hasMoreBefore: false,
};

const STARTED = {
  kind: "conversation.message.started",
  sessionId: "session-1",
  turnId: "turn-1",
  messageId: "msg-1",
  role: "assistant",
  createdAt: "2026-08-15T12:00:00.000Z",
};

function helloResponse(
  hello: ReturnType<typeof parseStudioHelloRequest>,
  token: string,
  runtimeInstanceId = "runtime-instance-1" as RuntimeInstanceId,
): StudioHelloResponse {
  return {
    type: "studio.hello.result",
    requestId: hello.requestId,
    selectedProtocolVersion: 1,
    runtimeVersion: "17.2.12-studio.3",
    upstreamVersion: "17.2.12",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    runtimeInstanceId,
    runtimeEpoch: epoch,
    capabilityManifest: {
      profile: "limited",
      generatedAt: "2026-08-11T00:00:00.000Z",
      hash: "sha256:empty-capabilities",
      capabilities: [],
    },
    commandManifestHash: "sha256:empty-commands",
    stateVersion: 0 as StateVersion,
    challengeProof: createChallengeProof(token, hello.challenge, runtimeInstanceId),
  };
}

function snapshotResponse(requestId: string, hello: StudioHelloResponse, sessionId = "session-1"): StudioSnapshotResponse {
  return {
    type: "studio.snapshot",
    requestId: requestId as StudioSnapshotResponse["requestId"],
    snapshot: {
      runtimeId: hello.runtimeInstanceId as unknown as StudioSnapshotResponse["snapshot"]["runtimeId"],
      runtimeEpoch: hello.runtimeEpoch,
      stateVersion: hello.stateVersion,
      sessionId: sessionId as StudioSnapshotResponse["snapshot"]["sessionId"],
      isStreaming: false,
      isCompacting: false,
      activeMode: "normal", approvalMode: "yolo",
      pendingMessages: 0,
      activeCommandIds: [],
      agentsRevision: 0,
      jobsRevision: 0,
      agents: [],
      jobs: [],
    },
    commandManifestHash: hello.commandManifestHash,
    capabilityHash: hello.capabilityManifest.hash,
    lastEventSeq: 0 as StudioSnapshotResponse["lastEventSeq"],
    terminalReceipts: [],
  };
}

function conversationEvent(hello: StudioHelloResponse, eventSeq: number, event: unknown): Buffer {
  return encodeFrame(`event:${eventSeq}`, hello.runtimeEpoch, {
    type: "studio.event",
    runtimeEpoch: hello.runtimeEpoch,
    eventSeq,
    stateVersion: hello.stateVersion,
    occurredAt: "2026-08-15T12:00:00.000Z",
    event,
  });
}

async function listenForHello(
  token: string,
  hooks: {
    afterSnapshot?: (response: StudioSnapshotResponse, hello: StudioHelloResponse) => Buffer[];
    snapshot?: (requestId: string, hello: StudioHelloResponse) => StudioSnapshotResponse;
    onRequest?: (request: StudioRequest, socket: Socket, hello: StudioHelloResponse) => void;
  } = {},
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omp-studio-conversation-${randomUUID()}`
      : join(await mkdtemp(join(tmpdir(), "omp-studio-conversation-")), "bridge.sock");
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const decoder = new FrameDecoder();
    let negotiated: StudioHelloResponse | undefined;
    socket.on("data", (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if ((frame.body as { type?: unknown }).type === "studio.hello") {
            const hello = parseStudioHelloRequest(frame.body);
            negotiated = helloResponse(hello, token);
            socket.write(encodeFrame(`hello-result:${hello.requestId}`, negotiated.runtimeEpoch, negotiated));
            continue;
          }
          const request = parseFoundationStudioRequest(frame.body);
          if (negotiated === undefined) throw new Error("Not ready");
          if (request.operation.kind === "runtime.snapshot") {
            const response = hooks.snapshot?.(request.requestId, negotiated) ?? snapshotResponse(request.requestId, negotiated);
            socket.write(
              Buffer.concat([
                encodeFrame(`snapshot-result:${request.requestId}`, response.snapshot.runtimeEpoch, response),
                ...(hooks.afterSnapshot?.(response, negotiated) ?? []),
              ]),
            );
            continue;
          }
          if (hooks.onRequest === undefined) throw new Error("Unsupported request");
          hooks.onRequest(request, socket, negotiated);
        }
      } catch {
        socket.destroy();
      }
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  return {
    endpoint,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function completedReceipt(request: StudioRequest, hello: StudioHelloResponse, result: unknown): Buffer {
  return encodeFrame(`receipt:${request.requestId}`, hello.runtimeEpoch, {
    type: "studio.receipt",
    requestId: request.requestId,
    runtimeEpoch: hello.runtimeEpoch,
    stateVersion: hello.stateVersion,
    status: "completed",
    result,
  });
}

test("session.transcript.read is read-concurrent and can run while streaming", async () => {
  assert.equal(classifyOperation({ kind: SESSION_TRANSCRIPT_READ_KIND }), "read-concurrent");
  assert.equal(classifyOperation({ kind: "agent.conversation.read", agentId: "agent-1" as AgentId }), "read-concurrent");
  const streaming = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: true,
    isCompacting: false,
  }));
  await streaming.run(
    {
      type: "studio.request",
      requestId: "req-transcript" as RequestId,
      runtimeEpoch: epoch,
      operation: { kind: SESSION_TRANSCRIPT_READ_KIND },
    },
    () => undefined,
  );
});

test("readTranscript maps the latest page and an older page without ledger entries", async () => {
  const token = "bridge-token-transcript-pages";
  const bridge = await listenForHello(token, {
    onRequest(request, socket, hello) {
      assert.equal(request.operation.kind, SESSION_TRANSCRIPT_READ_KIND);
      const result =
        request.operation.kind === SESSION_TRANSCRIPT_READ_KIND && request.operation.cursor !== undefined
          ? OLDER_PAGE
          : PAGE;
      socket.write(completedReceipt(request, hello, result));
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const ledger = new CommandLedger(() => "2026-08-15T00:00:00.000Z");
  const controller = new StudioRuntimeSessionController(client, ledger);
  try {
    await client.connect();
    await controller.refresh();
    const latest = await controller.readTranscript();
    assert.equal(latest.sessionId, "session-1");
    assert.equal(latest.items[0]?.itemId, "msg-user-1");
    assert.equal(latest.hasMoreBefore, true);
    const older = await controller.readTranscript({ cursor: "opaque-older-cursor" as never, limit: 1 });
    assert.equal(older.items[0]?.itemId, "msg-older-1");
    assert.equal(older.hasMoreBefore, false);
    assert.equal(ledger.snapshot().length, 0);
    assert.equal(controller.publication()?.terminalOutcomes.length, 0);
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("readTranscript maps CURSOR_STALE and INVALID_ARGUMENT from Runtime receipts", async () => {
  const token = "bridge-token-transcript-errors";
  const bridge = await listenForHello(token, {
    onRequest(request, socket, hello) {
      const stale = request.operation.kind === SESSION_TRANSCRIPT_READ_KIND && request.operation.cursor === "stale-cursor";
      socket.write(
        encodeFrame(`receipt:${request.requestId}`, hello.runtimeEpoch, {
          type: "studio.receipt",
          requestId: request.requestId,
          runtimeEpoch: hello.runtimeEpoch,
          stateVersion: hello.stateVersion,
          status: "rejected",
          error: stale
            ? { code: "CURSOR_STALE", message: "cursor belongs to another branch", retryable: false }
            : { code: "INVALID_ARGUMENT", message: "tampered cursor", retryable: false },
        }),
      );
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const controller = new StudioRuntimeSessionController(client, new CommandLedger());
  try {
    await client.connect();
    await controller.refresh();
    await assert.rejects(
      () => controller.readTranscript({ cursor: "stale-cursor" as never }),
      (error: unknown) => error instanceof StudioHostError && error.code === "CURSOR_STALE",
    );
    await assert.rejects(
      () => controller.readTranscript({ cursor: "tampered" as never }),
      (error: unknown) => error instanceof StudioHostError && error.code === "INVALID_ARGUMENT",
    );
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("readTranscript rejects a page whose session identity does not match the current snapshot", async () => {
  const token = "bridge-token-transcript-identity";
  const bridge = await listenForHello(token, {
    onRequest(request, socket, hello) {
      socket.write(completedReceipt(request, hello, { ...PAGE, sessionId: "session-other" }));
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const controller = new StudioRuntimeSessionController(client, new CommandLedger());
  try {
    await client.connect();
    await controller.refresh();
    await assert.rejects(
      () => controller.readTranscript(),
      (error: unknown) => error instanceof StudioHostError && error.code === "CURSOR_STALE",
    );
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("readAgentConversation rejects a page whose session identity matches the parent snapshot", async () => {
  const token = "bridge-token-agent-conversation-identity";
  const bridge = await listenForHello(token, {
    onRequest(request, socket, hello) {
      assert.equal(request.operation.kind, "agent.conversation.read");
      socket.write(completedReceipt(request, hello, PAGE));
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const controller = new StudioRuntimeSessionController(client, new CommandLedger());
  try {
    await client.connect();
    await controller.refresh();
    await assert.rejects(
      () => controller.readAgentConversation({ agentId: "WorkerEcho" }),
      (error: unknown) => error instanceof StudioHostError && error.code === "CURSOR_STALE",
    );
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("readAgentConversation accepts a child session identity", async () => {
  const token = "bridge-token-agent-conversation-child";
  const bridge = await listenForHello(token, {
    onRequest(request, socket, hello) {
      assert.equal(request.operation.kind, "agent.conversation.read");
      socket.write(completedReceipt(request, hello, { ...PAGE, sessionId: "child-echo" }));
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const controller = new StudioRuntimeSessionController(client, new CommandLedger());
  try {
    await client.connect();
    await controller.refresh();
    const page = await controller.readAgentConversation({ agentId: "WorkerEcho" });
    assert.equal(page.sessionId, "child-echo");
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("onConversationEvent delivers the allow-listed sequence and isolates a throwing subscriber", async () => {
  const token = "bridge-token-conversation-live";
  const delta = {
    kind: "conversation.message.delta",
    sessionId: "session-1",
    turnId: "turn-1",
    messageId: "msg-1",
    blockId: "block-1",
    blockType: "text",
    delta: "Hello",
  };
  const completed = {
    kind: "conversation.message.completed",
    sessionId: "session-1",
    turnId: "turn-1",
    messageId: "msg-1",
    item: {
      kind: "message",
      itemId: "msg-1",
      parentId: null,
      createdAt: "2026-08-15T12:00:00.000Z",
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    },
  };
  const bridge = await listenForHello(token, {
    afterSnapshot(_response, hello) {
      return [
        conversationEvent(hello, 1, STARTED),
        conversationEvent(hello, 2, delta),
        conversationEvent(hello, 3, completed),
      ];
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const controller = new StudioRuntimeSessionController(
    client,
    new CommandLedger(),
    new RuntimePublicationStore(() => "2026-08-15T12:00:02.000Z"),
  );
  const seen: string[] = [];
  const second: string[] = [];
  controller.onConversationEvent(() => {
    throw new Error("subscriber boom");
  });
  controller.onConversationEvent((event) => {
    seen.push(event.envelope.event.kind);
  });
  controller.onConversationEvent((event) => {
    second.push(event.envelope.event.kind);
  });
  try {
    await client.connect();
    await controller.refresh();
    assert.deepEqual(seen, [
      "conversation.message.started",
      "conversation.message.delta",
      "conversation.message.completed",
    ]);
    assert.deepEqual(second, seen);
    const publication = controller.publication();
    assert.ok(publication);
    assert.equal("conversationEvents" in publication, false);
    assert.equal(JSON.stringify(publication).includes("Hello"), false);
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("reload does not replay old conversation deltas from publication", async () => {
  const token = "bridge-token-conversation-noreplay";
  const bridge = await listenForHello(token, {
    afterSnapshot(_response, hello) {
      return [conversationEvent(hello, 1, STARTED)];
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const ledger = new CommandLedger();
  const first = new StudioRuntimeSessionController(client, ledger);
  const firstSeen: StudioEventEnvelope[] = [];
  first.onConversationEvent((event) => {
    firstSeen.push(event.envelope);
  });
  try {
    await client.connect();
    await first.refresh();
    assert.equal(firstSeen.length, 1);
    first.dispose();
    const replayed: unknown[] = [];
    const second = new StudioRuntimeSessionController(client, ledger);
    second.onConversationEvent((event) => {
      replayed.push(event.envelope.event);
    });
    assert.equal(replayed.length, 0);
    const publication = second.publication();
    assert.equal(publication, undefined);
    second.dispose();
  } finally {
    client.close();
    await bridge.close();
  }
});

test("conversation eventSeq gap emits resync and does not invent missing deltas", async () => {
  const token = "bridge-token-conversation-gap";
  const bridge = await listenForHello(token, {
    afterSnapshot(_response, hello) {
      return [conversationEvent(hello, 1, STARTED), conversationEvent(hello, 3, STARTED)];
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const controller = new StudioRuntimeSessionController(client, new CommandLedger());
  const kinds: string[] = [];
  const resync: string[] = [];
  controller.onConversationEvent((event) => {
    kinds.push(event.envelope.event.kind);
  });
  controller.onConversationResync((reason) => {
    resync.push(reason);
  });
  try {
    await client.connect();
    await controller.refresh();
    assert.deepEqual(kinds, ["conversation.message.started"]);
    assert.equal(resync.length, 1);
    assert.match(resync[0] ?? "", /gap/);
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("runtimeLost emits conversation resync without buffering deltas", async () => {
  const token = "bridge-token-conversation-lost";
  const bridge = await listenForHello(token);
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const controller = new StudioRuntimeSessionController(client, new CommandLedger());
  const resync: string[] = [];
  controller.onConversationResync((reason) => {
    resync.push(reason);
  });
  try {
    await client.connect();
    await controller.refresh();
    const snapshot = client.projectionSnapshot();
    assert.ok(snapshot);
    controller.runtimeLost(snapshot.runtimeId, snapshot.runtimeEpoch);
    assert.equal(resync.length, 1);
    assert.match(resync[0] ?? "", /runtime lost/);
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("RuntimeProjection retains snapshot messagesCursor as a hint without bodies", () => {
  const hello: StudioHelloResponse = {
    type: "studio.hello.result",
    requestId: "hello-1" as RequestId,
    selectedProtocolVersion: 1,
    runtimeVersion: "1.0.0",
    upstreamVersion: "1.0.0",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    runtimeInstanceId: "runtime-instance-1" as RuntimeInstanceId,
    runtimeEpoch: epoch,
    capabilityManifest: {
      profile: "limited",
      generatedAt: "2026-08-11T00:00:00.000Z",
      hash: "sha256:empty-capabilities",
      capabilities: [],
    },
    commandManifestHash: "sha256:empty-commands",
    stateVersion: 0 as StateVersion,
    challengeProof: "proof",
  };
  const projection = new RuntimeProjection();
  projection.beginConnection(hello);
  assert.equal(projection.messagesCursor(), undefined);
  projection.applySnapshot({
    type: "studio.snapshot",
    requestId: "snap-1" as RequestId,
    snapshot: {
      runtimeId: hello.runtimeInstanceId as unknown as StudioSnapshotResponse["snapshot"]["runtimeId"],
      runtimeEpoch: hello.runtimeEpoch,
      stateVersion: hello.stateVersion,
      sessionId: "session-1" as StudioSnapshotResponse["snapshot"]["sessionId"],
      isStreaming: false,
      isCompacting: false,
      activeMode: "normal", approvalMode: "yolo",
      pendingMessages: 0,
      activeCommandIds: [],
      agentsRevision: 0,
      jobsRevision: 0,
      agents: [],
      jobs: [],
    },
    commandManifestHash: hello.commandManifestHash,
    capabilityHash: hello.capabilityManifest.hash,
    lastEventSeq: 0 as StudioSnapshotResponse["lastEventSeq"],
    terminalReceipts: [],
    messagesCursor: "opaque-head-hint" as OpaqueCursor,
  });
  assert.equal(projection.messagesCursor(), "opaque-head-hint");
  assert.equal(JSON.stringify(projection.snapshot() ?? {}).includes("opaque-head-hint"), false);
});

test("controller.messagesCursor reads the snapshot hint after refresh", async () => {
  const token = "bridge-token-messages-cursor";
  const bridge = await listenForHello(token, {
    snapshot(requestId, hello) {
      return {
        ...snapshotResponse(requestId, hello),
        messagesCursor: "opaque-head-from-runtime" as OpaqueCursor,
      };
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const controller = new StudioRuntimeSessionController(client, new CommandLedger());
  try {
    await client.connect();
    await controller.refresh();
    assert.equal(controller.messagesCursor(), "opaque-head-from-runtime");
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("conversation events keep the prior snapshot until a following state.changed arrives", () => {
  const hello: StudioHelloResponse = {
    type: "studio.hello.result",
    requestId: "hello-1" as RequestId,
    selectedProtocolVersion: 1,
    runtimeVersion: "1.0.0",
    upstreamVersion: "1.0.0",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    runtimeInstanceId: "runtime-instance-1" as RuntimeInstanceId,
    runtimeEpoch: epoch,
    capabilityManifest: {
      profile: "limited",
      generatedAt: "2026-08-11T00:00:00.000Z",
      hash: "sha256:empty-capabilities",
      capabilities: [],
    },
    commandManifestHash: "sha256:empty-commands",
    stateVersion: 0 as StateVersion,
    challengeProof: "proof",
  };
  const projection = new RuntimeProjection();
  projection.beginConnection(hello);
  const applied = projection.applySnapshot({
    type: "studio.snapshot",
    requestId: "snap-1" as RequestId,
    snapshot: {
      runtimeId: hello.runtimeInstanceId as unknown as StudioSnapshotResponse["snapshot"]["runtimeId"],
      runtimeEpoch: hello.runtimeEpoch,
      stateVersion: hello.stateVersion,
      sessionId: "session-1" as StudioSnapshotResponse["snapshot"]["sessionId"],
      isStreaming: true,
      isCompacting: false,
      activeMode: "normal", approvalMode: "yolo",
      pendingMessages: 1,
      activeCommandIds: [],
      agentsRevision: 0,
      jobsRevision: 0,
      agents: [],
      jobs: [],
    },
    commandManifestHash: hello.commandManifestHash,
    capabilityHash: hello.capabilityManifest.hash,
    lastEventSeq: 0 as StudioSnapshotResponse["lastEventSeq"],
    terminalReceipts: [],
  });
  assert.equal(applied.isStreaming, true);
  assert.equal(
    projection.applyEvent({
      type: "studio.event",
      runtimeEpoch: hello.runtimeEpoch,
      eventSeq: 1 as StudioSnapshotResponse["lastEventSeq"],
      stateVersion: 1 as StateVersion,
      occurredAt: "2026-08-15T13:00:01.000Z",
      event: { kind: "conversation.turn.completed", sessionId: applied.sessionId, turnId: "turn-1" },
    }),
    "applied",
  );
  assert.equal(projection.snapshot()?.stateVersion, 0);
  assert.equal(projection.snapshot()?.isStreaming, true);
  assert.equal(
    projection.applyEvent({
      type: "studio.event",
      runtimeEpoch: hello.runtimeEpoch,
      eventSeq: 2 as StudioSnapshotResponse["lastEventSeq"],
      stateVersion: 1 as StateVersion,
      occurredAt: "2026-08-15T13:00:02.000Z",
      event: {
        kind: "state.changed",
        snapshot: { ...applied, stateVersion: 1 as StateVersion, isStreaming: false, pendingMessages: 0 },
      },
    }),
    "applied",
  );
  assert.equal(projection.snapshot()?.stateVersion, 1);
  assert.equal(projection.snapshot()?.isStreaming, false);
  assert.equal(projection.snapshot()?.pendingMessages, 0);
});
