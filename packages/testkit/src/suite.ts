/**
 * Shared semantic transport contract suite (P0).
 *
 * `runTransportContract` runs the identical assertion set against every
 * transport adapter through the same `TransportFactory` entry point. The
 * factory receives a deterministic `ContractFixtureApi` fake host, and the
 * suite verifies — purely through the adapter's public `ClientTransport`
 * surface — that:
 *
 * - bootstrap output matches the fixture exactly and is internally
 *   consistent (bootstrap parity);
 * - every representative query envelope forwards verbatim and resolves to
 *   the exact fixture response (deep-equal, no reinterpretation);
 * - command envelopes forward verbatim, idempotency keys pass through
 *   unchanged, and the accepted acknowledgement stays non-terminal (never
 *   a receipt);
 * - events deliver in order with scope filtering honored and unsubscribe
 *   stopping delivery, with subscription scopes forwarded verbatim;
 * - close is idempotent, reaches the host, and every operation rejects
 *   (subscribe throws) afterwards;
 * - malformed query/command names fail closed with INVALID_ARGUMENT.
 *
 * Only observable behavior is asserted: no platform-specific URLs,
 * channels, endpoints or transport internals appear anywhere.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  ClientCommandRequest,
  ClientEvent,
  ClientQueryRequest,
  ClientTransport,
  QueryName,
  SubscriptionScope,
  ThreadId,
} from "@omp-studio/client-contract";

import { contractFixtures, createContractFixtureApi } from "./fixtures.js";
import type { ContractFixtureApi, TransportFactory } from "./types.js";

const REJECTED = Symbol("rejected");

interface Harness {
  readonly api: ContractFixtureApi;
  readonly transport: ClientTransport;
}

function createHarness(factory: TransportFactory): Harness {
  const api = createContractFixtureApi();
  return { api, transport: factory(api) };
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (reason) {
    return reason;
  }
  return REJECTED;
}

/** Resolves to the rejection or the resolved value, never throwing. */
async function settle<T>(
  promise: Promise<T>,
): Promise<{ rejected: true; reason: unknown } | { rejected: false; value: T }> {
  try {
    return { rejected: false, value: await promise };
  } catch (reason) {
    return { rejected: true, reason };
  }
}

function rejectionCode(reason: unknown): unknown {
  return (reason as { code?: unknown } | null)?.code;
}

function rejectionMessage(reason: unknown): string {
  const message = (reason as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
}

function assertClosedRejection(reason: unknown, what: string): void {
  assert.notEqual(reason, REJECTED, `${what} must reject after close`);
  assert.ok(
    rejectionCode(reason) === "UNAVAILABLE" || /closed/i.test(rejectionMessage(reason)),
    `${what} rejection must carry code UNAVAILABLE or mention "closed"; got ${String(reason)}`,
  );
}

function assertInvalidArgumentRejection(reason: unknown, what: string): void {
  assert.notEqual(reason, REJECTED, `${what} must reject for a malformed name`);
  assert.equal(
    rejectionCode(reason),
    "INVALID_ARGUMENT",
    `${what} must fail closed with INVALID_ARGUMENT`,
  );
}

/** Runs the full contract suite for one transport factory. */
export function runTransportContract(name: string, factory: TransportFactory): void {
  test(`transport contract: ${name}`, async (t) => {
    await t.test("bootstrap parity", async () => {
      const { api, transport } = createHarness(factory);
      const bootstrap = await transport.bootstrap();
      assert.deepEqual(bootstrap, contractFixtures.bootstrap);
      // The fixture bootstraps with an established runtime snapshot; the
      // contract's without-snapshot variant must not apply here.
      assert.ok(bootstrap.snapshot);
      assert.equal(bootstrap.stateVersion, bootstrap.snapshot.stateVersion);
      assert.equal(bootstrap.snapshot.runtimeId, bootstrap.runtime.runtimeId);
      assert.equal(bootstrap.cursor, contractFixtures.bootstrap.cursor);
      assert.equal(api.calls.bootstrapCalls, 1);
    });

    await t.test("representative query envelopes forward verbatim", async () => {
      const { api, transport } = createHarness(factory);
      for (const queryName of Object.keys(contractFixtures.queryInputs) as QueryName[]) {
        const request = { queryName, input: contractFixtures.queryInputs[queryName] };
        const response = await transport.query(request);
        assert.deepEqual(response, contractFixtures.queryResponses[queryName]);
        assert.deepEqual(api.calls.lastQueryRequest, request);
      }
      const manifest = await transport.query({ queryName: "commands.getManifest", input: {} });
      if (!manifest.ok) {
        assert.fail("commands.getManifest must resolve ok");
      }
      assert.equal(manifest.result.hash, contractFixtures.bootstrap.commandManifestHash);
    });

    await t.test("transcript query and conversation events are in the suite", async () => {
      const { api, transport } = createHarness(factory);
      const request = {
        queryName: "session.transcript.read" as const,
        input: contractFixtures.queryInputs["session.transcript.read"],
      };
      const response = await transport.query(request);
      assert.equal(response.ok, true);
      if (!response.ok) {
        assert.fail("session.transcript.read must resolve ok");
      }
      assert.equal(response.queryName, "session.transcript.read");
      assert.ok(Array.isArray(response.result.items));
      assert.equal(typeof response.result.headCursor, "string");
      assert.notEqual(response.result.headCursor.length, 0);

      const received: ClientEvent[] = [];
      transport.subscribe({ scope: "runtime" }, (event) => received.push(event));
      const conversation = contractFixtures.events.find((event) => event.kind === "conversation.changed");
      assert.ok(conversation, "fixture events must include conversation.changed");
      api.emit(conversation);
      assert.equal(received.length, 1);
      assert.equal(received[0]?.kind, "conversation.changed");
      if (received[0]?.kind === "conversation.changed") {
        assert.equal(received[0].eventSeq, conversation.kind === "conversation.changed" ? conversation.eventSeq : -1);
        assert.equal(received[0].occurredAt, conversation.occurredAt);
      }
    });

    await t.test("command envelopes forward verbatim; acceptance is non-terminal", async () => {
      const { api, transport } = createHarness(factory);
      for (let i = 0; i < contractFixtures.commandRequests.length; i++) {
        const request = contractFixtures.commandRequests[i]!;
        const accepted = await transport.command(request);
        assert.deepEqual(accepted, contractFixtures.commandAccepted[i]!);
        assert.equal(accepted.status, "accepted");
        assert.equal("result" in accepted, false);
        assert.equal("observedAt" in accepted, false);
        assert.deepEqual(api.calls.lastCommandRequest, request);
      }
    });

    await t.test("command idempotency key and requestId forward unchanged", async () => {
      const { api, transport } = createHarness(factory);
      const request = contractFixtures.commandRequests[0]!;
      const first = await transport.command(request);
      const second = await transport.command(request);
      assert.equal(api.calls.commandCalls, 2);
      assert.deepEqual(api.calls.lastCommandRequest, request);
      assert.deepEqual(first, second);
      // The host echoes the client-generated requestId unchanged; the
      // adapter must not rewrite the requestId, the idempotency key, or
      // the acknowledgement.
      assert.equal(first.requestId, request.requestId);
      assert.equal(second.requestId, request.requestId);
    });

    await t.test("all-scope events deliver verbatim and in order", async () => {
      const { api, transport } = createHarness(factory);
      const received: ClientEvent[] = [];
      const scope: SubscriptionScope = { scope: "all" };
      const unsubscribe = transport.subscribe(scope, (event) => received.push(event));
      assert.equal(api.calls.subscribeCalls, 1);
      assert.deepEqual(api.calls.subscriptions[0]!.scope, scope);
      for (const event of contractFixtures.events) {
        api.emit(event);
      }
      assert.deepEqual(received, contractFixtures.events);
      unsubscribe();
      api.emit(contractFixtures.events[0]!);
      assert.equal(received.length, contractFixtures.events.length);
      assert.equal(api.calls.subscriptions[0]!.unsubscribed, true);
    });

    await t.test("command-scoped subscriptions filter to the request", async () => {
      const { api, transport } = createHarness(factory);
      const received: ClientEvent[] = [];
      const scope: SubscriptionScope = {
        scope: "command",
        requestId: contractFixtures.commandRequestId,
      };
      transport.subscribe(scope, (event) => received.push(event));
      assert.deepEqual(api.calls.subscriptions[0]!.scope, scope);
      for (const event of contractFixtures.events) {
        api.emit(event);
      }
      assert.deepEqual(
        received,
        contractFixtures.events.filter(
          (event) => event.kind === "command.accepted" || event.kind === "command.receipt",
        ),
      );
    });

    await t.test("runtime-scoped subscriptions filter to runtime-tied events", async () => {
      const { api, transport } = createHarness(factory);
      const received: ClientEvent[] = [];
      const scope: SubscriptionScope = { scope: "runtime" };
      transport.subscribe(scope, (event) => received.push(event));
      assert.deepEqual(api.calls.subscriptions[0]!.scope, scope);
      for (const event of contractFixtures.events) {
        api.emit(event);
      }
      assert.deepEqual(
        received,
        contractFixtures.events.filter((event) => event.runtimeEpoch !== undefined),
      );
    });

    await t.test("thread-scoped subscriptions conservatively match nothing", async () => {
      // ClientEvent snapshots carry a sessionId but no threadId, and
      // SessionId and ThreadId are distinct identities. A thread-scoped
      // subscription must neither compare them nor invent a session→thread
      // relationship, so until the contract binds events to a thread it
      // receives no events at all — for the fixture's own threadId and for
      // any other thread (no false positives).
      const { api, transport } = createHarness(factory);
      const received: ClientEvent[] = [];
      transport.subscribe(
        { scope: "thread", threadId: contractFixtures.threadId },
        (event) => received.push(event),
      );
      for (const event of contractFixtures.events) {
        api.emit(event);
      }
      assert.deepEqual(received, []);
      // A different thread receives nothing either.
      const other: ClientEvent[] = [];
      transport.subscribe(
        { scope: "thread", threadId: "thr-0002" as ThreadId },
        (event) => other.push(event),
      );
      for (const event of contractFixtures.events) {
        api.emit(event);
      }
      assert.deepEqual(other, []);
      assert.equal(api.calls.subscriptions[0]!.unsubscribed, false);
    });

    await t.test("unsubscribe stops delivery and is idempotent", async () => {
      const { api, transport } = createHarness(factory);
      const received: ClientEvent[] = [];
      const unsubscribe = transport.subscribe({ scope: "all" }, (event) =>
        received.push(event),
      );
      const live: ClientEvent[] = [];
      transport.subscribe({ scope: "all" }, (event) => live.push(event));
      unsubscribe();
      unsubscribe(); // a second unsubscribe must not throw
      for (const event of contractFixtures.events) {
        api.emit(event);
      }
      assert.deepEqual(received, []);
      assert.deepEqual(live, contractFixtures.events);
      assert.equal(api.calls.subscriptions[0]!.unsubscribed, true);
      assert.equal(api.calls.subscriptions[1]!.unsubscribed, false);
    });

    await t.test("close is idempotent and reaches the host", async () => {
      const { api, transport } = createHarness(factory);
      await transport.close();
      await transport.close();
      assert.ok(api.calls.closeCalls >= 1);
    });

    await t.test("operations reject after close", async () => {
      const { transport } = createHarness(factory);
      await transport.close();
      assertClosedRejection(await captureRejection(transport.bootstrap()), "bootstrap");
      assertClosedRejection(
        await captureRejection(transport.query({ queryName: "session.state", input: {} })),
        "query",
      );
      assertClosedRejection(
        await captureRejection(transport.command(contractFixtures.commandRequests[0]!)),
        "command",
      );
      assert.throws(
        () => transport.subscribe({ scope: "all" }, () => {}),
        (reason) =>
          rejectionCode(reason) === "UNAVAILABLE" || /closed/i.test(rejectionMessage(reason)),
        "subscribe must throw after close",
      );
    });

    await t.test("malformed queryName fails closed", async () => {
      const { api, transport } = createHarness(factory);
      // A well-formed envelope with an unknown name must come back as an
      // INVALID_ARGUMENT error envelope, forwarded verbatim.
      const unknown = { queryName: "bogus.query", input: {} } as unknown as ClientQueryRequest;
      const response = await transport.query(unknown);
      if (response.ok) {
        assert.fail("an unknown queryName must fail closed, not resolve ok");
      }
      assert.equal(response.error.code, "INVALID_ARGUMENT");
      assert.equal(response.queryName, "bogus.query");
      assert.deepEqual(api.calls.lastQueryRequest, unknown);

      // Non-string or missing names may either be rejected by the adapter
      // or come back as an error envelope — never as an ok result.
      const numeric = { queryName: 42, input: {} } as unknown as ClientQueryRequest;
      const numericOutcome = await settle(transport.query(numeric));
      if (!numericOutcome.rejected) {
        if (numericOutcome.value.ok) {
          assert.fail("a non-string queryName must fail closed, not resolve ok");
        }
        assert.equal(numericOutcome.value.error.code, "INVALID_ARGUMENT");
      }

      const missing = {} as unknown as ClientQueryRequest;
      const missingOutcome = await settle(transport.query(missing));
      if (!missingOutcome.rejected) {
        if (missingOutcome.value.ok) {
          assert.fail("a missing queryName must fail closed, not resolve ok");
        }
        assert.equal(missingOutcome.value.error.code, "INVALID_ARGUMENT");
      }
    });

    await t.test("malformed commandName fails closed", async () => {
      const { api, transport } = createHarness(factory);
      const unknown = {
        commandName: "bogus.command",
        input: {},
        idempotencyKey: contractFixtures.idempotencyKey,
      } as unknown as ClientCommandRequest;
      assertInvalidArgumentRejection(await captureRejection(transport.command(unknown)), "command");
      assert.deepEqual(api.calls.lastCommandRequest, unknown);

      const numeric = {
        commandName: 42,
        input: {},
        idempotencyKey: contractFixtures.idempotencyKey,
      } as unknown as ClientCommandRequest;
      assertInvalidArgumentRejection(await captureRejection(transport.command(numeric)), "command");

      const missing = {} as unknown as ClientCommandRequest;
      assertInvalidArgumentRejection(await captureRejection(transport.command(missing)), "command");
    });

  });
}
