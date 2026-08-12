import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CommandId,
  InteractionId,
  RemoteInteractionRequest,
  RemoteInteractionRequiredEvent,
  RuntimeEpoch,
  StateVersion,
  StudioOperation,
} from "@omp-studio/studio-protocol";
import {
  CommandArbiter,
  HostConfirmationRegistry,
  RemoteInteractionAdapter,
  StudioHostError,
  type ArbiterState,
  type RemoteInteractionInvokeResult,
} from "../src/index.js";

const commandId = "command-1" as CommandId;
const interactionId = "interaction-1" as InteractionId;

function makeArbiter(): CommandArbiter {
  return new CommandArbiter(
    (): ArbiterState => ({
      runtimeEpoch: 1 as RuntimeEpoch,
      stateVersion: 1 as StateVersion,
      isStreaming: false,
      isCompacting: false,
    }),
  );
}

function confirmRequest(destructive = false): RemoteInteractionRequest {
  return {
    kind: "confirm",
    interactionId,
    commandId,
    title: "Confirm drop",
    message: "Drop the active session?",
    ...(destructive ? { destructive: true } : {}),
  };
}

function approvalRequest(): RemoteInteractionRequest {
  return {
    kind: "approval",
    interactionId,
    commandId,
    title: "Approve publish",
    approvalType: "publish",
    details: { target: "production" },
  };
}

function inputRequest(): RemoteInteractionRequest {
  return {
    kind: "input",
    interactionId,
    commandId,
    title: "Token needed",
    placeholder: "super-secret-placeholder",
    secret: true,
  };
}

function eventFor(
  request: RemoteInteractionRequest,
  owner: "gui" | "tui" = "gui",
  leaseGeneration = 1,
): RemoteInteractionRequiredEvent {
  return { kind: "interaction.required", request, owner, leaseGeneration };
}

function isHostError(error: unknown, code: string): boolean {
  return error instanceof StudioHostError && error.code === code;
}

test("M4 adapter adopts the exact Runtime lease and respond completes the interaction", async () => {
  const calls: StudioOperation[] = [];
  const arbiter = makeArbiter();
  const adapter = new RemoteInteractionAdapter(
    arbiter,
    new HostConfirmationRegistry(),
    async (operation) => {
      calls.push(operation);
      return { status: "accepted" };
    },
  );

  const adopted = adapter.adopt(eventFor(confirmRequest(), "gui", 5));
  assert.equal(adopted.interactionId, interactionId);
  assert.equal(adopted.commandId, commandId);
  assert.equal(adopted.owner, "gui");
  assert.equal(adopted.generation, 5);
  assert.equal(adopted.request.kind, "confirm");
  assert.deepEqual(adapter.pending(), adopted);

  await adapter.respond({ interactionId, commandId, decision: "submit", value: true, owner: "gui" });
  assert.deepEqual(calls, [
    { kind: "interaction.respond", interactionId, commandId, decision: "submit", value: true },
  ]);
  assert.equal(adapter.pending(), undefined);
  assert.throws(
    () => arbiter.assertInteraction(interactionId, commandId, "gui", 5),
    (error: unknown) => isHostError(error, "INTERACTION_STALE"),
  );
});

test("M4 cancel decision dispatches and completes the interaction", async () => {
  const calls: StudioOperation[] = [];
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async (operation) => {
      calls.push(operation);
      return { status: "completed" };
    },
  );
  adapter.adopt(eventFor(confirmRequest()));
  await adapter.respond({ interactionId, commandId, decision: "cancel", owner: "gui" });
  assert.deepEqual(calls, [{ kind: "interaction.respond", interactionId, commandId, decision: "cancel" }]);
  assert.equal(adapter.pending(), undefined);
});

test("M4 destructive confirm requires a one-shot confirmation token", async () => {
  const calls: StudioOperation[] = [];
  const registry = new HostConfirmationRegistry();
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    registry,
    async (operation) => {
      calls.push(operation);
      return { status: "accepted" };
    },
  );

  adapter.adopt(eventFor(confirmRequest(true)));
  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui" }),
    (error: unknown) => isHostError(error, "INVALID_ARGUMENT"),
  );
  assert.equal(calls.length, 0);
  assert.ok(adapter.pending() !== undefined);

  const submitOperation = { kind: "interaction.respond", interactionId, commandId, decision: "submit" } as const;
  const token = registry.issue(submitOperation, "gui");
  await adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui", confirmationToken: token });
  assert.equal(adapter.pending(), undefined);
  assert.equal(calls.length, 1);

  // Replaying the consumed token on a new interaction fails closed.
  const interactionId2 = "interaction-2" as InteractionId;
  const commandId2 = "command-2" as CommandId;
  const request2: RemoteInteractionRequest = { ...confirmRequest(true), interactionId: interactionId2, commandId: commandId2 };
  adapter.adopt(eventFor(request2));
  await assert.rejects(
    () =>
      adapter.respond({
        interactionId: interactionId2,
        commandId: commandId2,
        decision: "submit",
        owner: "gui",
        confirmationToken: token,
      }),
    (error: unknown) => isHostError(error, "INTERACTION_STALE"),
  );
  assert.equal(calls.length, 1);
  assert.ok(adapter.pending() !== undefined);

  // A token owned by another surface is rejected.
  const tuiToken = registry.issue(submitOperation, "tui");
  await assert.rejects(
    () =>
      adapter.respond({
        interactionId: interactionId2,
        commandId: commandId2,
        decision: "submit",
        owner: "gui",
        confirmationToken: tuiToken,
      }),
    (error: unknown) => isHostError(error, "NOT_OWNER"),
  );
  assert.equal(calls.length, 1);

  // A token bound to a different respond operation is rejected.
  const valueToken = registry.issue(
    { kind: "interaction.respond", interactionId: interactionId2, commandId: commandId2, decision: "submit", value: 42 },
    "gui",
  );
  await assert.rejects(
    () =>
      adapter.respond({
        interactionId: interactionId2,
        commandId: commandId2,
        decision: "submit",
        owner: "gui",
        confirmationToken: valueToken,
      }),
    (error: unknown) => isHostError(error, "NOT_OWNER"),
  );
  assert.equal(calls.length, 1);

  // A fresh token bound to the exact operation authorizes the submit.
  const freshToken = registry.issue(
    { kind: "interaction.respond", interactionId: interactionId2, commandId: commandId2, decision: "submit" },
    "gui",
  );
  await adapter.respond({
    interactionId: interactionId2,
    commandId: commandId2,
    decision: "submit",
    owner: "gui",
    confirmationToken: freshToken,
  });
  assert.equal(adapter.pending(), undefined);

  // Cancelling a destructive confirm needs no authorization.
  adapter.adopt(eventFor(confirmRequest(true)));
  await adapter.respond({ interactionId, commandId, decision: "cancel", owner: "gui" });
  assert.equal(adapter.pending(), undefined);
  assert.deepEqual(calls, [
    { kind: "interaction.respond", interactionId, commandId, decision: "submit" },
    { kind: "interaction.respond", interactionId: interactionId2, commandId: commandId2, decision: "submit" },
    { kind: "interaction.respond", interactionId, commandId, decision: "cancel" },
  ]);
});

test("M4 approval submits require a confirmation token", async () => {
  const calls: StudioOperation[] = [];
  const registry = new HostConfirmationRegistry();
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    registry,
    async (operation) => {
      calls.push(operation);
      return { status: "accepted" };
    },
  );
  adapter.adopt(eventFor(approvalRequest()));
  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui" }),
    (error: unknown) => isHostError(error, "INVALID_ARGUMENT"),
  );
  const token = registry.issue(
    { kind: "interaction.respond", interactionId, commandId, decision: "submit" },
    "gui",
  );
  await adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui", confirmationToken: token });
  assert.equal(adapter.pending(), undefined);
  assert.equal(calls.length, 1);
});

test("M4 respond rejects wrong owner, stale ids, and duplicates", async () => {
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async () => ({ status: "accepted" }),
  );

  adapter.adopt(eventFor(confirmRequest()));
  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "submit", owner: "tui" }),
    (error: unknown) => isHostError(error, "NOT_OWNER"),
  );
  await assert.rejects(
    () => adapter.respond({ interactionId: "interaction-other" as InteractionId, commandId, decision: "submit", owner: "gui" }),
    (error: unknown) => isHostError(error, "INTERACTION_STALE"),
  );

  await adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui" });
  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui" }),
    (error: unknown) => isHostError(error, "INTERACTION_STALE"),
  );

  adapter.adopt(eventFor(confirmRequest()));
  await adapter.respond({ interactionId, commandId, decision: "cancel", owner: "gui" });
  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "cancel", owner: "gui" }),
    (error: unknown) => isHostError(error, "INTERACTION_STALE"),
  );
});

test("M4 concurrent respond attempts fail closed while one is in flight", async () => {
  const calls: StudioOperation[] = [];
  let release!: (result: RemoteInteractionInvokeResult) => void;
  const gate = new Promise<RemoteInteractionInvokeResult>((resolve) => {
    release = resolve;
  });
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async (operation) => {
      calls.push(operation);
      return gate;
    },
  );
  adapter.adopt(eventFor(confirmRequest()));
  const first = adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui" });
  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui" }),
    (error: unknown) => isHostError(error, "COMMAND_BLOCKED"),
  );
  assert.equal(calls.length, 1);
  release({ status: "accepted" });
  await first;
  assert.equal(adapter.pending(), undefined);
});

test("M4 transferToTui is explicit, dispatches tui.transfer, and advances ownership", async () => {
  const calls: StudioOperation[] = [];
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async (operation) => {
      calls.push(operation);
      return { status: "accepted" };
    },
  );
  adapter.adopt(eventFor(confirmRequest(), "gui", 1));

  const updated = await adapter.transferToTui();
  assert.deepEqual(calls, [{ kind: "tui.transfer", commandId, interactionId }]);
  assert.equal(updated.owner, "tui");
  assert.equal(updated.generation, 2);
  const pending = adapter.pending();
  assert.equal(pending?.owner, "tui");
  assert.equal(pending?.generation, 2);

  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui" }),
    (error: unknown) => isHostError(error, "NOT_OWNER"),
  );
  await assert.rejects(
    () => adapter.transferToTui(),
    (error: unknown) => isHostError(error, "NOT_OWNER"),
  );

  await adapter.respond({ interactionId, commandId, decision: "submit", owner: "tui" });
  assert.equal(adapter.pending(), undefined);
});

test("M4 transfer invoke failure leaves gui ownership unchanged", async () => {
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async (operation) => {
      if (operation.kind === "tui.transfer") throw new Error("transport failed");
      return { status: "accepted" };
    },
  );
  adapter.adopt(eventFor(confirmRequest(), "gui", 1));
  await assert.rejects(() => adapter.transferToTui(), /transport failed/);
  const pending = adapter.pending();
  assert.equal(pending?.owner, "gui");
  assert.equal(pending?.generation, 1);
  await adapter.respond({ interactionId, commandId, decision: "cancel", owner: "gui" });
  assert.equal(adapter.pending(), undefined);
});

test("M4 invoke failure keeps the interaction pending and retryable", async () => {
  const calls: StudioOperation[] = [];
  let fail = true;
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async (operation) => {
      calls.push(operation);
      if (fail) throw new Error("transport failed");
      return { status: "accepted" };
    },
  );
  adapter.adopt(eventFor(confirmRequest()));
  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui" }),
    /transport failed/,
  );
  assert.equal(calls.length, 1);
  assert.ok(adapter.pending() !== undefined);

  fail = false;
  await adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui" });
  assert.equal(adapter.pending(), undefined);
  assert.equal(calls.length, 2);
});

test("M4 destructive confirmation is consumed even when invoke fails", async () => {
  const calls: StudioOperation[] = [];
  let fail = true;
  const registry = new HostConfirmationRegistry();
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    registry,
    async (operation) => {
      calls.push(operation);
      if (fail) throw new Error("transport failed");
      return { status: "accepted" };
    },
  );
  adapter.adopt(eventFor(confirmRequest(true)));
  const token = registry.issue(
    { kind: "interaction.respond", interactionId, commandId, decision: "submit" },
    "gui",
  );
  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui", confirmationToken: token }),
    /transport failed/,
  );
  assert.equal(calls.length, 1);
  assert.ok(adapter.pending() !== undefined);
  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui", confirmationToken: token }),
    (error: unknown) => isHostError(error, "INTERACTION_STALE"),
  );

  fail = false;
  const fresh = registry.issue({ kind: "interaction.respond", interactionId, commandId, decision: "submit" }, "gui");
  await adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui", confirmationToken: fresh });
  assert.equal(adapter.pending(), undefined);
});

test("M4 a non-acknowledged invoke result fails closed", async () => {
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async () => ({ status: "rejected" }) as unknown as RemoteInteractionInvokeResult,
  );
  adapter.adopt(eventFor(confirmRequest()));
  await assert.rejects(
    () => adapter.respond({ interactionId, commandId, decision: "submit", owner: "gui" }),
    (error: unknown) => isHostError(error, "INTERNAL_ERROR"),
  );
  assert.ok(adapter.pending() !== undefined);
});

test("M4 adoption rejects replayed, conflicting, and invalid events", () => {
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async () => ({ status: "accepted" }),
  );
  const adopted = adapter.adopt(eventFor(confirmRequest(), "gui", 3));
  assert.equal(adopted.interactionId, interactionId);
  assert.equal(adopted.generation, 3);

  assert.throws(
    () => adapter.adopt(eventFor(confirmRequest(), "tui", 4)),
    (error: unknown) => isHostError(error, "INTERACTION_STALE"),
  );
  const conflicting: RemoteInteractionRequest = {
    kind: "confirm",
    interactionId: "interaction-2" as InteractionId,
    commandId: "command-2" as CommandId,
    title: "Other confirm",
    message: "Other?",
  };
  assert.throws(
    () => adapter.adopt(eventFor(conflicting)),
    (error: unknown) => isHostError(error, "COMMAND_BLOCKED"),
  );

  const fresh = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async () => ({ status: "accepted" }),
  );
  assert.throws(
    () => fresh.adopt(eventFor(confirmRequest(), "gui", 0)),
    (error: unknown) => isHostError(error, "INVALID_ARGUMENT"),
  );
  assert.throws(
    () => fresh.adopt(eventFor(confirmRequest(), "gui", -1)),
    (error: unknown) => isHostError(error, "INVALID_ARGUMENT"),
  );
  assert.throws(
    () => fresh.adopt(eventFor(confirmRequest(), "gui", 1.5)),
    (error: unknown) => isHostError(error, "INVALID_ARGUMENT"),
  );
});

test("M4 pending() and adopt() return defensive clones", () => {
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async () => ({ status: "accepted" }),
  );
  const adopted = adapter.adopt(eventFor(inputRequest()));
  const first = adapter.pending();
  assert.ok(first !== undefined);
  const firstRequest = first.request;
  assert.equal(firstRequest.kind, "input");
  first.title = "mutated title";
  first.owner = "tui";
  first.generation = 99;
  if (firstRequest.kind === "input") {
    firstRequest.placeholder = "mutated placeholder";
  }

  const second = adapter.pending();
  assert.ok(second !== undefined);
  const secondRequest = second.request;
  assert.equal(second.title, "Token needed");
  assert.equal(second.owner, "gui");
  assert.equal(second.generation, 1);
  assert.equal(secondRequest.kind, "input");
  if (secondRequest.kind === "input") {
    assert.equal(secondRequest.placeholder, "super-secret-placeholder");
    assert.equal(secondRequest.secret, true);
  }

  adopted.title = "mutated adopted";
  assert.equal(adapter.pending()?.title, "Token needed");
});

test("M4 error messages never echo secret interaction content", async () => {
  const adapter = new RemoteInteractionAdapter(
    makeArbiter(),
    new HostConfirmationRegistry(),
    async () => ({ status: "accepted" }),
  );
  adapter.adopt(eventFor(inputRequest()));
  let caught: unknown;
  try {
    await adapter.respond({ interactionId, commandId, decision: "submit", owner: "tui" });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof StudioHostError);
  assert.equal(caught.code, "NOT_OWNER");
  assert.ok(!caught.message.includes("super-secret-placeholder"));
});