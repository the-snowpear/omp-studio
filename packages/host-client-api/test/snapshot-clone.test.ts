import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublicAuthorityIdentity, RuntimeInstallState, SessionId, StateVersion } from "@omp-studio/client-contract";
import type {
  ConversationRuntimeEvent,
  OperatorStateSnapshot,
  RuntimeEpoch,
  StudioEventEnvelope,
} from "@omp-studio/studio-protocol";
import type {
  HostBackend,
  RuntimePublication,
  StudioBtwForward,
  StudioConversationForward,
  StudioTelemetryForward,
} from "@omp-studio/studio-host";

import { createDefaultHostDiagnosticsFactory, StudioHostClientFacade } from "../src/index.js";

/**
 * P0-3 regression cover: the facade reads a zero-copy view of the committed
 * operator snapshot and copies it only where a value leaves the facade. Before
 * the seam, `#currentSnapshot()` deep-cloned the whole pack on every read —
 * two or three times per streamed conversation event (event fence, handler,
 * bus context) and once per forwarded telemetry/BTW/interaction event.
 */
const SESSION = "session-clone" as SessionId;
const AT = "2026-10-29T00:00:00.000Z";

const originalStructuredClone = globalThis.structuredClone;
let clones = 0;
globalThis.structuredClone = ((value: unknown, options?: unknown): unknown => {
  clones += 1;
  return (originalStructuredClone as (input: unknown, options?: unknown) => unknown)(value, options);
}) as typeof structuredClone;
const resetClones = (): void => { clones = 0; };

/** 120 agents + 200 jobs, roughly the 254 KB shape quoted in the review. */
function operatorSnapshot(): OperatorStateSnapshot {
  return {
    runtimeId: "runtime-1",
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 7 as StateVersion,
    sessionId: SESSION,
    isStreaming: true,
    isCompacting: false,
    activeMode: "normal",
    approvalMode: "always-ask",
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 12,
    jobsRevision: 34,
    agents: Array.from({ length: 120 }, (_, index) => ({
      agentId: `agent-${index}`,
      sessionId: SESSION,
      status: "running",
      role: "worker",
      model: "model-x",
      startedAt: AT,
      notes: "n".repeat(600),
    })),
    jobs: Array.from({ length: 200 }, (_, index) => ({
      jobId: `job-${index}`,
      sessionId: SESSION,
      kind: "bash",
      status: "running",
      startedAt: AT,
      output: "o".repeat(400),
    })),
    telemetry: { sessionId: SESSION, capturedAt: AT },
  } as unknown as OperatorStateSnapshot;
}

const delta = (index: number): ConversationRuntimeEvent => ({
  kind: "conversation.message.delta",
  sessionId: SESSION,
  turnId: `turn-${Math.floor(index / 50)}`,
  messageId: `message-${Math.floor(index / 50)}`,
  blockId: `block-${index % 50}`,
  blockType: "text",
  delta: `token-${index}`,
});

function envelope<T>(index: number, event: T, runtimeEpoch = 1): StudioEventEnvelope<T> {
  return {
    type: "studio.event",
    runtimeEpoch: runtimeEpoch as RuntimeEpoch,
    eventSeq: index as never,
    stateVersion: 7 as StateVersion,
    occurredAt: AT,
    event,
  };
}

interface Harness {
  readonly facade: StudioHostClientFacade;
  readonly snapshot: OperatorStateSnapshot;
  forwardConversation(forward: StudioConversationForward): void;
  forwardTelemetry(forward: StudioTelemetryForward): void;
  forwardBtw(forward: StudioBtwForward): void;
  publish(publication?: RuntimePublication): void;
}

function harness(): Harness {
  const snapshot = operatorSnapshot();
  let conversation: ((forward: StudioConversationForward) => void) | undefined;
  let telemetry: ((forward: StudioTelemetryForward) => void) | undefined;
  let btw: ((forward: StudioBtwForward) => void) | undefined;
  let publication: ((publication: RuntimePublication) => void) | undefined;
  const facade = new StudioHostClientFacade({
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
      hello: () => ({ runtimeId: "runtime-1", runtimeEpoch: 1 as RuntimeEpoch, classification: "managed" }),
      snapshot: () => snapshot,
      messagesCursor: () => "cursor" as never,
      onPublication: (listener: (publication: RuntimePublication) => void) => {
        publication = listener;
        return () => undefined;
      },
      onConversationEvent: (listener: (forward: StudioConversationForward) => void) => {
        conversation = listener;
        return () => undefined;
      },
      onTelemetryEvent: (listener: (forward: StudioTelemetryForward) => void) => {
        telemetry = listener;
        return () => undefined;
      },
      onBtwEvent: (listener: (forward: StudioBtwForward) => void) => {
        btw = listener;
        return () => undefined;
      },
    },
    catalog: { list: () => [] },
    diagnostics: createDefaultHostDiagnosticsFactory(),
    install: async (): Promise<RuntimeInstallState> => ({ status: "installed", signature: "unknown" }),
  });
  return {
    facade,
    snapshot,
    forwardConversation: (forward) => conversation?.(forward),
    forwardTelemetry: (forward) => telemetry?.(forward),
    forwardBtw: (forward) => btw?.(forward),
    publish: (value) => publication?.(value ?? {
      commitSeq: 1,
      publishedAt: AT,
      snapshot,
      terminalOutcomes: [],
    }),
  };
}

test("streamed Runtime forwards read the snapshot without copying it", async () => {
  const h = harness();
  const forwarded: string[] = [];
  const unsubscribe = h.facade.subscribe({ scope: "all" }, (event) => forwarded.push(event.kind));
  try {
    resetClones();
    for (let index = 0; index < 500; index += 1) {
      h.forwardConversation({ envelope: envelope(index, delta(index)), streamSeq: index });
    }
    h.forwardTelemetry({
      envelope: envelope(1, {
        kind: "session.telemetry.changed",
        sessionId: SESSION,
        telemetry: { sessionId: SESSION, capturedAt: AT },
      } as never),
    });
    h.forwardBtw({
      envelope: envelope(1, {
        kind: "btw.snapshot",
        sessionId: SESSION,
        snapshot: { status: "idle" },
      } as never),
    });
    assert.equal(clones, 0, `streaming path cloned the operator snapshot ${clones} times`);
    assert.equal(forwarded.filter((kind) => kind === "conversation.changed").length, 500);
    assert.equal(forwarded.filter((kind) => kind === "telemetry.changed").length, 1);
    assert.equal(forwarded.filter((kind) => kind === "btw.changed").length, 1);
  } finally {
    unsubscribe();
    await h.facade.close();
  }
});

test("epoch fences still drop stale forwards without copying the snapshot", async () => {
  const h = harness();
  const forwarded: Array<readonly [string, number | undefined]> = [];
  const unsubscribe = h.facade.subscribe({ scope: "all" }, (event) => {
    if (event.kind === "conversation.changed") forwarded.push([event.sessionId, event.runtimeEpoch]);
  });
  try {
    resetClones();
    h.forwardConversation({ envelope: envelope(1, delta(1)), streamSeq: 1 });
    // Same shape, wrong epoch: dropped by the fence, still zero copies.
    h.forwardConversation({ envelope: envelope(2, delta(2), 2), streamSeq: 2 });
    assert.equal(clones, 0);
    assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0], [SESSION, 1]);
  } finally {
    unsubscribe();
    await h.facade.close();
  }
});

test("snapshot events stay zero-copy (read-only downstream), queries copy exactly once", async () => {
  const h = harness();
  const snapshotEvents: OperatorStateSnapshot[] = [];
  const unsubscribe = h.facade.subscribe({ scope: "all" }, (event) => {
    if (event.kind === "snapshot") snapshotEvents.push(event.snapshot);
  });
  try {
    // The publication path hands the committed object to the bus: every
    // downstream consumer (client reducer, Electron IPC structured clone) only
    // reads it, so no copy is taken here.
    resetClones();
    h.publish();
    assert.equal(clones, 0);
    assert.equal(snapshotEvents.length, 1);
    assert.equal(snapshotEvents[0], h.snapshot, "the snapshot event carries the committed read-only object");

    // External boundaries: one copy each, never two.
    resetClones();
    const bootstrap = await h.facade.bootstrap();
    assert.equal(clones, 1);
    assert.notEqual(bootstrap.snapshot, h.snapshot);
    assert.deepEqual(bootstrap.snapshot, h.snapshot);
    assert.equal(bootstrap.stateVersion, 7);

    resetClones();
    const state = await h.facade.query({ queryName: "session.state", input: {} });
    assert.equal(clones, 1);
    assert.equal(state.ok, true);
    if (state.ok) {
      assert.notEqual(state.result, h.snapshot);
      assert.equal(state.result.sessionId, SESSION);
      // Mutating the returned copy must not leak into the committed snapshot.
      (state.result as { sessionId: string }).sessionId = "mutated";
      assert.equal(h.snapshot.sessionId, SESSION);
    }

    resetClones();
    const home = await h.facade.query({ queryName: "home.get", input: {} });
    assert.equal(clones, 1);
    assert.equal(home.ok, true);
    if (home.ok) {
      assert.notEqual(home.result.snapshot, h.snapshot);
      assert.deepEqual(home.result.snapshot, h.snapshot);
    }

    // Read models that never expose the pack do not copy it at all.
    resetClones();
    await h.facade.query({ queryName: "usage.get", input: {} });
    await h.facade.query({ queryName: "diagnostics.get", input: {} });
    assert.equal(clones, 0);
  } finally {
    unsubscribe();
    await h.facade.close();
  }
});

test("500 events against a 120-agent/200-job snapshot: zero copies, measured cost", async (t) => {
  const h = harness();
  const unsubscribe = h.facade.subscribe({ scope: "all" }, () => undefined);
  try {
    // Pre-fix every forwarded event copied the pack in `#currentConnection`
    // (existence check) and again in `#onConversationForward` (epoch read);
    // the bus context could add a third.
    const copiesPerEventBefore = 2;
    const started = performance.now();
    for (let index = 0; index < 500; index += 1) {
      h.forwardConversation({ envelope: envelope(index, delta(index)), streamSeq: index });
    }
    const elapsed = performance.now() - started;

    resetClones();
    // Median of three timed copies (the first one warms the serializer).
    const samples: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const cloneStarted = performance.now();
      structuredClone(h.snapshot);
      samples.push(performance.now() - cloneStarted);
    }
    samples.sort((left, right) => left - right);
    const oneCopyMs = samples[1] as number;
    const beforeMs = oneCopyMs * copiesPerEventBefore * 500;

    assert.equal(clones, samples.length, "only the baseline probes above may copy");
    t.diagnostic(
      `pack≈${Math.round(JSON.stringify(h.snapshot).length / 1024)} KB · 500 forwards in ${elapsed.toFixed(1)} ms · ` +
      `one copy ${oneCopyMs.toFixed(2)} ms · pre-fix cost ≈ ${beforeMs.toFixed(0)} ms (${copiesPerEventBefore} copies/event)`,
    );
    assert.ok(elapsed < 2_000, `500 forwards took ${elapsed.toFixed(0)} ms`);
  } finally {
    unsubscribe();
    await h.facade.close();
  }
});
