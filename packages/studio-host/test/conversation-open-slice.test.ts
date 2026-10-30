import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ConversationRuntimeEvent,
  RuntimeEpoch,
  SessionId,
  StateVersion,
  StudioEventEnvelope,
} from "@omp-studio/studio-protocol";

import { ConversationCoalescer } from "../src/conversation-coalescer.js";
import { ConversationEventFanout, type StudioConversationForward } from "../src/conversation-events.js";
import { StudioBridgeClient } from "../src/bridge-client.js";
import { CommandLedger } from "../src/command-ledger.js";
import { StudioRuntimeSessionController } from "../src/runtime-session-controller.js";

const SESSION = "session-slice" as SessionId;
const OTHER = "session-other" as SessionId;
const AT = "2026-10-29T00:00:00.000Z";
const SLICE = 8;

/** Manual event-loop turn: nothing is delivered until `tick()` runs it. */
function manualScheduler() {
  let pending: Array<() => void> = [];
  return {
    schedule: (callback: () => void): unknown => { pending.push(callback); return callback; },
    cancelSchedule: (handle: unknown): void => { pending = pending.filter((callback) => callback !== handle); },
    get pendingCount(): number { return pending.length; },
    tick(turns = 1): void {
      for (let turn = 0; turn < turns; turn += 1) {
        const batch = pending;
        pending = [];
        for (const callback of batch) callback();
      }
    },
  };
}

function harness(options: { readonly sliceEvents?: number } = {}) {
  const scheduler = manualScheduler();
  const fanout = new ConversationEventFanout({
    incrementalToolReplay: true,
    backgroundCoalescing: true,
    delivery: {
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
      sliceEvents: options.sliceEvents ?? SLICE,
      // Count-only budget: the test must not depend on wall-clock timing.
      sliceMs: 0,
      now: () => 0,
    },
  });
  const delivered: StudioConversationForward[] = [];
  fanout.onEvent((event) => delivered.push(event));
  let seq = 0;
  const send = (event: ConversationRuntimeEvent, epoch = 1): boolean => fanout.forward({
    type: "studio.event",
    runtimeEpoch: epoch as RuntimeEpoch,
    stateVersion: 1 as StateVersion,
    eventSeq: ++seq,
    occurredAt: AT,
    event,
  } as StudioEventEnvelope);
  return { fanout, delivered, scheduler, send };
}

/** A delta for a fresh block is its own coalescing group: one pending envelope each. */
const freshDelta = (index: number, session = SESSION): ConversationRuntimeEvent => ({
  kind: "conversation.message.delta",
  sessionId: session,
  turnId: "turn",
  messageId: "message",
  blockId: `block-${index}`,
  blockType: "text",
  delta: `t${index}`,
});

function streamSeqs(events: readonly StudioConversationForward[]): number[] {
  return events.map((event) => event.streamSeq);
}

function assertContiguous(events: readonly StudioConversationForward[], session: SessionId): void {
  const scoped = events.filter((event) => event.envelope.event.sessionId === session);
  assert.deepEqual(streamSeqs(scoped), Array.from({ length: scoped.length }, (_, index) => index + 1));
}

test("conversation.open returns after one bounded slice and the rest follow in order", () => {
  const { fanout, delivered, scheduler, send } = harness();
  fanout.setVisibleSessions(new Set());
  for (let index = 0; index < 400; index += 1) send(freshDelta(index));
  assert.equal(delivered.length, 0, "all deltas stay coalesced while the session is hidden");

  const opened = fanout.snapshot(SESSION);
  assert.equal(opened.status, "complete");
  assert.deepEqual(streamSeqs(delivered), Array.from({ length: SLICE }, (_, index) => index + 1));
  assert.equal(opened.watermark, SLICE);
  assert.deepEqual(opened.events.map((event) => event.streamSeq), streamSeqs(delivered));
  assert.equal(scheduler.pendingCount, 1, "the rest is owned by one scheduled slice");

  // Every following turn emits at most one slice: the bulk flush never lands in
  // a single task.
  const perTurn: number[] = [];
  let previous = delivered.length;
  while (delivered.length < 400) {
    scheduler.tick();
    perTurn.push(delivered.length - previous);
    previous = delivered.length;
    assert.ok(perTurn.at(-1)! <= SLICE, `turn emitted ${perTurn.at(-1)} > ${SLICE}`);
    assert.ok(perTurn.at(-1)! > 0, "a scheduled turn must make progress");
  }
  assert.equal(scheduler.pendingCount, 0);
  assert.deepEqual(streamSeqs(delivered), Array.from({ length: 400 }, (_, index) => index + 1));
  assert.equal(new Set(streamSeqs(delivered)).size, 400, "no duplicate delivery");
  assertContiguous(delivered, SESSION);
  // Every envelope is delivered exactly once, in stream order.
  assert.deepEqual(
    delivered.map((event) => event.envelope.event.kind === "conversation.message.delta" ? event.envelope.event.delta : ""),
    Array.from({ length: 400 }, (_, index) => `t${index}`),
  );
  assert.equal(fanout.snapshot(SESSION).watermark, 400);
  fanout.dispose();
  assert.equal(scheduler.pendingCount, 0);
});

test("opening A then B never attributes A's tail events to B", () => {
  const { fanout, delivered, scheduler, send } = harness();
  fanout.setVisibleSessions(new Set());
  for (let index = 0; index < 40; index += 1) send(freshDelta(index, SESSION));
  for (let index = 0; index < 40; index += 1) send(freshDelta(index, OTHER));

  const openedA = fanout.snapshot(SESSION);
  assert.equal(openedA.watermark, SLICE);
  const openedB = fanout.snapshot(OTHER);
  // A's queued tail owns the pending slice; B materializes behind it and its
  // watermark stays honest (0 delivered so far).
  assert.equal(openedB.watermark, 0);
  assert.deepEqual(openedB.events, []);

  scheduler.tick(20);
  assert.equal(delivered.length, 80);
  assertContiguous(delivered, SESSION);
  assertContiguous(delivered, OTHER);
  assert.equal(delivered.filter((event) => event.envelope.event.sessionId === SESSION).length, 40);
  assert.equal(delivered.filter((event) => event.envelope.event.sessionId === OTHER).length, 40);
  // Each session's events only ever carry their own identity.
  for (const event of delivered) {
    const sessionId = event.envelope.event.sessionId;
    assert.ok(sessionId === SESSION || sessionId === OTHER);
  }
  fanout.dispose();
});

test("an epoch change drops materialized slices from the old epoch", () => {
  const { fanout, delivered, scheduler, send } = harness();
  fanout.setVisibleSessions(new Set());
  for (let index = 0; index < 40; index += 1) send(freshDelta(index));
  fanout.snapshot(SESSION);
  assert.equal(delivered.length, SLICE);
  assert.ok(scheduler.pendingCount > 0);

  // A new runtime epoch must not deliver the 32 envelopes materialized from
  // epoch 1: they were dropped with the reset, not queued after the new epoch.
  send(freshDelta(999), 2);
  const epoch1 = delivered.filter((event) => event.envelope.runtimeEpoch === 1);
  assert.equal(epoch1.length, SLICE);
  assert.deepEqual(
    epoch1.map((event) => event.envelope.event.kind === "conversation.message.delta" ? event.envelope.event.blockId : ""),
    Array.from({ length: SLICE }, (_, index) => `block-${index}`),
  );
  // The epoch-2 forward is a fresh baseline (a nanosecond-old `resetEpoch`
  // also drops the visibility policy, so it takes the immediate path).
  assert.equal(delivered.at(-1)!.envelope.runtimeEpoch, 2);
  assert.equal(delivered.at(-1)!.streamSeq, 1);
  scheduler.tick(20);
  assert.equal(delivered.length, SLICE + 1, "no old-epoch tail after the reset");
  fanout.dispose();
});

test("a throwing consumer does not wedge the queue", () => {
  const delivered: string[] = [];
  let calls = 0;
  const coalescer = new ConversationCoalescer({
    emit: (envelope) => {
      calls += 1;
      const event = envelope.event;
      const label = event.kind === "conversation.message.delta" ? event.blockId : event.kind;
      if (calls === 2) throw new Error("consumer failed");
      delivered.push(label);
    },
    sliceEvents: SLICE,
    sliceMs: 0,
    now: () => 0,
  });
  coalescer.setVisibleSessions(new Set());
  for (let index = 0; index < 5; index += 1) coalescer.push(envelopeFor(freshDelta(index)));

  assert.throws(() => coalescer.flush(), /consumer failed/);
  assert.deepEqual(delivered, ["block-0"], "the failing envelope is consumed, the rest is kept");
  coalescer.flush();
  assert.deepEqual(delivered, ["block-0", "block-2", "block-3", "block-4"]);
  coalescer.dispose();
});

test("a scheduled slice that throws keeps delivering later turns", () => {
  const delivered: string[] = [];
  const scheduler = manualScheduler();
  let calls = 0;
  const coalescer = new ConversationCoalescer({
    emit: (envelope) => {
      calls += 1;
      const event = envelope.event;
      const label = event.kind === "conversation.message.delta" ? event.blockId : event.kind;
      if (calls === 2) throw new Error("consumer failed");
      delivered.push(label);
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
    sliceEvents: 1,
    sliceMs: 0,
    now: () => 0,
  });
  coalescer.setVisibleSessions(new Set());
  for (let index = 0; index < 3; index += 1) coalescer.push(envelopeFor(freshDelta(index)));
  coalescer.flushSliced();
  assert.deepEqual(delivered, ["block-0"]);
  scheduler.tick(); // second envelope throws inside the scheduled turn
  scheduler.tick();
  assert.deepEqual(delivered, ["block-0", "block-2"]);
  coalescer.dispose();
  assert.equal(scheduler.pendingCount, 0);
});

test("conversation.open does not wait for the whole backlog (controller seam)", async () => {
  const scheduler = manualScheduler();
  let onEvent: ((event: StudioEventEnvelope) => void) | undefined;
  let eventSeq = 0;
  const bridge = {
    onProjectionChanged: () => () => undefined,
    onEvent: (listener: (event: StudioEventEnvelope) => void) => { onEvent = listener; return () => undefined; },
    onResyncRequired: () => () => undefined,
    projectionSnapshot: () => ({ sessionId: SESSION, runtimeEpoch: 1 }),
    readTranscript: async () => ({
      runtimeEpoch: 1 as RuntimeEpoch,
      sessionId: SESSION,
      branchLeafId: null,
      items: [],
      headCursor: "head" as never,
      hasMoreBefore: false,
    }),
  } as unknown as StudioBridgeClient;
  const controller = new StudioRuntimeSessionController(bridge, new CommandLedger(), undefined, {
    backgroundCoalescing: true,
    delivery: { schedule: scheduler.schedule, cancelSchedule: scheduler.cancelSchedule, sliceEvents: SLICE, sliceMs: 0, now: () => 0 },
  });
  const delivered: number[] = [];
  controller.onConversationEvent((event) => delivered.push(event.streamSeq));
  controller.setConversationVisibleSessions(new Set());
  for (let index = 0; index < 300; index += 1) {
    onEvent?.({
      type: "studio.event",
      runtimeEpoch: 1 as RuntimeEpoch,
      stateVersion: 1 as StateVersion,
      eventSeq: ++eventSeq,
      occurredAt: AT,
      event: freshDelta(index),
    } as StudioEventEnvelope);
  }
  try {
    const opened = await controller.openConversation({ target: { kind: "session", sessionId: SESSION } });
    assert.equal(opened.live.status, "complete");
    if (opened.live.status === "complete") {
      assert.equal(opened.live.watermark, SLICE);
      assert.deepEqual(opened.live.events.map((event) => event.streamSeq), Array.from({ length: SLICE }, (_, index) => index + 1));
    }
    assert.deepEqual(delivered, Array.from({ length: SLICE }, (_, index) => index + 1));
    scheduler.tick(40);
    assert.equal(delivered.length, 300);
    assert.deepEqual(delivered, Array.from({ length: 300 }, (_, index) => index + 1));
  } finally {
    controller.dispose();
    assert.equal(scheduler.pendingCount, 0);
  }
});

test("a non-conversation barrier still drains the backlog before it", () => {
  const { fanout, delivered, scheduler, send } = harness();
  fanout.setVisibleSessions(new Set());
  for (let index = 0; index < 40; index += 1) send(freshDelta(index));
  assert.equal(delivered.length, 0);

  // An approval is not a conversation envelope: the fan-out flushes the text
  // backlog first so the approval can never overtake it.
  const consumed = send({ kind: "interaction.required", request: { commandId: "c" } } as never);
  assert.equal(consumed, false);
  assert.equal(delivered.length, 40, "barrier drains the whole backlog in this turn");
  assert.equal(scheduler.pendingCount, 0);
  assertContiguous(delivered, SESSION);
  fanout.dispose();
});

test("the default scheduler really yields the event loop between slices", async () => {
  const fanout = new ConversationEventFanout({
    incrementalToolReplay: true,
    backgroundCoalescing: true,
    // Defaults: setImmediate continuation, 64 envelopes / 4 ms per slice.
    delivery: { sliceEvents: 32, sliceMs: 0 },
  });
  const delivered: number[] = [];
  fanout.onEvent((event) => delivered.push(event.streamSeq));
  fanout.setVisibleSessions(new Set());
  for (let index = 0; index < 500; index += 1) {
    fanout.forward(envelopeFor(freshDelta(index)));
  }
  try {
    const opened = fanout.snapshot(SESSION);
    assert.equal(opened.watermark, 32, "open returns after one bounded slice");
    assert.equal(delivered.length, 32);

    let turns = 0;
    while (delivered.length < 500 && turns < 1_000) {
      await new Promise((resolve) => setImmediate(resolve));
      turns += 1;
    }
    assert.ok(turns <= Math.ceil(500 / 32) + 2, `needed ${turns} turns`);
    assert.deepEqual(delivered, Array.from({ length: 500 }, (_, index) => index + 1));
  } finally {
    fanout.dispose();
  }
});

function envelopeFor(event: ConversationRuntimeEvent): StudioEventEnvelope<ConversationRuntimeEvent> {
  return { type: "studio.event", runtimeEpoch: 1 as RuntimeEpoch, stateVersion: 1 as StateVersion, eventSeq: 1 as never, occurredAt: AT, event };
}
