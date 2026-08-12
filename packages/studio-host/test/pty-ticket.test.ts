import assert from "node:assert/strict";
import { test } from "node:test";
import { PtyAttachTicketRegistry, StudioHostError } from "../src/index.js";

const runtime = { runtimeId: "runtime-a", runtimeEpoch: 7 };

test("SEC-003 PTY attach tickets are scoped, Runtime-bound, and consumed once", () => {
  let tokenNumber = 0;
  const registry = new PtyAttachTicketRegistry({ randomToken: () => `ticket-${++tokenNumber}`.padEnd(32, "x") });
  const ticket = registry.issue(runtime, ["write", "resize", "write"]);
  assert.deepEqual(ticket.actions, ["write", "resize"]);
  assert.equal(registry.size, 1);

  assert.throws(
    () => registry.consume(ticket.token, { runtimeId: "runtime-b", runtimeEpoch: 7 }, "write"),
    (error) => error instanceof StudioHostError && error.code === "NOT_OWNER",
  );
  assert.throws(
    () => registry.consume(ticket.token, runtime, "terminate"),
    (error) => error instanceof StudioHostError && error.code === "NOT_OWNER",
  );

  registry.consume(ticket.token, runtime, "write");
  assert.equal(registry.size, 0);
  assert.throws(
    () => registry.consume(ticket.token, runtime, "write"),
    (error) => error instanceof StudioHostError && error.code === "UNAUTHENTICATED",
  );
});

test("expired PTY tickets fail closed and Runtime loss revokes outstanding tickets", () => {
  let now = 1_000;
  let tokenNumber = 0;
  const registry = new PtyAttachTicketRegistry({
    ttlMs: 50,
    capacity: 3,
    now: () => now,
    randomToken: () => `ticket-${++tokenNumber}`.padEnd(32, "x"),
  });
  const expired = registry.issue(runtime, ["resize"]);
  now += 50;
  assert.throws(
    () => registry.consume(expired.token, runtime, "resize"),
    (error) => error instanceof StudioHostError && error.code === "UNAUTHENTICATED",
  );

  registry.issue(runtime, ["signal"]);
  registry.issue(runtime, ["terminate"]);
  registry.issue({ runtimeId: "runtime-b", runtimeEpoch: 1 }, ["write"]);
  assert.equal(registry.revokeRuntime(runtime), 2);
  assert.equal(registry.size, 1);
});

test("PTY ticket registry validates inputs and evicts oldest entries at capacity", () => {
  let tokenNumber = 0;
  const registry = new PtyAttachTicketRegistry({
    capacity: 2,
    randomToken: () => `ticket-${++tokenNumber}`.padEnd(32, "x"),
  });
  assert.throws(() => registry.issue(runtime, []), /at least one/u);
  assert.throws(() => registry.issue({ runtimeId: "", runtimeEpoch: 0 }, ["write"]), /Runtime identity/u);
  const first = registry.issue(runtime, ["write"]);
  registry.issue(runtime, ["resize"]);
  registry.issue(runtime, ["signal"]);
  assert.throws(
    () => registry.consume(first.token, runtime, "write"),
    (error) => error instanceof StudioHostError && error.code === "UNAUTHENTICATED",
  );
  assert.equal(registry.size, 2);
});
