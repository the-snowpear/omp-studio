import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { createConnection, createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import {
  FrameDecoder,
  encodeFrame,
  parseFoundationStudioRequest,
  parseStudioHelloRequest,
  type StudioHelloResponse,
  type StudioEventEnvelope,
  type StudioSnapshotResponse,
} from "@omp-studio/studio-protocol";
import type {
  CommandId,
  EnvironmentId,
  IdempotencyKey,
  InteractionId,
  RequestId,
  RuntimeEpoch,
  RuntimeId,
  RuntimeInstanceId,
  SessionBinding,
  StateVersion,
  StudioRequest,
  ThreadId,
  WorkspaceId,
} from "@omp-studio/studio-protocol";
import {
  CommandArbiter,
  CommandLedger,
  HostConfirmationRegistry,
  JsonlCommandLedgerStore,
  NodeRuntimeProcessPort,
  ReceiptRegistry,
  RuntimeProjection,
  RuntimePublicationStore,
  StateProjector,
  StudioHostError,
  StudioBridgeClient,
  StudioBridgeHandshakeError,
  StudioHostRuntimeActor,
  StudioRuntimeSessionController,
  classifyOperation,
  consumeBridgeToken,
  createBridgeBootstrap,
  createChallengeProof,
  createWindowsBridgeAclPort,
  parseWindowsUserSid,
  verifyChallengeProof,
} from "../src/index.js";
import { SimulatedPauseRuntime, initialSnapshot } from "./support/simulated-runtime.js";

const runtimeId = "runtime-1" as RuntimeId;
const epoch = 1 as RuntimeEpoch;
const request = (operation: StudioRequest["operation"], requestId = "request-1"): StudioRequest => ({
  type: "studio.request",
  requestId: requestId as RequestId,
  runtimeEpoch: epoch,
  operation,
});

type HelloResponder = (hello: ReturnType<typeof parseStudioHelloRequest>, connection: number) => StudioHelloResponse | Buffer;

function helloResponse(
  hello: ReturnType<typeof parseStudioHelloRequest>,
  token: string,
  runtimeInstanceId = "runtime-instance-1" as RuntimeInstanceId,
  selectedProtocolVersion = 1,
): StudioHelloResponse {
  return {
    type: "studio.hello.result",
    requestId: hello.requestId,
    selectedProtocolVersion,
    runtimeVersion: "17.2.12-studio.3",
    upstreamVersion: "17.2.12",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    runtimeInstanceId,
    runtimeEpoch: 1 as RuntimeEpoch,
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

function snapshotResponse(
  requestId: string,
  hello: StudioHelloResponse,
  sessionId = "session-1",
): StudioSnapshotResponse {
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

async function listenForHello(
  responder: HelloResponder,
  hooks: {
    afterSnapshot?: (response: StudioSnapshotResponse) => Buffer[];
    snapshot?: (requestId: string, hello: StudioHelloResponse) => StudioSnapshotResponse;
    onRequest?: (request: StudioRequest, socket: Socket, hello: StudioHelloResponse) => void;
  } = {},
): Promise<{
  endpoint: string;
  close(): Promise<void>;
}> {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omp-studio-test-${randomUUID()}`
      : join(await mkdtemp(join(tmpdir(), "omp-studio-transport-")), "bridge.sock");
  const sockets = new Set<Socket>();
  let connection = 0;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const decoder = new FrameDecoder();
    const currentConnection = ++connection;
    let negotiated: StudioHelloResponse | undefined;
    socket.on("data", (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if ((frame.body as { type?: unknown }).type === "studio.hello") {
            const hello = parseStudioHelloRequest(frame.body);
            const response = responder(hello, currentConnection);
            if (!Buffer.isBuffer(response)) negotiated = response;
            socket.write(
              Buffer.isBuffer(response)
                ? response
                : encodeFrame(`hello-result:${hello.requestId}`, response.runtimeEpoch, response),
            );
            continue;
          }
          const request = parseFoundationStudioRequest(frame.body);
          if (negotiated === undefined) throw new Error("Not ready");
          if (request.operation.kind !== "runtime.snapshot") {
            if (hooks.onRequest === undefined) throw new Error("Unsupported request");
            hooks.onRequest(request, socket, negotiated);
            continue;
          }
          const response = hooks.snapshot?.(request.requestId, negotiated) ?? snapshotResponse(request.requestId, negotiated);
          socket.write(
            Buffer.concat([
              encodeFrame(`snapshot-result:${request.requestId}`, response.snapshot.runtimeEpoch, response),
              ...(hooks.afterSnapshot?.(response) ?? []),
            ]),
          );
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

test("WP-012 applies an event coalesced after the initial snapshot before READY publication", async () => {
  const token = "bridge-token-snapshot-event";
  const observedEvents: StudioEventEnvelope[] = [];
  const bridge = await listenForHello(
    (hello) => helloResponse(hello, token),
    {
      afterSnapshot: (response) => [
        encodeFrame("event:1", response.snapshot.runtimeEpoch, {
          type: "studio.event",
          runtimeEpoch: response.snapshot.runtimeEpoch,
          eventSeq: 1,
          stateVersion: 1,
          occurredAt: "2026-08-11T00:00:01.000Z",
          event: {
            kind: "state.changed",
            snapshot: { ...response.snapshot, stateVersion: 1 },
          },
        }),
      ],
    },
  );
  const client = new StudioBridgeClient({
    endpoint: bridge.endpoint,
    token,
    onEvent: (event) => observedEvents.push(event),
  });
  try {
    await client.connect();
    await client.requestSnapshot();
    assert.equal(client.state, "ready");
    assert.equal(observedEvents.length, 1);
    assert.equal(observedEvents[0]?.eventSeq, 1);
  } finally {
    client.close();
    await bridge.close();
  }
});

test("WP-013 correlates accepted/event/completed frames into a durable publication", async () => {
  const token = "bridge-token-command-lifecycle";
  const bridge = await listenForHello((hello) => helloResponse(hello, token), {
    onRequest(request, socket, hello) {
      const base = snapshotResponse(request.requestId, hello).snapshot;
      socket.write(
        Buffer.concat([
          encodeFrame("receipt:accepted", hello.runtimeEpoch, {
            type: "studio.receipt",
            requestId: request.requestId,
            commandId: "runtime-command-1",
            runtimeEpoch: hello.runtimeEpoch,
            stateVersion: 0,
            status: "accepted",
          }),
          encodeFrame("event:paused", hello.runtimeEpoch, {
            type: "studio.event",
            runtimeEpoch: hello.runtimeEpoch,
            eventSeq: 1,
            stateVersion: 1,
            occurredAt: "2026-08-11T00:00:01.000Z",
            event: {
              kind: "state.changed",
              snapshot: {
                ...base,
                stateVersion: 1,
                pause: { paused: true, pauseEpoch: 1, pausedAt: "2026-08-11T00:00:01.000Z" },
              },
            },
          }),
          encodeFrame("receipt:completed", hello.runtimeEpoch, {
            type: "studio.receipt",
            requestId: request.requestId,
            commandId: "runtime-command-1",
            runtimeEpoch: hello.runtimeEpoch,
            stateVersion: 1,
            status: "completed",
            result: { pauseEpoch: 1 },
          }),
        ]),
      );
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const ledger = new CommandLedger(() => "2026-08-11T00:00:00.000Z");
  const controller = new StudioRuntimeSessionController(
    client,
    ledger,
    new RuntimePublicationStore(() => "2026-08-11T00:00:02.000Z"),
  );
  try {
    await client.connect();
    await controller.refresh();
    const receipt = await controller.invoke(request({ kind: "runtime.pause" }, "request-wire-command"));
    assert.equal(receipt.status, "completed");
    assert.equal(ledger.getByRequestId("request-wire-command")?.commandId, "runtime-command-1");
    assert.equal(ledger.getByRequestId("request-wire-command")?.status, "completed");
    assert.equal(controller.publication()?.snapshot.pause?.paused, true);
    assert.equal(controller.publication()?.terminalOutcomes[0]?.status, "completed");
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("WP-013 renderer refresh reconciles terminal receipt tail from READY", async () => {
  const token = "bridge-token-terminal-tail";
  const terminalReceipt = {
    type: "studio.receipt" as const,
    requestId: "request-tail" as RequestId,
    commandId: "runtime-command-tail" as CommandId,
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    status: "completed" as const,
  };
  const bridge = await listenForHello((hello) => helloResponse(hello, token), {
    snapshot(requestId, hello) {
      const response = snapshotResponse(requestId, hello);
      return {
        ...response,
        snapshot: { ...response.snapshot, stateVersion: 1 as StateVersion },
        terminalReceipts: [terminalReceipt],
      };
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const ledger = new CommandLedger(() => "2026-08-11T00:00:00.000Z");
  ledger.request("request-tail" as CommandId, request({ kind: "runtime.pause" }, "request-tail"), runtimeId);
  const controller = new StudioRuntimeSessionController(client, ledger);
  try {
    await client.connect();
    await controller.refresh();
    assert.equal(ledger.getByRequestId("request-tail")?.commandId, "runtime-command-tail");
    assert.equal(ledger.getByRequestId("request-tail")?.status, "completed");
    const refreshed = await controller.refresh();
    assert.equal(refreshed.terminalOutcomes[0]?.status, "completed");
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("PR-010 Bridge shutdown waits for the terminal receipt and shutdownComplete event", async () => {
  const token = "bridge-token-shutdown";
  const bridge = await listenForHello((hello) => helloResponse(hello, token), {
    onRequest(request, socket, hello) {
      assert.deepEqual(request.operation, { kind: "runtime.shutdown", drain: true });
      socket.write(Buffer.concat([
        encodeFrame("receipt:shutdown", hello.runtimeEpoch, {
          type: "studio.receipt",
          requestId: request.requestId,
          commandId: "runtime-command-shutdown",
          runtimeEpoch: hello.runtimeEpoch,
          stateVersion: 0,
          status: "completed",
          result: { drained: true },
        }),
        encodeFrame("event:shutdown", hello.runtimeEpoch, {
          type: "studio.event",
          runtimeEpoch: hello.runtimeEpoch,
          eventSeq: 1,
          stateVersion: 0,
          occurredAt: "2026-08-12T00:00:00.000Z",
          event: { kind: "runtime.shutdownComplete" },
        }),
      ]));
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  try {
    await client.connect();
    await client.requestSnapshot();
    assert.equal((await client.shutdown()).status, "completed");
  } finally {
    client.close();
    await bridge.close();
  }
});

test("RT-002 Bridge command-manifest probe parses and returns the advertised manifest", async () => {
  const token = "bridge-token-command-manifest";
  const bridge = await listenForHello((hello) => helloResponse(hello, token), {
    onRequest(request, socket, hello) {
      assert.deepEqual(request.operation, { kind: "operator.manifest.get" });
      socket.write(encodeFrame("receipt:manifest", hello.runtimeEpoch, {
        type: "studio.receipt",
        requestId: request.requestId,
        commandId: "runtime-command-manifest",
        runtimeEpoch: hello.runtimeEpoch,
        stateVersion: 0,
        status: "completed",
        result: {
          generatedAt: "1970-01-01T00:00:00.000Z",
          upstreamCommit: hello.upstreamCommit,
          hash: hello.commandManifestHash,
          commands: [],
          unclassifiedBuiltins: [],
        },
      }));
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  try {
    await client.connect();
    await client.requestSnapshot();
    const manifest = await client.requestCommandManifest();
    assert.equal(manifest.hash, "sha256:empty-commands");
    assert.deepEqual(manifest.unclassifiedBuiltins, []);
  } finally {
    client.close();
    await bridge.close();
  }
});

test("PR-009 disconnect after accepted publishes outcome_unknown without fake completion", async () => {
  const token = "bridge-token-accepted-crash";
  const bridge = await listenForHello((hello) => helloResponse(hello, token), {
    onRequest(request, socket, hello) {
      socket.write(
        encodeFrame("receipt:accepted-before-crash", hello.runtimeEpoch, {
          type: "studio.receipt",
          requestId: request.requestId,
          commandId: "runtime-command-crash",
          runtimeEpoch: hello.runtimeEpoch,
          stateVersion: 0,
          status: "accepted",
        }),
        () => socket.destroy(),
      );
    },
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  const ledger = new CommandLedger(() => "2026-08-11T00:00:00.000Z");
  const controller = new StudioRuntimeSessionController(client, ledger);
  try {
    await client.connect();
    await controller.refresh();
    await assert.rejects(() => controller.invoke(request({ kind: "runtime.pause" }, "request-crash")));
    assert.equal(ledger.getByRequestId("request-crash")?.commandId, "runtime-command-crash");
    assert.equal(ledger.getByRequestId("request-crash")?.status, "outcome_unknown");
    assert.equal(controller.publication()?.terminalOutcomes[0]?.status, "outcome_unknown");
  } finally {
    controller.dispose();
    client.close();
    await bridge.close();
  }
});

test("connectUntilReady retries CONNECTION_FAILED until the pipe accepts", async () => {
  const token = "bridge-token-retry";
  const bridge = await listenForHello((hello) => helloResponse(hello, token));
  let attempts = 0;
  const client = new StudioBridgeClient({
    endpoint: bridge.endpoint,
    token,
    connectSocket: (endpoint) => {
      attempts += 1;
      if (attempts < 3) {
        const socket = new Socket();
        queueMicrotask(() => {
          socket.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
        });
        return socket;
      }
      return createConnection(endpoint);
    },
  });
  try {
    const response = await client.connectUntilReady({ deadline: Date.now() + 2_000 });
    assert.equal(attempts >= 3, true);
    assert.equal(client.state, "negotiated");
    assert.equal(response.runtimeVersion, "17.2.12-studio.3");
  } finally {
    client.close();
    await bridge.close();
  }
});

test("WP-011 authenticates a real local Bridge connection without sending the token", async () => {
  const token = "bridge-token-1";
  let observedHello = "";
  const bridge = await listenForHello((hello) => {
    observedHello = JSON.stringify(hello);
    return helloResponse(hello, token);
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  try {
    const response = await client.connect();
    assert.equal(client.state, "negotiated");
    assert.equal(response.capabilityManifest.profile, "limited");
    assert.equal(observedHello.includes(token), false);
    const snapshot = await client.requestSnapshot();
    assert.equal(client.state, "ready");
    assert.equal(snapshot.snapshot.sessionId, "session-1");
  } finally {
    client.close();
    await bridge.close();
  }
});

test("PR-002 connection authentication fails without leaking Bridge secrets", async () => {
  const token = "bridge-token-correct";
  const bridge = await listenForHello((hello) => ({
    ...helloResponse(hello, "bridge-token-wrong"),
    challengeProof: "invalid-proof",
  }));
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  try {
    await assert.rejects(() => client.connect(), (error: unknown) => {
      assert.equal(error instanceof StudioBridgeHandshakeError && error.code === "UNAUTHENTICATED", true);
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes(token) && !message.includes(bridge.endpoint);
    });
  } finally {
    client.close();
    await bridge.close();
  }
});

test("WP-011 rejects an unsupported negotiated protocol", async () => {
  const token = "bridge-token-version";
  const bridge = await listenForHello((hello) => helloResponse(hello, token, undefined, 2));
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  try {
    await assert.rejects(
      () => client.connect(),
      (error: unknown) => error instanceof StudioBridgeHandshakeError && error.code === "PROTOCOL_UNSUPPORTED",
    );
  } finally {
    client.close();
    await bridge.close();
  }
});

test("WP-011 reconnect uses a fresh challenge and requires the same runtime identity", async () => {
  const token = "bridge-token-reconnect";
  const challenges: string[] = [];
  const bridge = await listenForHello((hello, connection) => {
    challenges.push(hello.challenge);
    return helloResponse(
      hello,
      token,
      (connection === 1 ? "runtime-instance-1" : "runtime-instance-2") as RuntimeInstanceId,
    );
  });
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token });
  try {
    await client.connect();
    await client.requestSnapshot();
    client.disconnect();
    await assert.rejects(
      () => client.reconnect(),
      (error: unknown) => error instanceof StudioBridgeHandshakeError && error.code === "IDENTITY_CHANGED",
    );
    assert.equal(challenges.length, 2);
    assert.notEqual(challenges[0], challenges[1]);
  } finally {
    client.close();
    await bridge.close();
  }
});

test("WP-012 projection fences stale epochs and requests a snapshot on event gaps", () => {
  const token = "projection-token";
  const hello = helloResponse(
    {
      type: "studio.hello",
      requestId: "hello-projection" as RequestId,
      supportedProtocolVersions: [1],
      requiredProfile: "full-parity-v1",
      challenge: "projection-challenge",
    },
    token,
  );
  const projection = new RuntimeProjection();
  projection.beginConnection(hello);
  projection.applySnapshot(snapshotResponse("snapshot-projection", hello));
  const base = projection.snapshot()!;
  assert.equal(
    projection.applyEvent({
      type: "studio.event",
      runtimeEpoch: 1 as RuntimeEpoch,
      eventSeq: 1 as StudioSnapshotResponse["lastEventSeq"],
      stateVersion: 1 as StateVersion,
      occurredAt: "2026-08-11T00:00:01.000Z",
      event: { kind: "state.changed", snapshot: { ...base, stateVersion: 1 as StateVersion } },
    }),
    "applied",
  );
  assert.equal(
    projection.applyEvent({
      type: "studio.event",
      runtimeEpoch: 1 as RuntimeEpoch,
      eventSeq: 3 as StudioSnapshotResponse["lastEventSeq"],
      stateVersion: 2 as StateVersion,
      occurredAt: "2026-08-11T00:00:02.000Z",
      event: { kind: "state.changed", snapshot: { ...base, stateVersion: 2 as StateVersion } },
    }),
    "gap",
  );
  assert.equal(projection.needsSnapshot(), true);
  assert.equal(
    projection.applyEvent({
      type: "studio.event",
      runtimeEpoch: 99 as RuntimeEpoch,
      eventSeq: 2 as StudioSnapshotResponse["lastEventSeq"],
      stateVersion: 2 as StateVersion,
      occurredAt: "2026-08-11T00:00:03.000Z",
      event: { kind: "runtime.ready" },
    }),
    "snapshot-required",
  );
});

test("projection consumes a stale-session telemetry sequence without mutating the snapshot", () => {
  const token = "projection-telemetry-token";
  const hello = helloResponse(
    {
      type: "studio.hello",
      requestId: "hello-projection-telemetry" as RequestId,
      supportedProtocolVersions: [1],
      requiredProfile: "full-parity-v1",
      challenge: "projection-telemetry-challenge",
    },
    token,
  );
  const projection = new RuntimeProjection();
  projection.beginConnection(hello);
  projection.applySnapshot(snapshotResponse("snapshot-projection-telemetry", hello));
  const base = projection.snapshot()!;
  const staleSessionId = "session-old" as typeof base.sessionId;

  assert.equal(
    projection.applyEvent({
      type: "studio.event",
      runtimeEpoch: hello.runtimeEpoch,
      eventSeq: 1 as StudioSnapshotResponse["lastEventSeq"],
      stateVersion: base.stateVersion,
      occurredAt: "2026-08-15T00:00:01.000Z",
      event: {
        kind: "session.telemetry.changed",
        sessionId: staleSessionId,
        telemetry: {
          sessionId: staleSessionId,
          capturedAt: "2026-08-15T00:00:01.000Z",
          tokens: {
            input: 1,
            output: 2,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 3,
            cost: 0,
          },
          context: null,
          unavailableReason: "model_context_unknown",
        },
      },
    }),
    "stale",
  );
  assert.equal(projection.lastEventSeq(), 1);
  assert.equal(projection.snapshot()?.telemetry, undefined);
  assert.equal(projection.needsSnapshot(), false);

  assert.equal(
    projection.applyEvent({
      type: "studio.event",
      runtimeEpoch: hello.runtimeEpoch,
      eventSeq: 2 as StudioSnapshotResponse["lastEventSeq"],
      stateVersion: 1 as StateVersion,
      occurredAt: "2026-08-15T00:00:02.000Z",
      event: { kind: "state.changed", snapshot: { ...base, stateVersion: 1 as StateVersion } },
    }),
    "applied",
  );
  assert.equal(projection.lastEventSeq(), 2);
  assert.equal(projection.needsSnapshot(), false);
});

test("PR-008 closes a local Bridge connection on an oversized response", async () => {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(1024 * 1024 + 1);
  const bridge = await listenForHello(() => prefix);
  const client = new StudioBridgeClient({ endpoint: bridge.endpoint, token: "bridge-token-oversize" });
  try {
    await assert.rejects(
      () => client.connect(),
      (error: unknown) => error instanceof StudioBridgeHandshakeError && error.code === "MALFORMED_RESPONSE",
    );
  } finally {
    client.close();
    await bridge.close();
  }
});

test("PR-002 bridge token is one-time and challenge proof is bound to runtime identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-studio-bridge-"));
  const secured: string[] = [];
  const bootstrap = await createBridgeBootstrap(directory, "win32", {
    secureDirectory: async (path) => {
      secured.push(`directory:${path}`);
    },
    createSecureTokenFile: async (path, token) => {
      secured.push(`file:${path}`);
      await writeFile(path, token, { encoding: "utf8", flag: "wx" });
    },
  });
  assert.equal(secured.length, 2);
  const consumed = await consumeBridgeToken(bootstrap.tokenFile);
  assert.equal(consumed, bootstrap.token);
  const instance = "instance-1" as RuntimeInstanceId;
  const proof = createChallengeProof(consumed, "challenge-1", instance);
  assert.equal(verifyChallengeProof(consumed, "challenge-1", instance, proof), true);
  assert.equal(verifyChallengeProof(consumed, "challenge-2", instance, proof), false);
  assert.equal(verifyChallengeProof(consumed, "challenge-1", "instance-2" as RuntimeInstanceId, proof), false);
  await assert.rejects(() => consumeBridgeToken(bootstrap.tokenFile));
});

test("SEC-007 concurrent Bridge token consumers cannot both claim the secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-studio-token-race-"));
  const tokenFile = join(directory, "bridge.token");
  await writeFile(tokenFile, "one-time-token", { encoding: "utf8", flag: "wx" });
  const results = await Promise.allSettled([consumeBridgeToken(tokenFile), consumeBridgeToken(tokenFile)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("SEC-002 Windows bootstrap fails closed without an ACL provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-studio-bridge-no-acl-"));
  await assert.rejects(() => createBridgeBootstrap(directory, "win32"), /ACL provider/u);
});

test("SEC-002 production Windows ACL provider grants only the current SID", async () => {
  const commands: Array<{ executable: string; args: readonly string[] }> = [];
  const acl = createWindowsBridgeAclPort(async (executable, args) => {
    commands.push({ executable, args });
    if (executable === "whoami.exe") return '"desktop\\operator","S-1-5-21-100-200-300-400"';
    return "processed";
  });
  const directory = await mkdtemp(join(tmpdir(), "omp-studio-acl-provider-"));
  const tokenFile = join(directory, "bridge.token");
  await acl.secureDirectory(directory);
  await acl.createSecureTokenFile(tokenFile, "secret");
  assert.equal(parseWindowsUserSid('"desktop\\operator","S-1-5-21-100-200-300-400"'), "S-1-5-21-100-200-300-400");
  assert.deepEqual(commands, [
    { executable: "whoami.exe", args: ["/user", "/fo", "csv", "/nh"] },
    {
      executable: "icacls.exe",
      args: [directory, "/inheritance:r", "/grant:r", "*S-1-5-21-100-200-300-400:(OI)(CI)F"],
    },
    {
      executable: "icacls.exe",
      args: [tokenFile, "/inheritance:r", "/grant:r", "*S-1-5-21-100-200-300-400:F"],
    },
  ]);
  assert.equal(await consumeBridgeToken(tokenFile), "secret");
});

test("PR-004/PR-005 registry replays identical operations and rejects key reuse", () => {
  const registry = new ReceiptRegistry(2);
  const key = "same-key" as IdempotencyKey;
  const pause = request({ kind: "runtime.pause" });
  const receipt = {
    type: "studio.receipt" as const,
    requestId: pause.requestId,
    runtimeEpoch: epoch,
    stateVersion: 0 as StateVersion,
    status: "accepted" as const,
  };
  registry.remember(key, pause.operation, receipt);
  assert.equal(registry.lookup(key, { kind: "runtime.pause" }).kind, "replay");
  assert.equal(registry.lookup(key, { kind: "runtime.snapshot" }).kind, "conflict");
});

test("PR-006 projector increments stateVersion and eventSeq together", () => {
  const projector = new StateProjector(initialSnapshot(runtimeId, epoch));
  const event = projector.commit((draft) => {
    draft.pause = { paused: true, pauseEpoch: 1 };
  });
  assert.equal(event.stateVersion, 1);
  assert.equal(event.eventSeq, 1);
  assert.equal(projector.snapshot().pause?.paused, true);
});

test("PR-003 arbiter rejects stale epochs", async () => {
  const arbiter = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 0 as StateVersion,
    isStreaming: false,
    isCompacting: false,
  }));
  const stale = { ...request({ kind: "runtime.pause" }), runtimeEpoch: 0 as RuntimeEpoch };
  await assert.rejects(() => arbiter.run(stale, () => undefined), (error: unknown) => {
    return error instanceof StudioHostError && error.code === "RUNTIME_EPOCH_STALE";
  });
});

test("WP-014 arbiter enforces state, streaming, and exclusive-command gates", async () => {
  let state = {
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: false,
    isCompacting: false,
  };
  const arbiter = new CommandArbiter(() => state);
  await assert.rejects(
    () =>
      arbiter.run(
        { ...request({ kind: "runtime.pause" }), expectedStateVersion: 0 as StateVersion },
        () => undefined,
      ),
    (error: unknown) => error instanceof StudioHostError && error.code === "STATE_VERSION_CONFLICT",
  );

  state = { ...state, isStreaming: true };
  await assert.rejects(
    () => arbiter.run(request({ kind: "session.drop" }), () => undefined),
    (error: unknown) => error instanceof StudioHostError && error.code === "BUSY_STREAMING",
  );

  state = { ...state, isStreaming: false };
  let release: (() => void) | undefined;
  const held = arbiter.run(
    request({ kind: "runtime.pause" }),
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  await assert.rejects(
    () => arbiter.run(request({ kind: "runtime.resume", expectedPauseEpoch: 1 }, "request-exclusive"), () => undefined),
    (error: unknown) => error instanceof StudioHostError && error.code === "COMMAND_BLOCKED",
  );
  release?.();
  await held;
});

test("M4 operator.manifest.get is read-concurrent and operator.invoke is session-exclusive", async () => {
  assert.equal(classifyOperation({ kind: "operator.manifest.get" }), "read-concurrent");
  assert.equal(classifyOperation({ kind: "operator.invoke", commandId: "builtin.help" }), "session-exclusive");

  const streaming = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: true,
    isCompacting: false,
  }));
  await streaming.run(request({ kind: "operator.manifest.get" }), () => undefined);
  await assert.rejects(
    () => streaming.run(request({ kind: "operator.invoke", commandId: "builtin.help" }), () => undefined),
    (error: unknown) => error instanceof StudioHostError && error.code === "BUSY_STREAMING",
  );

  const compacting = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: false,
    isCompacting: true,
  }));
  await compacting.run(request({ kind: "operator.manifest.get" }), () => undefined);
  await assert.rejects(
    () => compacting.run(request({ kind: "operator.invoke", commandId: "builtin.help" }), () => undefined),
    (error: unknown) => error instanceof StudioHostError && error.code === "BUSY_COMPACTING",
  );
});

test("M4 concurrent operator.manifest.get reads both execute", async () => {
  const arbiter = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: false,
    isCompacting: false,
  }));
  let executions = 0;
  let release: (() => void) | undefined;
  const first = arbiter.run(
    request({ kind: "operator.manifest.get" }, "request-read-1"),
    () =>
      new Promise<void>((resolve) => {
        executions += 1;
        release = resolve;
      }),
  );
  await arbiter.run(request({ kind: "operator.manifest.get" }, "request-read-2"), () => {
    executions += 1;
  });
  assert.equal(executions, 2);
  assert.equal(arbiter.currentLease, undefined);
  release?.();
  await first;
});

test("PR-009 runtime loss fences accepted commands as outcome_unknown", async () => {
  const ledger = new CommandLedger(() => "2026-08-10T00:00:00.000Z");
  const commandId = "command-1" as CommandId;
  ledger.request(commandId, request({ kind: "runtime.pause" }), runtimeId);
  ledger.transition(commandId, "accepted");
  const binding: SessionBinding = {
    threadId: "thread-1" as ThreadId,
    environmentId: "environment-1" as EnvironmentId,
    workspaceId: "workspace-1" as WorkspaceId,
    runtimeId,
    runtimeEpoch: epoch,
    classification: "managed",
    backend: "studio-host",
    runtimeVersion: "v1",
    upstreamVersion: "0.0.0",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    capabilityHash: "capabilities",
  };
  const actor = new StudioHostRuntimeActor({ start: async () => undefined, stop: async () => undefined }, ledger);
  await actor.start(binding);
  actor.runtimeLost(runtimeId, epoch);
  assert.equal(actor.state, "crashed");
  assert.equal(ledger.get(commandId)?.status, "outcome_unknown");
});

test("WP-013 process exit automatically fences the active Runtime epoch", async () => {
  const ledger = new CommandLedger(() => "2026-08-11T00:00:00.000Z");
  const commandId = "command-process-exit" as CommandId;
  ledger.request(commandId, request({ kind: "runtime.pause" }, "request-process-exit"), runtimeId);
  ledger.transition(commandId, "accepted");
  let exitListener: (() => void) | undefined;
  const actor = new StudioHostRuntimeActor(
    {
      start: async () => undefined,
      stop: async () => undefined,
      onExit(listener) {
        exitListener = listener;
        return () => {
          exitListener = undefined;
        };
      },
    },
    ledger,
  );
  const binding: SessionBinding = {
    threadId: "thread-exit" as ThreadId,
    environmentId: "environment-exit" as EnvironmentId,
    workspaceId: "workspace-exit" as WorkspaceId,
    runtimeId,
    runtimeEpoch: epoch,
    classification: "managed",
    backend: "studio-host",
    runtimeVersion: "v1",
    upstreamVersion: "17.2.12",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    capabilityHash: "capabilities",
  };
  await actor.start(binding);
  exitListener?.();
  assert.equal(actor.state, "crashed");
  assert.equal(ledger.get(commandId)?.status, "outcome_unknown");
  actor.dispose();
});

test("WP-013 failed stop restores the actor to running instead of wedging in stopping", async () => {
  const actor = new StudioHostRuntimeActor(
    {
      start: async () => undefined,
      stop: async () => {
        throw new Error("stop failed");
      },
    },
    new CommandLedger(),
  );
  const binding: SessionBinding = {
    threadId: "thread-stop" as ThreadId,
    environmentId: "environment-stop" as EnvironmentId,
    workspaceId: "workspace-stop" as WorkspaceId,
    runtimeId,
    runtimeEpoch: epoch,
    classification: "managed",
    backend: "studio-host",
    runtimeVersion: "v1",
    upstreamVersion: "17.2.12",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    capabilityHash: "capabilities",
  };
  await actor.start(binding);
  await assert.rejects(() => actor.stop(), /stop failed/u);
  assert.equal(actor.state, "running");
});

test("WP-013 concrete process port spawns, awaits readiness, and stops through containment", async () => {
  let readinessChecks = 0;
  let requestedStops = 0;
  const port = new NodeRuntimeProcessPort({
    executable: process.execPath,
    cwd: process.cwd(),
    args: () => ["-e", "setInterval(() => {}, 1000)"],
    spawnOptions: { stdio: "ignore" },
    waitUntilReady: async (child) => {
      assert.ok(child.pid !== undefined);
      readinessChecks += 1;
    },
    containment: {
      requestStop(child) {
        requestedStops += 1;
        child.kill();
      },
      forceStop(child) {
        child.kill("SIGKILL");
      },
    },
  });
  const actor = new StudioHostRuntimeActor(port, new CommandLedger());
  const binding: SessionBinding = {
    threadId: "thread-process" as ThreadId,
    environmentId: "environment-process" as EnvironmentId,
    workspaceId: "workspace-process" as WorkspaceId,
    runtimeId,
    runtimeEpoch: epoch,
    classification: "managed",
    backend: "studio-host",
    runtimeVersion: "v1",
    upstreamVersion: "17.2.12",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    capabilityHash: "capabilities",
  };
  await actor.start(binding);
  assert.equal(actor.state, "running");
  await actor.stop();
  assert.equal(actor.state, "stopped");
  assert.equal(readinessChecks, 1);
  assert.equal(requestedStops, 1);
  actor.dispose();
});

test("PR-010 process port requests graceful shutdown before containment fallback", async () => {
  const calls: string[] = [];
  const port = new NodeRuntimeProcessPort({
    executable: process.execPath,
    cwd: process.cwd(),
    args: () => ["-e", "setInterval(() => {}, 1000)"],
    spawnOptions: { stdio: "ignore" },
    waitUntilReady: async () => undefined,
    requestGracefulShutdown: async child => {
      calls.push("bridge-shutdown");
      child.kill();
    },
    containment: {
      requestStop(child) { calls.push("containment-stop"); child.kill(); },
      forceStop(child) { calls.push("containment-force"); child.kill("SIGKILL"); },
    },
  });
  await port.start({
    threadId: "thread-shutdown" as ThreadId,
    environmentId: "environment-shutdown" as EnvironmentId,
    workspaceId: "workspace-shutdown" as WorkspaceId,
    runtimeId,
    runtimeEpoch: epoch,
    classification: "managed",
    backend: "studio-host",
    runtimeVersion: "v1",
    upstreamVersion: "17.2.12",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    capabilityHash: "capabilities",
  });
  await port.stop();
  assert.deepEqual(calls, ["bridge-shutdown"]);
});

test("WP-013 readiness failure force-stops the spawned Runtime", async () => {
  let forcedStops = 0;
  const port = new NodeRuntimeProcessPort({
    executable: process.execPath,
    cwd: process.cwd(),
    args: () => ["-e", "setInterval(() => {}, 1000)"],
    spawnOptions: { stdio: "ignore" },
    waitUntilReady: async () => {
      throw new Error("Bridge did not authenticate");
    },
    containment: {
      requestStop(child) {
        child.kill();
      },
      forceStop(child) {
        forcedStops += 1;
        child.kill("SIGKILL");
      },
    },
  });
  const binding: SessionBinding = {
    threadId: "thread-readiness" as ThreadId,
    environmentId: "environment-readiness" as EnvironmentId,
    workspaceId: "workspace-readiness" as WorkspaceId,
    runtimeId,
    runtimeEpoch: epoch,
    classification: "managed",
    backend: "studio-host",
    runtimeVersion: "v1",
    upstreamVersion: "17.2.12",
    upstreamCommit: "45e12e5bb758198a920c6070e7e64cb33b21beac",
    capabilityHash: "capabilities",
  };
  await assert.rejects(() => port.start(binding), /Bridge did not authenticate/u);
  assert.equal(forcedStops, 1);
});

test("PR-009 terminal ledger outcomes survive a Host restart", () => {
  const directory = join(tmpdir(), `omp-studio-ledger-${randomUUID()}`);
  const store = new JsonlCommandLedgerStore(join(directory, "commands.jsonl"));
  const commandId = "durable-command" as CommandId;
  const first = new CommandLedger(() => "2026-08-10T00:00:00.000Z", store);
  first.request(commandId, request({ kind: "runtime.pause" }), runtimeId);
  first.transition(commandId, "accepted");
  first.transition(commandId, "completed", { stateVersionAfter: 1 as StateVersion });
  const restored = new CommandLedger(() => "2026-08-10T00:00:01.000Z", store);
  assert.equal(restored.get(commandId)?.status, "completed");
  assert.equal(restored.get(commandId)?.stateVersionAfter, 1);
});

test("REC-002 ledger recovery ignores only a crash-truncated tail record", async () => {
  const directory = join(tmpdir(), `omp-studio-ledger-tail-${randomUUID()}`);
  const path = join(directory, "commands.jsonl");
  const store = new JsonlCommandLedgerStore(path);
  const commandId = "tail-command" as CommandId;
  const first = new CommandLedger(() => "2026-08-10T00:00:00.000Z", store);
  first.request(commandId, request({ kind: "runtime.pause" }), runtimeId);
  first.transition(commandId, "accepted");
  await appendFile(path, '{"commandId":"partial');
  const restored = new CommandLedger(() => "2026-08-10T00:00:01.000Z", store);
  assert.equal(restored.get(commandId)?.status, "accepted");
});

test("WP-013 ledger recovery rejects an invalid durable status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-studio-ledger-invalid-"));
  const path = join(directory, "commands.jsonl");
  await writeFile(
    path,
    `${JSON.stringify({
      commandId: "bad-command",
      requestId: "bad-request",
      runtimeId: "bad-runtime",
      runtimeEpoch: 1,
      operationKind: "runtime.pause",
      requestedAt: "2026-08-11T00:00:00.000Z",
      status: "invented-success",
    })}\n`,
  );
  assert.throws(() => new JsonlCommandLedgerStore(path).load(), /Invalid command ledger entry/u);
});

test("backend pause/resume fixture completes request -> receipt -> state -> reconnect snapshot", async () => {
  const runtime = new SimulatedPauseRuntime(initialSnapshot(runtimeId, epoch));
  const paused = await runtime.invoke({
    ...request({ kind: "runtime.pause" }),
    idempotencyKey: "pause-key" as IdempotencyKey,
  });
  assert.equal(paused.status, "completed");
  assert.equal(runtime.snapshot().pause?.paused, true);
  const pauseEpoch = runtime.snapshot().pause?.pauseEpoch;
  assert.equal(pauseEpoch, 1);

  const resumed = await runtime.invoke(request({ kind: "runtime.resume", expectedPauseEpoch: pauseEpoch ?? 0 }, "request-2"));
  assert.equal(resumed.status, "completed");
  assert.equal(runtime.snapshot().pause?.paused, false);

  const reconnect = await runtime.invoke(request({ kind: "runtime.snapshot" }, "request-3"));
  assert.equal(reconnect.status, "completed");
  assert.equal((reconnect.result as { pause?: { paused: boolean } }).pause?.paused, false);
});

test("WP-014 runtime.pause is executable while the Runtime is streaming", async () => {
  const arbiter = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: true,
    isCompacting: false,
  }));
  await arbiter.run(request({ kind: "runtime.pause" }), () => undefined);
  assert.equal(arbiter.currentLease, undefined);
});

test("WP-014 concurrent GUI/TUI destructive commands execute exactly one", async () => {
  const arbiter = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: false,
    isCompacting: false,
  }));
  let executions = 0;
  let release: (() => void) | undefined;
  const guiRun = arbiter.run(
    request({ kind: "session.drop" }, "request-gui"),
    () =>
      new Promise<void>((resolve) => {
        executions += 1;
        release = resolve;
      }),
    { surface: "gui", commandId: "destructive-gui" as CommandId },
  );
  assert.equal(arbiter.currentLease?.holder, "gui");
  assert.equal(arbiter.currentLease?.commandId, "destructive-gui");
  await assert.rejects(
    () =>
      arbiter.run(
        request({ kind: "session.drop" }, "request-tui"),
        () => {
          executions += 1;
        },
        {
          surface: "tui",
          commandId: "destructive-tui" as CommandId,
          precondition: () => {
            throw new StudioHostError("INTERACTION_REQUIRED", "Confirmation required");
          },
        },
      ),
    (error: unknown) => error instanceof StudioHostError && error.code === "COMMAND_BLOCKED",
  );
  assert.equal(executions, 1);
  release?.();
  await guiRun;
  assert.equal(arbiter.currentLease, undefined);
});

test("WP-014 control lease generation increments across exclusive acquisitions", async () => {
  const arbiter = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: false,
    isCompacting: false,
  }));
  let release: (() => void) | undefined;
  const first = arbiter.run(
    request({ kind: "session.drop" }, "request-lease-1"),
    () => new Promise<void>((resolve) => (release = resolve)),
    { surface: "gui", commandId: "lease-1" as CommandId },
  );
  const firstLease = arbiter.currentLease;
  release?.();
  await first;
  const second = arbiter.run(
    request({ kind: "runtime.pause" }, "request-lease-2"),
    () => new Promise<void>((resolve) => (release = resolve)),
    { surface: "tui", commandId: "lease-2" as CommandId },
  );
  const secondLease = arbiter.currentLease;
  release?.();
  await second;
  assert.ok(firstLease !== undefined);
  assert.ok(secondLease !== undefined);
  assert.equal(firstLease.holder, "gui");
  assert.equal(secondLease.holder, "tui");
  assert.equal(firstLease.generation, 1);
  assert.equal(secondLease.generation, 2);
  assert.equal(arbiter.currentLease, undefined);
});

test("WP-014 interaction ownership transfers and rejects stale or foreign claims", () => {
  const arbiter = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: false,
    isCompacting: false,
  }));
  const commandId = "interact-command" as CommandId;
  const opened = arbiter.openInteraction(commandId, "gui");
  assert.equal(opened.owner, "gui");
  assert.equal(opened.generation, 1);

  const claimed = arbiter.claimInteraction(commandId, "gui");
  assert.equal(claimed.owner, "gui");
  assert.equal(claimed.generation, 1);
  assert.throws(
    () => arbiter.claimInteraction(commandId, "tui"),
    (error: unknown) => error instanceof StudioHostError && error.code === "NOT_OWNER",
  );

  const transferred = arbiter.transferInteraction(opened.interactionId, "gui", "tui");
  assert.equal(transferred.owner, "tui");
  assert.equal(transferred.generation, 2);

  const transferredBack = arbiter.transferInteraction(opened.interactionId, "tui", "gui");
  assert.equal(transferredBack.owner, "gui");
  assert.equal(transferredBack.generation, 3);

  assert.throws(
    () => arbiter.assertInteraction(opened.interactionId, commandId, "gui", 2),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_STALE",
  );
  assert.throws(
    () => arbiter.assertInteraction(opened.interactionId, commandId, "tui", 3),
    (error: unknown) => error instanceof StudioHostError && error.code === "NOT_OWNER",
  );
  assert.throws(
    () => arbiter.assertInteraction(opened.interactionId, "other-command" as CommandId, "gui", 3),
    (error: unknown) => error instanceof StudioHostError && error.code === "NOT_OWNER",
  );
  arbiter.completeInteraction(opened.interactionId, commandId, "gui", 3);
  assert.throws(
    () => arbiter.completeInteraction(opened.interactionId, commandId, "gui", 3),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_STALE",
  );
});

test("WP-014 an active interaction blocks new exclusive commands", async () => {
  const arbiter = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: false,
    isCompacting: false,
  }));
  arbiter.openInteraction("blocked-command" as CommandId, "gui");
  await assert.rejects(
    () => arbiter.run(request({ kind: "session.drop" }), () => undefined),
    (error: unknown) => error instanceof StudioHostError && error.code === "COMMAND_BLOCKED",
  );
  await arbiter.run(request({ kind: "runtime.snapshot" }), () => undefined);
});

test("WP-014 a command precondition gates execution and releases the lease", async () => {
  const arbiter = new CommandArbiter(() => ({
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    isStreaming: false,
    isCompacting: false,
  }));
  let executed = false;
  await assert.rejects(
    () =>
      arbiter.run(
        request({ kind: "session.drop" }),
        () => {
          executed = true;
        },
        {
          surface: "gui",
          commandId: "precondition-command" as CommandId,
          precondition: () => {
            throw new StudioHostError("INTERACTION_REQUIRED", "Destructive confirmation required");
          },
        },
      ),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_REQUIRED",
  );
  assert.equal(executed, false);
  assert.equal(arbiter.currentLease, undefined);
});

test("WP-014 confirmation token consumes an identical operation exactly once", () => {
  const registry = new HostConfirmationRegistry();
  const token = registry.issue({ kind: "session.drop" }, "gui");
  registry.consume(token, { kind: "session.drop" }, "gui");
  assert.throws(
    () => registry.consume(token, { kind: "session.drop" }, "gui"),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_STALE",
  );
});

test("WP-014 confirmation token rejects a different operation or owner", () => {
  const registry = new HostConfirmationRegistry();
  const drop = registry.issue({ kind: "session.drop" }, "gui");
  assert.throws(
    () => registry.consume(drop, { kind: "session.clearContext" }, "gui"),
    (error: unknown) => error instanceof StudioHostError && error.code === "NOT_OWNER",
  );
  const owned = registry.issue({ kind: "session.drop" }, "gui");
  assert.throws(
    () => registry.consume(owned, { kind: "session.drop" }, "tui"),
    (error: unknown) => error instanceof StudioHostError && error.code === "NOT_OWNER",
  );
  registry.consume(owned, { kind: "session.drop" }, "gui");
});

test("WP-014 confirmation token expires after its TTL", () => {
  let now = 1000;
  const registry = new HostConfirmationRegistry({ ttlMs: 250, now: () => now });
  const token = registry.issue({ kind: "session.drop" }, "gui");
  now += 251;
  assert.throws(
    () => registry.consume(token, { kind: "session.drop" }, "gui"),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_STALE",
  );
});

test("WP-014 confirmation token binds lease generation and runtime epoch", () => {
  const registry = new HostConfirmationRegistry();
  const operation = { kind: "session.drop" } as const;
  const token = registry.issue(operation, "gui", { leaseGeneration: 3, runtimeEpoch: 7 });
  // same binding: ok
  registry.consume(token, operation, "gui", { leaseGeneration: 3, runtimeEpoch: 7 });
  // re-issue and try a stale generation / epoch: fail closed
  const gen = registry.issue(operation, "gui", { leaseGeneration: 3, runtimeEpoch: 7 });
  assert.throws(
    () => registry.consume(gen, operation, "gui", { leaseGeneration: 4, runtimeEpoch: 7 }),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_STALE",
  );
  const epoch = registry.issue(operation, "gui", { leaseGeneration: 3, runtimeEpoch: 7 });
  assert.throws(
    () => registry.consume(epoch, operation, "gui", { leaseGeneration: 3, runtimeEpoch: 8 }),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_STALE",
  );
  // A caller cannot bypass either binding by omitting it, and cannot attach
  // a binding to a token that was issued without one.
  const missingGeneration = registry.issue(operation, "gui", { leaseGeneration: 1, runtimeEpoch: 7 });
  assert.throws(
    () => registry.consume(missingGeneration, operation, "gui", { runtimeEpoch: 7 }),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_STALE",
  );
  const missingEpoch = registry.issue(operation, "gui", { leaseGeneration: 1, runtimeEpoch: 7 });
  assert.throws(
    () => registry.consume(missingEpoch, operation, "gui", { leaseGeneration: 1 }),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_STALE",
  );
  const unexpectedBinding = registry.issue(operation, "gui");
  assert.throws(
    () => registry.consume(unexpectedBinding, operation, "gui", { leaseGeneration: 1 }),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_STALE",
  );
});

test("WP-014 confirmation registry evicts the oldest token at capacity", () => {
  const registry = new HostConfirmationRegistry({ capacity: 2 });
  const first = registry.issue({ kind: "session.drop" }, "gui");
  registry.issue({ kind: "session.drop" }, "tui");
  registry.issue({ kind: "session.drop" }, "system");
  assert.throws(
    () => registry.consume(first, { kind: "session.drop" }, "gui"),
    (error: unknown) => error instanceof StudioHostError && error.code === "INTERACTION_STALE",
  );
});
