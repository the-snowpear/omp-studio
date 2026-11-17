import assert from "node:assert/strict";
import { test } from "node:test";

import type { HostInteractionRespondInput } from "@omp-studio/host-client-api";
import type { StudioInteractionForward, StudioRuntimeSessionController } from "@omp-studio/studio-host";
import type { StudioOperation } from "@omp-studio/studio-protocol";
import type { DesktopRuntimeSession } from "../src/host-composition.js";
import { DesktopInteractionHost } from "../src/interaction-host.js";

function fixture({ reconnect = false, configuration = true, failOnce = false } = {}) {
  let listener: ((event: StudioInteractionForward) => void) | undefined;
  const calls: StudioOperation[] = [];
  const pending = {
    request: { kind: "approval", approvalType: configuration ? "configuration" : "tool", interactionId: "test-approval", commandId: "test-command", title: "Test approval", details: {} },
    owner: "gui", leaseGeneration: 1,
  };
  const controller = {
    publication: () => ({ snapshot: { runtimeEpoch: 1, stateVersion: 1 } }),
    onInteractionEvent: (fn: (event: StudioInteractionForward) => void) => { listener = fn; return () => {}; },
    pendingInteraction: () => reconnect ? pending : undefined,
    invoke: async ({ operation }: { operation: StudioOperation }) => {
      calls.push(operation);
      if (failOnce) { failOnce = false; throw new Error("Test transport failure"); }
      return { status: "completed" };
    },
  } as unknown as StudioRuntimeSessionController;
  const host = new DesktopInteractionHost({ current: { controller, hello: () => ({}) } as unknown as DesktopRuntimeSession });
  host.attach(controller);
  if (!reconnect) listener!({ envelope: { event: { kind: "interaction.required", ...pending } } } as StudioInteractionForward);
  const respond = (value?: HostInteractionRespondInput["value"], decision: "submit" | "cancel" = "submit") => host.respond({
    interactionId: "test-approval" as HostInteractionRespondInput["interactionId"], leaseGeneration: 1, decision, ...(value === undefined ? {} : { value }),
  });
  return { host, calls, respond };
}

for (const reconnect of [false, true]) {
  for (const value of ["once", "session"]) {
    test(`configuration approval ${value} reaches Runtime after ${reconnect ? "reattachment" : "a live event"}`, async () => {
      const f = fixture({ reconnect });
      try {
        await f.respond(value);
        assert.deepEqual(f.calls, [{ kind: "interaction.respond", interactionId: "test-approval", commandId: "test-command", decision: "submit", value, leaseGeneration: 1 }]);
        await assert.rejects(f.respond(value), { code: "INTERACTION_STALE" });
        assert.equal(f.calls.length, 1);
      } finally { f.host.clear(); }
    });
  }
}

test("a failed configuration response can be explicitly retried with the chosen scope", async () => {
  const f = fixture({ failOnce: true });
  try {
    await assert.rejects(f.respond("once"), /Test transport failure/);
    await f.respond("session");
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1], { kind: "interaction.respond", interactionId: "test-approval", commandId: "test-command", decision: "submit", value: "session", leaseGeneration: 1 });
  } finally { f.host.clear(); }
});

test("rejecting configuration still cancels and ordinary tool approval still accepts true", async () => {
  const config = fixture(), tool = fixture({ configuration: false });
  try {
    await config.respond(undefined, "cancel");
    assert.deepEqual(config.calls[0], { kind: "interaction.respond", interactionId: "test-approval", commandId: "test-command", decision: "cancel", leaseGeneration: 1 });
    await tool.respond(true);
    assert.deepEqual(tool.calls[0], { kind: "interaction.respond", interactionId: "test-approval", commandId: "test-command", decision: "submit", value: true, leaseGeneration: 1 });
  } finally { config.host.clear(); tool.host.clear(); }
});
