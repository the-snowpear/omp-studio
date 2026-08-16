import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CommandId,
  InteractionId,
  RemoteInteractionRequiredEvent,
  RuntimeEpoch,
  StateVersion,
  StudioEventEnvelope,
} from "@omp-studio/studio-protocol";
import { InteractionEventFanout } from "../src/interaction-events.js";

function envelope(
  event: RemoteInteractionRequiredEvent,
  eventSeq = 3,
): StudioEventEnvelope<RemoteInteractionRequiredEvent> {
  return {
    type: "studio.event",
    runtimeEpoch: 1 as RuntimeEpoch,
    eventSeq: eventSeq as StudioEventEnvelope["eventSeq"],
    stateVersion: 4 as StateVersion,
    occurredAt: "2026-08-15T13:00:00.000Z",
    event,
  };
}

test("interaction fan-out resolves the client requestId and isolates a throwing listener", () => {
  const fanout = new InteractionEventFanout();
  const received: string[] = [];
  fanout.onEvent(() => {
    throw new Error("boom");
  });
  fanout.onEvent((forward) => {
    received.push(forward.clientRequestId ?? "missing");
  });
  const forwarded = fanout.forward(
    envelope({
      kind: "interaction.required",
      owner: "gui",
      leaseGeneration: 1,
      request: {
        kind: "confirm",
        interactionId: "int-1" as InteractionId,
        commandId: "cmd-runtime" as CommandId,
        title: "Confirm",
        message: "Drop?",
      },
    }),
    (commandId) => (commandId === ("cmd-runtime" as CommandId) ? "client-req-1" : undefined),
  );
  assert.equal(forwarded, true);
  assert.deepEqual(received, ["client-req-1"]);
});

test("interaction fan-out does not buffer events for a later subscriber", () => {
  const fanout = new InteractionEventFanout();
  fanout.forward(
    envelope({
      kind: "interaction.required",
      owner: "gui",
      leaseGeneration: 1,
      request: {
        kind: "input",
        interactionId: "int-2" as InteractionId,
        commandId: "cmd-2" as CommandId,
        title: "Token",
      },
    }),
    () => "client-req-2",
  );
  const late: number[] = [];
  fanout.onEvent(() => {
    late.push(1);
  });
  assert.deepEqual(late, []);
});

test("non-interaction envelopes are ignored", () => {
  const fanout = new InteractionEventFanout();
  const received: number[] = [];
  fanout.onEvent(() => {
    received.push(1);
  });
  const forwarded = fanout.forward(
    {
      type: "studio.event",
      runtimeEpoch: 1 as RuntimeEpoch,
      eventSeq: 1 as StudioEventEnvelope["eventSeq"],
      stateVersion: 1 as StateVersion,
      occurredAt: "2026-08-15T13:00:00.000Z",
      event: { kind: "conversation.notice", sessionId: "s", notice: { code: "x", message: "y" } } as never,
    },
    () => "should-not-resolve",
  );
  assert.equal(forwarded, false);
  assert.deepEqual(received, []);
});
