import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEpoch, StateVersion, StudioEventEnvelope } from "@omp-studio/studio-protocol";
import { BtwEventFanout } from "../src/btw-events.js";

function envelope(event: unknown, eventSeq = 3): StudioEventEnvelope {
  return {
    type: "studio.event",
    runtimeEpoch: 1 as RuntimeEpoch,
    eventSeq: eventSeq as StudioEventEnvelope["eventSeq"],
    stateVersion: 4 as StateVersion,
    occurredAt: "2026-08-18T09:00:00.000Z",
    event: event as StudioEventEnvelope["event"],
  };
}

test("BTW fan-out forwards a well-formed snapshot and isolates a throwing listener", () => {
  const fanout = new BtwEventFanout();
  const received: string[] = [];
  fanout.onEvent(() => {
    throw new Error("boom");
  });
  fanout.onEvent((forward) => {
    received.push(forward.envelope.event.snapshot.ephemeralId);
  });
  const forwarded = fanout.forward(
    envelope({ kind: "btw.changed", snapshot: { ephemeralId: "ephemeral-1", status: "running", text: "partial" } }),
  );
  assert.equal(forwarded, true);
  assert.deepEqual(received, ["ephemeral-1"]);
});

test("BTW fan-out drops a snapshot that fails the contract parse", () => {
  const fanout = new BtwEventFanout();
  const received: number[] = [];
  fanout.onEvent(() => {
    received.push(1);
  });
  assert.equal(
    fanout.forward(envelope({ kind: "btw.changed", snapshot: { ephemeralId: "ephemeral-1", status: "pending", text: "" } })),
    false,
  );
  assert.equal(
    fanout.forward(envelope({ kind: "btw.changed", snapshot: { ephemeralId: "", status: "running", text: "" } })),
    false,
  );
  assert.deepEqual(received, []);
});

test("non-BTW envelopes are ignored", () => {
  const fanout = new BtwEventFanout();
  const received: number[] = [];
  fanout.onEvent(() => {
    received.push(1);
  });
  assert.equal(
    fanout.forward(
      envelope({ kind: "session.telemetry.changed", sessionId: "s", telemetry: { sessionId: "s" } }),
    ),
    false,
  );
  assert.deepEqual(received, []);
});

test("BTW fan-out does not buffer events for a later subscriber", () => {
  const fanout = new BtwEventFanout();
  fanout.forward(
    envelope({ kind: "btw.changed", snapshot: { ephemeralId: "ephemeral-1", status: "completed", text: "done" } }),
  );
  const late: number[] = [];
  fanout.onEvent(() => {
    late.push(1);
  });
  assert.deepEqual(late, []);
});
