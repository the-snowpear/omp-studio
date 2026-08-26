import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FrameDecoder,
  encodeFrame,
  parseFoundationStudioRequest,
  parseStudioHelloRequest,
  type CommandId,
  type EventSeq,
  type RequestId,
  type RuntimeEpoch,
  type RuntimeId,
  type RuntimeInstanceId,
  type SessionId,
  type StateVersion,
  type StudioEventEnvelope,
  type StudioHelloResponse,
  type StudioRequest,
  type StudioSnapshotResponse,
} from "@omp-studio/studio-protocol";
import {
  COMMAND_LEDGER_TERMINAL_BYTE_LIMIT,
  COMMAND_LEDGER_TERMINAL_ENTRY_LIMIT,
  CONVERSATION_REPLAY_BYTE_LIMIT,
  CONVERSATION_REPLAY_SESSION_LIMIT,
  CommandLedger,
  ConversationEventFanout,
  JsonlCommandLedgerStore,
  RuntimeProjection,
  StudioBridgeClient,
  createChallengeProof,
} from "../src/index.js";

const epoch = 1 as RuntimeEpoch;
const runtimeId = "runtime-performance" as RuntimeId;
const sessionId = "session-performance" as SessionId;

function helloResponse(
  hello: ReturnType<typeof parseStudioHelloRequest>,
  token: string,
): StudioHelloResponse {
  const runtimeInstanceId = "runtime-instance-performance" as RuntimeInstanceId;
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
      generatedAt: "2026-08-25T00:00:00.000Z",
      hash: "sha256:performance-capabilities",
      capabilities: [],
    },
    commandManifestHash: "sha256:performance-commands",
    stateVersion: 0 as StateVersion,
    challengeProof: createChallengeProof(token, hello.challenge, runtimeInstanceId),
  };
}

function snapshotResponse(requestId: string, hello: StudioHelloResponse): StudioSnapshotResponse {
  return {
    type: "studio.snapshot",
    requestId: requestId as RequestId,
    snapshot: {
      runtimeId: hello.runtimeInstanceId as unknown as RuntimeId,
      runtimeEpoch: hello.runtimeEpoch,
      stateVersion: hello.stateVersion,
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
    },
    commandManifestHash: hello.commandManifestHash,
    capabilityHash: hello.capabilityManifest.hash,
    lastEventSeq: 0 as EventSeq,
    terminalReceipts: [],
  };
}

async function performanceBridge(
  token: string,
  onRequest: (request: StudioRequest, socket: Socket, hello: StudioHelloResponse) => void,
  options: {
    snapshot?: (requestId: string, hello: StudioHelloResponse, snapshotNumber: number) => StudioSnapshotResponse;
    afterSnapshot?: (
      response: StudioSnapshotResponse,
      hello: StudioHelloResponse,
      snapshotNumber: number,
    ) => readonly Buffer[];
  } = {},
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const endpoint = `\\\\.\\pipe\\omp-studio-streaming-performance-${randomUUID()}`;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const decoder = new FrameDecoder();
    let negotiated: StudioHelloResponse | undefined;
    let snapshotNumber = 0;
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if ((frame.body as { type?: unknown }).type === "studio.hello") {
          const hello = parseStudioHelloRequest(frame.body);
          negotiated = helloResponse(hello, token);
          socket.write(encodeFrame(`hello:${hello.requestId}`, negotiated.runtimeEpoch, negotiated));
          continue;
        }
        const request = parseFoundationStudioRequest(frame.body);
        if (negotiated === undefined) throw new Error("Bridge request arrived before hello");
        if (request.operation.kind === "runtime.snapshot") {
          snapshotNumber += 1;
          const response =
            options.snapshot?.(request.requestId, negotiated, snapshotNumber) ??
            snapshotResponse(request.requestId, negotiated);
          socket.write(Buffer.concat([
            encodeFrame(`snapshot:${request.requestId}`, negotiated.runtimeEpoch, response),
            ...(options.afterSnapshot?.(response, negotiated, snapshotNumber) ?? []),
          ]));
        } else {
          onRequest(request, socket, negotiated);
        }
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

function conversationDelta(seq: number, child: number): StudioEventEnvelope {
  return {
    type: "studio.event",
    runtimeEpoch: epoch,
    eventSeq: seq as EventSeq,
    stateVersion: 0 as StateVersion,
    occurredAt: "2026-08-25T00:00:00.000Z",
    event: {
      kind: "conversation.message.delta",
      sessionId: `child-session-${child}` as SessionId,
      turnId: `turn-${child}`,
      messageId: `message-${child}`,
      blockId: "text-0",
      blockType: "text",
      delta: "x",
    },
  };
}

test("receipt correlation bypasses a multi-session delta flood and deltas do not publish projections", async () => {
  const token = "bridge-token-performance";
  const eventCount = 120;
  const bridge = await performanceBridge(token, (request, socket, hello) => {
    const frames = Array.from({ length: eventCount }, (_, index) =>
      encodeFrame(`event:${index + 1}`, hello.runtimeEpoch, conversationDelta(index + 1, index % 8)),
    );
    frames.push(encodeFrame("receipt:completed", hello.runtimeEpoch, {
      type: "studio.receipt",
      requestId: request.requestId,
      commandId: "command-performance",
      runtimeEpoch: hello.runtimeEpoch,
      stateVersion: 0,
      status: "completed",
      result: { ok: true },
    }));
    socket.write(Buffer.concat(frames));
  });
  let observedEvents = 0;
  let eventsAtReceipt = -1;
  let projectionPublications = 0;
  const client = new StudioBridgeClient({
    endpoint: bridge.endpoint,
    token,
    onEvent: () => {
      observedEvents += 1;
    },
    onProjectionChanged: () => {
      projectionPublications += 1;
    },
  });
  try {
    await client.connect();
    await client.requestSnapshot();
    const result = await client.invoke(
      {
        type: "studio.request",
        requestId: "request-performance" as RequestId,
        runtimeEpoch: epoch,
        operation: { kind: "runtime.pause" },
      },
      () => {
        eventsAtReceipt = observedEvents;
      },
    );
    assert.equal(result.status, "completed");
    assert.equal(eventsAtReceipt, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observedEvents, eventCount);
    assert.equal(projectionPublications, 1);
  } finally {
    client.close();
    await bridge.close();
  }
});

test("RuntimeProjection marks conversation-only events as unprojected", () => {
  const token = "projection-performance-token";
  const hello = helloResponse({
    type: "studio.hello",
    requestId: "hello-performance" as RequestId,
    supportedProtocolVersions: [1],
    requiredProfile: "full-parity-v1",
    challenge: "projection-performance-challenge",
  }, token);
  const projection = new RuntimeProjection();
  projection.beginConnection(hello);
  projection.applySnapshot(snapshotResponse("snapshot-performance", hello));
  assert.equal(projection.applyEvent(conversationDelta(1, 1)), "applied-unprojected");
  assert.equal(projection.snapshot()?.stateVersion, 0);
});

test("an event gap automatically snapshots and resumes later events", async () => {
  const token = "bridge-token-gap-recovery";
  const gapEventSeq = 2;
  let snapshotRequests = 0;
  let resolveContinued!: () => void;
  const continued = new Promise<void>((resolve) => {
    resolveContinued = resolve;
  });
  const bridge = await performanceBridge(token, () => undefined, {
    snapshot(requestId, hello, snapshotNumber) {
      snapshotRequests = snapshotNumber;
      const response = snapshotResponse(requestId, hello);
      return snapshotNumber === 1
        ? response
        : { ...response, lastEventSeq: gapEventSeq as EventSeq };
    },
    afterSnapshot(_response, hello, snapshotNumber) {
      if (snapshotNumber === 1) {
        return [encodeFrame("gap-event", hello.runtimeEpoch, conversationDelta(gapEventSeq, 0))];
      }
      return [
        encodeFrame(
          "continued-event",
          hello.runtimeEpoch,
          conversationDelta(gapEventSeq + 1, 0),
        ),
      ];
    },
  });
  const client = new StudioBridgeClient({
    endpoint: bridge.endpoint,
    token,
    onEvent: (event) => {
      if (Number(event.eventSeq) === gapEventSeq + 1) resolveContinued();
    },
  });
  try {
    await client.connect();
    await client.requestSnapshot();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`snapshot recovery timed out in ${client.state} after ${snapshotRequests} snapshots`)),
        2_000,
      );
      void continued.then(() => {
        clearTimeout(timer);
        resolve();
      }, reject);
    });
    assert.equal(client.state, "ready");
  } finally {
    client.close();
    await bridge.close();
  }
});

test("gap recovery resumes after the last pending request times out", async () => {
  const token = "bridge-token-pending-timeout-gap";
  let snapshotRequests = 0;
  let resolveResync!: () => void;
  let resolveContinued!: () => void;
  const resync = new Promise<void>((resolve) => {
    resolveResync = resolve;
  });
  const continued = new Promise<void>((resolve) => {
    resolveContinued = resolve;
  });
  const bridge = await performanceBridge(token, (_request, socket, hello) => {
    socket.write(encodeFrame("pending-gap", hello.runtimeEpoch, conversationDelta(2, 0)));
  }, {
    snapshot(requestId, hello, snapshotNumber) {
      snapshotRequests = snapshotNumber;
      const response = snapshotResponse(requestId, hello);
      return snapshotNumber === 1 ? response : { ...response, lastEventSeq: 2 as EventSeq };
    },
    afterSnapshot(_response, hello, snapshotNumber) {
      return snapshotNumber === 2
        ? [encodeFrame("continued:gap", hello.runtimeEpoch, conversationDelta(3, 0))]
        : [];
    },
  });
  const client = new StudioBridgeClient({
    endpoint: bridge.endpoint,
    token,
    requestTimeoutMs: 100,
    onResyncRequired: resolveResync,
    onEvent: (event) => {
      if (Number(event.eventSeq) === 3) resolveContinued();
    },
  });
  try {
    await client.connect();
    await client.requestSnapshot();
    const invocation = client.invoke({
      type: "studio.request",
      requestId: "request-pending-timeout-gap" as RequestId,
      runtimeEpoch: epoch,
      operation: { kind: "runtime.pause" },
    });
    await resync;
    assert.equal(client.state, "snapshot-required");
    assert.equal(snapshotRequests, 1);
    await assert.rejects(invocation, { code: "OUTCOME_UNKNOWN" });
    await continued;
    assert.equal(snapshotRequests, 2);
    assert.equal(client.state, "ready");
  } finally {
    client.close();
    await bridge.close();
  }
});

test("queue-overflow recovery resumes after the last pending request times out", async () => {
  const token = "bridge-token-pending-timeout-overflow";
  const snapshotEventSeq = 4_097;
  const socket = new EventEmitter() as EventEmitter & Socket;
  const outbound = new FrameDecoder();
  let snapshotRequests = 0;
  let negotiated: StudioHelloResponse | undefined;
  let destroyed = false;
  let resolveResync!: () => void;
  let resolveContinued!: () => void;
  const resync = new Promise<void>((resolve) => {
    resolveResync = resolve;
  });
  const continued = new Promise<void>((resolve) => {
    resolveContinued = resolve;
  });
  socket.write = ((chunk: Uint8Array): boolean => {
    for (const frame of outbound.push(chunk)) {
      if ((frame.body as { type?: unknown }).type === "studio.hello") {
        const hello = parseStudioHelloRequest(frame.body);
        negotiated = helloResponse(hello, token);
        socket.emit("data", encodeFrame(`hello:${hello.requestId}`, negotiated.runtimeEpoch, negotiated));
        continue;
      }
      const request = parseFoundationStudioRequest(frame.body);
      assert.notEqual(negotiated, undefined);
      if (request.operation.kind === "runtime.snapshot") {
        snapshotRequests += 1;
        const response = snapshotResponse(request.requestId, negotiated!);
        const snapshot = snapshotRequests === 1
          ? response
          : { ...response, lastEventSeq: snapshotEventSeq as EventSeq };
        socket.emit("data", Buffer.concat([
          encodeFrame(`snapshot:${request.requestId}`, epoch, snapshot),
          ...(snapshotRequests === 2
            ? [encodeFrame("continued:overflow", epoch, conversationDelta(snapshotEventSeq + 1, 0))]
            : []),
        ]));
        continue;
      }
      socket.emit("data", Buffer.concat(
        Array.from({ length: snapshotEventSeq }, (_, index) =>
          encodeFrame(`pending-overflow:${index + 1}`, epoch, conversationDelta(index + 1, 0)),
        ),
      ));
    }
    return true;
  }) as Socket["write"];
  socket.destroy = (() => {
    if (!destroyed) {
      destroyed = true;
      socket.emit("close");
    }
    return socket;
  }) as Socket["destroy"];

  const client = new StudioBridgeClient({
    endpoint: "memory://queue-overflow",
    token,
    requestTimeoutMs: 500,
    connectSocket: () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
    onResyncRequired: resolveResync,
    onEvent: (event) => {
      if (Number(event.eventSeq) === snapshotEventSeq + 1) resolveContinued();
    },
  });
  try {
    await client.connect();
    await client.requestSnapshot();
    const invocation = client.invoke({
      type: "studio.request",
      requestId: "request-pending-timeout-overflow" as RequestId,
      runtimeEpoch: epoch,
      operation: { kind: "runtime.pause" },
    });
    await resync;
    assert.equal(client.state, "snapshot-required");
    assert.equal(snapshotRequests, 1);
    await assert.rejects(invocation, { code: "OUTCOME_UNKNOWN" });
    await continued;
    assert.equal(snapshotRequests, 2);
    assert.equal(client.state, "ready");
  } finally {
    client.close();
  }
});

test("terminal command retention is bounded by entry count and UTF-8 bytes", () => {
  const ledger = new CommandLedger(() => "2026-08-25T00:00:00.000Z");
  for (let index = 0; index < COMMAND_LEDGER_TERMINAL_ENTRY_LIMIT + 8; index += 1) {
    const commandId = `command-${index}` as CommandId;
    ledger.request(commandId, {
      type: "studio.request",
      requestId: `request-${index}` as RequestId,
      runtimeEpoch: epoch,
      operation: { kind: "runtime.pause" },
    }, runtimeId);
    ledger.transition(commandId, "failed", { errorCode: "x".repeat(2_048) });
  }
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.length < COMMAND_LEDGER_TERMINAL_ENTRY_LIMIT, true);
  const retainedBytes = snapshot.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0);
  assert.equal(retainedBytes <= COMMAND_LEDGER_TERMINAL_BYTE_LIMIT, true);
  assert.equal(ledger.getByRequestId(`request-${COMMAND_LEDGER_TERMINAL_ENTRY_LIMIT + 7}`)?.status, "failed");
  assert.equal(ledger.getByRequestId("request-0"), undefined);
});

test("durable terminal retention compacts before restart and preserves nonterminal commands", () => {
  const path = join(tmpdir(), `omp-studio-ledger-compact-${randomUUID()}.jsonl`);
  const store = new JsonlCommandLedgerStore(path);
  const ledger = new CommandLedger(() => "2026-08-25T00:00:00.000Z", store);
  ledger.request("command-open" as CommandId, {
    type: "studio.request",
    requestId: "request-open" as RequestId,
    runtimeEpoch: epoch,
    operation: { kind: "runtime.pause" },
  }, runtimeId);
  for (let index = 0; index < COMMAND_LEDGER_TERMINAL_ENTRY_LIMIT + 8; index += 1) {
    const commandId = `command-durable-${index}` as CommandId;
    ledger.request(commandId, {
      type: "studio.request",
      requestId: `request-durable-${index}` as RequestId,
      runtimeEpoch: epoch,
      operation: { kind: "runtime.pause" },
    }, runtimeId);
    ledger.transition(commandId, "failed");
  }

  const beforeRestart = ledger.snapshot();
  const content = readFileSync(path, "utf8");
  const durableLines = content.trimEnd().split("\n");
  assert.equal(durableLines.length, beforeRestart.length);
  assert.equal(Buffer.byteLength(content, "utf8") <= COMMAND_LEDGER_TERMINAL_BYTE_LIMIT + beforeRestart.length, true);

  const restored = new CommandLedger(
    () => "2026-08-25T00:00:01.000Z",
    new JsonlCommandLedgerStore(path),
  );
  assert.equal(restored.snapshot().length, beforeRestart.length);
  assert.equal(restored.getByRequestId("request-open")?.status, "requested");
  assert.equal(restored.getByRequestId("request-durable-0"), undefined);
  assert.equal(
    restored.getByRequestId(`request-durable-${COMMAND_LEDGER_TERMINAL_ENTRY_LIMIT + 7}`)?.status,
    "failed",
  );
});

test("conversation replay fails closed on byte overflow before its event-count limit", () => {
  const fanout = new ConversationEventFanout();
  const delta = "x".repeat(32 * 1024);
  for (let index = 0; index < Math.ceil(CONVERSATION_REPLAY_BYTE_LIMIT / delta.length) + 2; index += 1) {
    fanout.forward({
      ...conversationDelta(index + 1, 0),
      event: {
        kind: "conversation.message.delta",
        sessionId: "child-session-0" as SessionId,
        turnId: "turn-0",
        messageId: "message-0",
        blockId: `block-${index}`,
        blockType: "text",
        delta,
      },
    } as StudioEventEnvelope);
  }
  const reasons: string[] = [];
  fanout.onResync((reason) => reasons.push(reason));
  fanout.replay("child-session-0" as SessionId, () => undefined);
  assert.equal(reasons.length, 1);
});

test("small tool-output appends replay as bounded chunks without aggregate re-encoding", () => {
  const fanout = new ConversationEventFanout();
  const updateCount = 10_000;
  for (let index = 0; index < updateCount; index += 1) {
    fanout.forward({
      type: "studio.event",
      runtimeEpoch: epoch,
      eventSeq: (index + 1) as EventSeq,
      stateVersion: 0 as StateVersion,
      occurredAt: "2026-08-25T00:00:00.000Z",
      event: {
        kind: "conversation.tool.updated",
        sessionId,
        turnId: "turn-tool",
        toolCallId: "tool-1",
        updateMode: "append",
        output: "x",
      },
    });
  }
  const replayed: StudioEventEnvelope[] = [];
  fanout.replay(sessionId, (forward) => replayed.push(forward.envelope));
  const output = replayed.reduce((total, envelope) => {
    const event = envelope.event as { kind?: string; output?: string };
    return event.kind === "conversation.tool.updated" ? total + (event.output ?? "") : total;
  }, "");
  assert.equal(output.length, updateCount);
  assert.equal(replayed.length < 10, true);
});

test("evicted open sessions retain a bounded resync tombstone", () => {
  const fanout = new ConversationEventFanout();
  for (let index = 0; index <= CONVERSATION_REPLAY_SESSION_LIMIT; index += 1) {
    fanout.forward({
      type: "studio.event",
      runtimeEpoch: epoch,
      eventSeq: (index + 1) as EventSeq,
      stateVersion: 0 as StateVersion,
      occurredAt: "2026-08-25T00:00:00.000Z",
      event: {
        kind: "conversation.message.started",
        sessionId: `eviction-session-${index}` as SessionId,
        turnId: `turn-${index}`,
        messageId: `message-${index}`,
        role: "assistant",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    });
  }
  const reasons: string[] = [];
  fanout.onResync((reason) => reasons.push(reason));
  fanout.replay("eviction-session-0" as SessionId, () => undefined);
  assert.equal(reasons.length, 1);
});
