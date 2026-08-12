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
 * - defensive clone isolation holds in both directions: mutating a request
 *   after the call never reaches the host's copy, and mutating a returned
 *   result never poisons the next call;
 * - close is idempotent, reaches the host, and every operation rejects
 *   (subscribe throws) afterwards;
 * - malformed query/command names fail closed with INVALID_ARGUMENT;
 * - malformed structural envelopes — non-object bootstrap results, query
 *   responses with a non-boolean `ok`, missing `result`/`error`, malformed
 *   error shapes, mismatched names, or command acceptances with missing/
 *   non-string `requestId`/`acceptedAt` or a status other than exactly
 *   `"accepted"` — are rejected by the transport before the caller ever
 *   sees them.
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
      assert.equal(bootstrap.stateVersion, bootstrap.snapshot.stateVersion);
      assert.equal(bootstrap.snapshot.runtimeId, bootstrap.runtime.runtimeId);
      assert.equal(bootstrap.cursor, contractFixtures.bootstrap.cursor);
      assert.equal(api.calls.bootstrapCalls, 1);
    });

    await t.test("bootstrap result is defensively cloned", async () => {
      const { transport } = createHarness(factory);
      const first = await transport.bootstrap();
      // Test seam: the contract types are readonly, so mutate through a
      // deliberately mutable view of the returned value.
      const tampered = first as unknown as {
        surface: { terminalAttach: boolean };
        snapshot: { agents: unknown[] };
      };
      tampered.surface.terminalAttach = true;
      tampered.snapshot.agents.push({ tampered: true });
      const second = await transport.bootstrap();
      assert.deepEqual(second, contractFixtures.bootstrap);
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

    await t.test("query input is defensively cloned before forwarding", async () => {
      const { api, transport } = createHarness(factory);
      const input = { limit: 5 };
      await transport.query({ queryName: "history.list", input });
      input.limit = 99;
      assert.deepEqual(api.calls.lastQueryRequest, {
        queryName: "history.list",
        input: { limit: 5 },
      });
    });

    await t.test("query result is defensively cloned", async () => {
      const { transport } = createHarness(factory);
      const first = await transport.query({ queryName: "diagnostics.get", input: {} });
      if (!first.ok) {
        assert.fail("diagnostics.get must resolve ok");
      }
      // Test seam: mutate the returned entry list through a mutable view.
      const tampered = first as unknown as { ok: true; result: { entries: unknown[] } };
      tampered.result.entries.push({ tampered: true });
      const second = await transport.query({ queryName: "diagnostics.get", input: {} });
      if (!second.ok) {
        assert.fail("diagnostics.get must resolve ok");
      }
      assert.deepEqual(second, contractFixtures.queryResponses["diagnostics.get"]);
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

    await t.test("command input is defensively cloned before forwarding", async () => {
      const { api, transport } = createHarness(factory);
      const input = { channel: "stable" } as const;
      await transport.command({
        commandName: "runtime.install",
        input,
        idempotencyKey: contractFixtures.idempotencyKey,
        requestId: contractFixtures.commandRequestId,
      });
      // Test seam: the fixture accepts both channels; flip the caller's copy.
      const mutableInput = input as { channel: "stable" | "canary" };
      mutableInput.channel = "canary";
      assert.deepEqual(api.calls.lastCommandRequest, {
        commandName: "runtime.install",
        input: { channel: "stable" },
        idempotencyKey: contractFixtures.idempotencyKey,
        requestId: contractFixtures.commandRequestId,
      });
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

    await t.test("malformed bootstrap results fail closed", async () => {
      const { api, transport } = createHarness(factory);
      for (const malformed of [null, "bogus", 42] as const) {
        api.overrideBootstrap(malformed);
        const outcome = await settle(transport.bootstrap());
        assert.equal(
          outcome.rejected,
          true,
          `a malformed bootstrap result must be rejected, not surfaced: ${String(malformed)}`,
        );
      }
      // The override is one-shot: the next call resolves the real fixture.
      assert.deepEqual(await transport.bootstrap(), contractFixtures.bootstrap);
    });

    await t.test("malformed query responses fail closed", async () => {
      const { api, transport } = createHarness(factory);
      const request = { queryName: "session.state", input: {} } as const;
      const malformedResponses: ReadonlyArray<unknown> = [
        null,
        "bogus",
        { ok: "yes", queryName: "session.state" }, // ok flag must be a boolean
        { ok: true, queryName: "session.state" }, // ok response must own result
        { ok: false, queryName: "session.state" }, // error response must own error
        { ok: false, queryName: "session.state", error: null },
        { ok: false, queryName: "session.state", error: { code: 42, message: "nope" } },
        { ok: false, queryName: "session.state", error: { code: "INTERNAL_ERROR", message: 7 } },
        { ok: true, queryName: "home.get", result: {} }, // mismatched queryName
      ];
      for (const malformed of malformedResponses) {
        api.overrideQueryResponse(malformed);
        const outcome = await settle(transport.query(request));
        assert.equal(
          outcome.rejected,
          true,
          `a malformed query response must be rejected, not surfaced: ${JSON.stringify(malformed)}`,
        );
      }
      // The override is one-shot: the next call resolves the real fixture.
      const valid = await transport.query(request);
      assert.equal(valid.ok, true);
      assert.deepEqual(valid, contractFixtures.queryResponses["session.state"]);
    });

    await t.test("malformed command acceptances fail closed", async () => {
      const { api, transport } = createHarness(factory);
      const request = contractFixtures.commandRequests[0]!;
      const validAcceptance = contractFixtures.commandAccepted[0]!;
      const malformedAcceptances: ReadonlyArray<unknown> = [
        null,
        "bogus",
        // requestId/acceptedAt must be string-typed; absent or non-string
        // values are malformed (the structural check is typeof string).
        { ...validAcceptance, requestId: undefined },
        { ...validAcceptance, acceptedAt: undefined },
        { ...validAcceptance, requestId: 42 },
        { ...validAcceptance, acceptedAt: 42 },
        { ...validAcceptance, commandName: "session.resume" }, // mismatched commandName
        { ...validAcceptance, status: "completed" }, // status must be exactly "accepted"
        { ...validAcceptance, status: "Accepted" },
        { ...validAcceptance, status: undefined },
      ];
      for (const malformed of malformedAcceptances) {
        api.overrideCommandResponse(malformed);
        const outcome = await settle(transport.command(request));
        assert.equal(
          outcome.rejected,
          true,
          `a malformed command acceptance must be rejected, not surfaced: ${JSON.stringify(malformed)}`,
        );
      }
      // The override is one-shot: the next call resolves the real fixture.
      const valid = await transport.command(request);
      assert.equal(valid.status, "accepted");
      assert.deepEqual(valid, contractFixtures.commandAccepted[0]!);
    });
  });
}
