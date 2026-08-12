/**
 * Contract tests for the @omp-studio/client reducer and client surface
 * (FRONTEND_INTEGRATION.md §8.3 invariants).
 *
 * Cursor discipline in these tests: bootstrap always establishes cursor
 * "10", so the first event is "11", the second "12", and so on. A gap
 * skips a number. All cursors are canonical decimal unless a test says
 * otherwise (opaque cursor case).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AuthorityEpoch,
  AuthorityId,
  ClientBootstrap,
  ClientCommandRequest,
  ClientError,
  ClientEvent,
  ClientEventBase,
  CommandName,
  CommandRequestId,
  EventCursor,
  IdempotencyKey,
  InteractionId,
  RuntimeConnection,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
  ThreadId,
} from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

import { MemoryClientTransport } from "../src/memory-transport.js";
import {
  createInitialClientState,
  isSensitiveCommand,
  reduceClientState,
  RESYNC_REQUIRED_ERROR,
  type ClientState,
} from "../src/reducer.js";
import type { ClientClockAndIds } from "../src/clock.js";
import { StudioClientImpl } from "../src/studio-client.js";

const TS = "2026-08-12T00:00:00.000Z";
const REQ_1 = "req-1" as CommandRequestId;
const REQ_2 = "req-2" as CommandRequestId;

function snapshot(stateVersion: number, runtimeEpoch: number): OperatorStateSnapshot {
  return {
    runtimeId: "rt-1" as RuntimeId,
    runtimeEpoch: runtimeEpoch as RuntimeEpoch,
    stateVersion: stateVersion as StateVersion,
    sessionId: "sess-1" as SessionId,
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal",
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

function bootstrap(stateVersion = 1, cursor = "10", runtimeEpoch = 1): ClientBootstrap {
  return {
    contractVersion: 1,
    authority: { authorityId: "auth-1" as AuthorityId, authorityEpoch: 1 as AuthorityEpoch },
    runtime: {
      status: "connected",
      classification: "managed",
      runtimeId: "rt-1" as RuntimeId,
      runtimeEpoch: runtimeEpoch as RuntimeEpoch,
      backend: "studio-host",
      runtimeVersion: "1.0.0",
    },
    surface: { terminalAttach: false, fileReveal: false, previewInput: false, openExternal: false },
    capabilityManifest: { profile: "full-parity-v1", generatedAt: TS, hash: "cap-hash", capabilities: [] },
    commandManifestHash: "cmd-hash",
    selected: {},
    snapshot: snapshot(stateVersion, runtimeEpoch),
    stateVersion: stateVersion as StateVersion,
    cursor: cursor as EventCursor,
  };
}

interface EventOverrides {
  readonly authorityEpoch?: AuthorityEpoch;
  readonly runtimeEpoch?: RuntimeEpoch;
  readonly stateVersion?: StateVersion;
  readonly occurredAt?: string;
}

function base(cursor: string, overrides: EventOverrides = {}): ClientEventBase {
  return {
    authorityEpoch: overrides.authorityEpoch ?? (1 as AuthorityEpoch),
    stateVersion: overrides.stateVersion ?? (1 as StateVersion),
    cursor: cursor as EventCursor,
    occurredAt: overrides.occurredAt ?? TS,
    ...(overrides.runtimeEpoch !== undefined ? { runtimeEpoch: overrides.runtimeEpoch } : {}),
  };
}

function changed(cursor: number, overrides: EventOverrides = {}): ClientEvent {
  return { ...base(String(cursor), overrides), kind: "state.changed" };
}

function snapshotEvent(cursor: number, snap: OperatorStateSnapshot, overrides: EventOverrides = {}): ClientEvent {
  return { ...base(String(cursor), overrides), kind: "snapshot", snapshot: snap };
}

function accepted(requestId: CommandRequestId, cursor: number, overrides: EventOverrides = {}): ClientEvent {
  return {
    ...base(String(cursor), overrides),
    kind: "command.accepted",
    accepted: { commandName: "session.resume", requestId, status: "accepted", acceptedAt: TS },
  };
}

function interactionRequired(requestId: CommandRequestId, cursor: number, overrides: EventOverrides = {}): ClientEvent {
  return {
    ...base(String(cursor), overrides),
    kind: "command.interactionRequired",
    interaction: {
      interactionId: "ia-1" as InteractionId,
      requestId,
      kind: "confirm",
      message: "Drop thread?",
      destructive: true,
    },
  };
}

function outcomeUnknownReceipt(requestId: CommandRequestId, cursor: number, overrides: EventOverrides = {}): ClientEvent {
  return {
    ...base(String(cursor), overrides),
    kind: "command.receipt",
    receipt: {
      commandName: "session.resume",
      requestId,
      status: "outcome_unknown",
      reason: "runtime epoch changed",
      observedAt: TS,
    },
  };
}

function completedReceipt(requestId: CommandRequestId, cursor: number, overrides: EventOverrides = {}): ClientEvent {
  return {
    ...base(String(cursor), overrides),
    kind: "command.receipt",
    receipt: {
      commandName: "session.resume",
      requestId,
      status: "completed",
      result: snapshot(5, 1),
      observedAt: TS,
    },
  };
}

function runtimeChanged(cursor: number, connection: RuntimeConnection, overrides: EventOverrides = {}): ClientEvent {
  return { ...base(String(cursor), overrides), kind: "runtime.changed", connection };
}

function bootedState(b: ClientBootstrap = bootstrap()): ClientState {
  return reduceClientState(createInitialClientState(), { type: "bootstrap.set", bootstrap: b, occurredAt: TS });
}

function issue(state: ClientState, name: "session.resume" | "runtime.install", requestId: CommandRequestId): ClientState {
  return reduceClientState(state, {
    type: "command.issue",
    requestId,
    commandName: name,
    idempotencyKey: "idem-1" as IdempotencyKey,
    issuedAt: TS,
  });
}

function fixedIds(): ClientClockAndIds {
  let n = 0;
  return {
    now: () => TS,
    newRequestId: () => {
      n += 1;
      return `req-${n}` as CommandRequestId;
    },
    newIdempotencyKey: () => {
      n += 1;
      return `idem-${n}` as IdempotencyKey;
    },
  };
}

test("bootstrap establishes authority/runtime epoch, stateVersion, cursor and snapshot", () => {
  const state = bootedState();
  assert.equal(state.connection.phase, "bootstrapped");
  assert.equal(state.connection.authorityId, "auth-1");
  assert.equal(state.connection.authorityEpoch, 1);
  assert.equal(state.connection.runtimeEpoch, 1);
  assert.equal(state.connection.stateVersion, 1);
  assert.equal(state.connection.cursor, "10");
  assert.equal(state.connection.resyncRequired, false);
  assert.equal(state.entities.snapshot?.stateVersion, 1);
  assert.equal(state.connection.surface?.openExternal, false);
});

test("duplicate cursor events are idempotent", () => {
  let state = bootedState();
  state = reduceClientState(state, { type: "event", event: changed(11) });
  assert.equal(state.connection.cursor, "11");
  const before = state;
  state = reduceClientState(state, { type: "event", event: changed(11) });
  assert.equal(state, before); // same reference: nothing changed
  // a duplicate ack must not create a second command entry
  state = issue(state, "session.resume", REQ_1);
  state = reduceClientState(state, { type: "event", event: accepted(REQ_1, 12) });
  state = reduceClientState(state, { type: "event", event: accepted(REQ_1, 13) });
  assert.equal(Object.keys(state.commands).length, 1);
  assert.equal(state.commands[REQ_1]?.status, "accepted");
});

test("a cursor gap forces resync_required and drops the gapped payload", () => {
  let state = bootedState();
  state = reduceClientState(state, { type: "event", event: changed(11) });
  // An ordinary event at 13 skips 12: the gap forces resync_required and
  // the payload (stateVersion 2, cursor 13) is dropped.
  state = reduceClientState(state, {
    type: "event",
    event: changed(13, { stateVersion: 2 as StateVersion }),
  });
  assert.equal(state.connection.resyncRequired, true);
  assert.match(state.connection.resyncReason ?? "", /gap/);
  assert.equal(state.connection.cursor, "11"); // cursor never advances past the gap
  assert.equal(state.connection.stateVersion, 1); // gapped payload's stateVersion dropped
  assert.equal(state.entities.snapshot?.stateVersion, 1); // snapshot state remains unchanged
  // a snapshot from a stale authority cannot clear resync
  state = reduceClientState(state, {
    type: "event",
    event: snapshotEvent(13, snapshot(5, 1), { authorityEpoch: 0 as AuthorityEpoch }),
  });
  assert.equal(state.connection.resyncRequired, true);
  // a regressing snapshot cannot clear resync either
  state = reduceClientState(state, { type: "event", event: snapshotEvent(12, snapshot(0, 1)) });
  assert.equal(state.connection.resyncRequired, true);
  // a matching, non-regressing snapshot is the resync mechanism
  state = reduceClientState(state, { type: "event", event: snapshotEvent(13, snapshot(3, 1)) });
  assert.equal(state.connection.resyncRequired, false);
  assert.equal(state.entities.snapshot?.stateVersion, 3);
  assert.equal(state.connection.cursor, "13");
  assert.equal(state.connection.stateVersion, 3);
});

test("stale authority and runtime epochs are ignored", () => {
  let state = bootedState();
  const before = state;
  state = reduceClientState(state, { type: "event", event: changed(11, { authorityEpoch: 0 as AuthorityEpoch }) });
  assert.equal(state, before);
  state = reduceClientState(state, { type: "event", event: changed(11, { runtimeEpoch: 0 as RuntimeEpoch }) });
  assert.equal(state, before);
  assert.equal(state.connection.cursor, "10");
});

test("runtime loss marks accepted commands outcome_unknown", () => {
  let state = bootedState();
  state = issue(state, "session.resume", REQ_1);
  state = reduceClientState(state, { type: "event", event: accepted(REQ_1, 11) });
  assert.equal(state.commands[REQ_1]?.status, "accepted");
  state = reduceClientState(state, {
    type: "event",
    event: runtimeChanged(12, { status: "disconnected", classification: "managed", runtimeId: "rt-1" as RuntimeId }),
  });
  const entry = state.commands[REQ_1];
  assert.equal(entry?.status, "outcome_unknown");
  if (entry?.status === "outcome_unknown") {
    assert.equal(entry.reason, "runtime changed; outcome unknown");
  } else {
    assert.fail("expected outcome_unknown entry");
  }
  assert.equal(state.connection.runtimeEpoch, null);
  // a completed receipt after outcome_unknown is ignored: terminal is final
  state = reduceClientState(state, { type: "event", event: completedReceipt(REQ_1, 13) });
  assert.equal(state.commands[REQ_1]?.status, "outcome_unknown");
});

test("a runtime epoch change via snapshot marks in-flight commands outcome_unknown", () => {
  let state = bootedState();
  state = issue(state, "session.resume", REQ_1);
  state = reduceClientState(state, { type: "event", event: accepted(REQ_1, 11) });
  state = reduceClientState(state, { type: "event", event: snapshotEvent(12, snapshot(2, 2)) });
  assert.equal(state.connection.runtimeEpoch, 2);
  assert.equal(state.commands[REQ_1]?.status, "outcome_unknown");
  if (state.commands[REQ_1]?.status === "outcome_unknown") {
    assert.equal(state.commands[REQ_1]?.reason, "runtime epoch changed; outcome unknown");
  }
});

test("terminal receipts cannot regress or duplicate", () => {
  let state = bootedState();
  state = issue(state, "session.resume", REQ_1);
  state = reduceClientState(state, { type: "event", event: outcomeUnknownReceipt(REQ_1, 11) });
  assert.equal(state.commands[REQ_1]?.status, "outcome_unknown");
  const before = state.commands[REQ_1];
  state = reduceClientState(state, { type: "event", event: completedReceipt(REQ_1, 12) });
  assert.equal(state.commands[REQ_1], before); // completed after outcome_unknown is a regression → ignored
  state = reduceClientState(state, { type: "event", event: outcomeUnknownReceipt(REQ_1, 13) });
  assert.equal(state.commands[REQ_1], before); // duplicate receipt is a no-op
});

test("interaction_required transitions from pending states and never regresses", () => {
  let state = bootedState();
  state = issue(state, "session.resume", REQ_1);
  state = reduceClientState(state, { type: "event", event: accepted(REQ_1, 11) });
  const interactionEvent: ClientEvent = {
    ...base("12"),
    kind: "command.interactionRequired",
    interaction: {
      interactionId: "ia-1" as InteractionId,
      requestId: REQ_1,
      kind: "confirm",
      message: "Drop thread?",
      destructive: true,
    },
  };
  state = reduceClientState(state, { type: "event", event: interactionEvent });
  assert.equal(state.commands[REQ_1]?.status, "interaction_required");
  state = reduceClientState(state, { type: "event", event: completedReceipt(REQ_1, 13) });
  assert.equal(state.commands[REQ_1]?.status, "completed");
  // a late interaction cannot regress a terminal command
  const late: ClientEvent = { ...interactionEvent, cursor: "14" as EventCursor };
  state = reduceClientState(state, { type: "event", event: late });
  assert.equal(state.commands[REQ_1]?.status, "completed");
});

test("sensitive mutations are blocked with RESYNC_REQUIRED while resync is required", () => {
  let state = bootedState();
  state = reduceClientState(state, { type: "event", event: changed(13) }); // gap
  assert.equal(state.connection.resyncRequired, true);
  const installId = "req-install" as CommandRequestId;
  const blocked = reduceClientState(state, {
    type: "command.issue",
    requestId: installId,
    commandName: "runtime.install",
    idempotencyKey: "idem-1" as IdempotencyKey,
    issuedAt: TS,
  });
  const failedEntry = blocked.commands[installId];
  assert.equal(failedEntry?.status, "failed");
  if (failedEntry?.status === "failed") {
    assert.equal(failedEntry.error, RESYNC_REQUIRED_ERROR);
  } else {
    assert.fail("expected failed entry");
  }
  // session.resume changes runtime state, so it is sensitive too
  const resumeId = "req-resume" as CommandRequestId;
  const blockedResume = reduceClientState(state, {
    type: "command.issue",
    requestId: resumeId,
    commandName: "session.resume",
    idempotencyKey: "idem-2" as IdempotencyKey,
    issuedAt: TS,
  });
  const resumeEntry = blockedResume.commands[resumeId];
  assert.equal(resumeEntry?.status, "failed");
  if (resumeEntry?.status === "failed") {
    assert.equal(resumeEntry.error, RESYNC_REQUIRED_ERROR);
  } else {
    assert.fail("expected failed entry");
  }
  assert.equal(isSensitiveCommand("session.resume"), true);
  assert.equal(isSensitiveCommand("interaction.respond"), true);
});

test("re-bootstrap marks in-flight commands outcome_unknown", () => {
  let state = bootedState();
  state = issue(state, "session.resume", REQ_1);
  state = reduceClientState(state, { type: "event", event: accepted(REQ_1, 11) });
  state = reduceClientState(state, { type: "bootstrap.set", bootstrap: bootstrap(2, "20"), occurredAt: TS });
  assert.equal(state.connection.cursor, "20");
  assert.equal(state.entities.snapshot?.stateVersion, 2);
  assert.equal(state.commands[REQ_1]?.status, "outcome_unknown");
});

test("opaque cursors only support equality; a different cursor forces resync", () => {
  let state = bootedState({ ...bootstrap(), cursor: "opaque-1" as EventCursor });
  const before = state;
  state = reduceClientState(state, { type: "event", event: { ...changed(11), cursor: "opaque-1" as EventCursor } });
  assert.equal(state, before); // duplicate opaque cursor is idempotent
  state = reduceClientState(state, { type: "event", event: { ...changed(11), cursor: "opaque-2" as EventCursor } });
  assert.equal(state.connection.resyncRequired, true);
});

test("StudioClientImpl blocks sensitive commands before the transport sees them", async () => {
  let commandCalls = 0;
  const transport = new MemoryClientTransport({
    bootstrap: () => bootstrap(),
    command: <TName extends CommandName>(request: ClientCommandRequest<TName>) => {
      commandCalls += 1;
      return {
        commandName: request.commandName,
        requestId: request.requestId,
        status: "accepted",
        acceptedAt: TS,
      };
    },
  });
  const client = new StudioClientImpl(transport, fixedIds());
  await client.bootstrap();
  transport.emit(changed(13)); // gap → resync
  await assert.rejects(
    () => client.command("runtime.install", {}),
    (error: unknown) => {
      assert.equal((error as ClientError).code, "RESYNC_REQUIRED");
      return true;
    },
  );
  assert.equal(commandCalls, 0);
  // session.resume is sensitive too: blocked before the transport sees it
  await assert.rejects(
    () => client.command("session.resume", { threadId: "t-1" as ThreadId }),
    (error: unknown) => {
      assert.equal((error as ClientError).code, "RESYNC_REQUIRED");
      return true;
    },
  );
  assert.equal(commandCalls, 0);
  await client.close();
});

test("a transport rejection becomes a failed command without claiming accepted", async () => {
  const transport = new MemoryClientTransport({
    bootstrap: () => bootstrap(),
    command: () => {
      throw { code: "TRANSPORT_ERROR", message: "pipe broke" } as ClientError;
    },
  });
  const client = new StudioClientImpl(transport, fixedIds());
  await client.bootstrap();
  await assert.rejects(
    () => client.command("session.resume", { threadId: "t-1" as ThreadId }),
    (error: unknown) => {
      assert.equal((error as ClientError).code, "TRANSPORT_ERROR");
      return true;
    },
  );
  const entries = Object.values(client.getState().commands);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry);
  assert.equal(entry.status, "failed");
  if (entry.status === "failed") {
    assert.equal(entry.error.code, "TRANSPORT_ERROR");
  }
  assert.equal(client.getState().commands[REQ_1]?.status === "accepted", false);
  await client.close();
});

test("outcome_unknown is never retried automatically", async () => {
  let commandCalls = 0;
  let seenIdempotencyKey: IdempotencyKey | undefined;
  let seenRequestId: CommandRequestId | undefined;
  const transport = new MemoryClientTransport({
    bootstrap: () => bootstrap(),
    command: <TName extends CommandName>(request: ClientCommandRequest<TName>) => {
      commandCalls += 1;
      // Capture only the well-typed scalar fields: a generic envelope
      // cannot be narrowed to a non-generic `ClientCommandRequest`.
      seenIdempotencyKey = request.idempotencyKey;
      seenRequestId = request.requestId;
      return {
        commandName: request.commandName,
        requestId: request.requestId,
        status: "accepted",
        acceptedAt: TS,
      };
    },
  });
  const client = new StudioClientImpl(transport, fixedIds());
  await client.bootstrap();
  const handle = await client.command("session.resume", { threadId: "t-1" as ThreadId }, {
    idempotencyKey: "my-key" as IdempotencyKey,
  });
  assert.equal(handle.status, "local_pending");
  assert.equal(seenIdempotencyKey, "my-key"); // envelope carries the caller's key
  // The client-generated requestId is authoritative end-to-end: the handle
  // and the transmitted envelope share one id.
  assert.equal(seenRequestId, handle.requestId);
  transport.emit(accepted(handle.requestId, 11));
  transport.emit(outcomeUnknownReceipt(handle.requestId, 12));
  assert.equal(commandCalls, 1); // no automatic retry of outcome_unknown
  await client.close();
});

test("command requestId correlates handle, envelope, and accepted entry end-to-end", async () => {
  let transmittedRequestId: CommandRequestId | undefined;
  const transport = new MemoryClientTransport({
    bootstrap: () => bootstrap(),
    command: <TName extends CommandName>(request: ClientCommandRequest<TName>) => {
      transmittedRequestId = request.requestId;
      return {
        commandName: request.commandName,
        requestId: request.requestId, // the Host echoes the client's id
        status: "accepted",
        acceptedAt: TS,
      };
    },
  });
  const client = new StudioClientImpl(transport, fixedIds());
  await client.bootstrap();
  const handle = await client.command("session.resume", { threadId: "t-1" as ThreadId });
  // The handle's requestId is the one transmitted to the transport.
  assert.equal(transmittedRequestId, handle.requestId);
  // An accepted event under that same requestId updates the entry the
  // issue created — exactly one entry, no orphan.
  transport.emit(accepted(handle.requestId, 11));
  const state = client.getState();
  assert.equal(Object.keys(state.commands).length, 1);
  assert.equal(state.commands[handle.requestId]?.status, "accepted");
  await client.close();
});

test("MemoryClientTransport filters events exactly by subscription scope", () => {
  const transport = new MemoryClientTransport();
  const all: ClientEvent[] = [];
  const runtime: ClientEvent[] = [];
  const command: ClientEvent[] = [];
  const thread: ClientEvent[] = [];
  const unAll = transport.subscribe({ scope: "all" }, (e) => all.push(e));
  transport.subscribe({ scope: "runtime" }, (e) => runtime.push(e));
  transport.subscribe({ scope: "command", requestId: REQ_1 }, (e) => command.push(e));
  transport.subscribe({ scope: "thread", threadId: "t-1" as ThreadId }, (e) => thread.push(e));

  // Runtime scope: every event carrying a runtime epoch, and only those —
  // including command events that carry one.
  transport.emit(changed(11, { runtimeEpoch: 1 as RuntimeEpoch }));
  transport.emit(changed(12)); // no runtimeEpoch → not runtime-scoped
  transport.emit(accepted(REQ_1, 13, { runtimeEpoch: 1 as RuntimeEpoch }));
  // Command scope: all three command kinds for the matching request.
  transport.emit(interactionRequired(REQ_1, 14));
  transport.emit(completedReceipt(REQ_1, 15));
  transport.emit(completedReceipt(REQ_2, 16)); // unrelated request → excluded
  // Snapshot events carry a sessionId but no threadId: thread scope must
  // not invent a SessionId==ThreadId relationship, so it matches nothing.
  transport.emit(snapshotEvent(17, snapshot(1, 1)));

  assert.equal(all.length, 7);
  assert.equal(runtime.length, 2);
  assert.equal(runtime[0]?.kind, "state.changed");
  assert.equal(command.length, 3);
  assert.equal(thread.length, 0);
  unAll();
  transport.emit(changed(18));
  assert.equal(all.length, 7);
});

test("MemoryClientTransport clones emitted payloads", () => {
  const transport = new MemoryClientTransport();
  const seen: ClientEvent[] = [];
  transport.subscribe({ scope: "all" }, (e) => seen.push(e));
  const snap = snapshot(1, 1);
  transport.emit(snapshotEvent(11, snap));
  const delivered = seen[0];
  if (delivered?.kind !== "snapshot") {
    assert.fail("expected a snapshot event");
  }
  assert.notEqual(delivered.snapshot, snap); // cloned, not the caller's object
  assert.deepEqual(delivered.snapshot, snap);
});

test("MemoryClientTransport enforces closed behavior", async () => {
  const transport = new MemoryClientTransport({ bootstrap: () => bootstrap() });
  await transport.close();
  await assert.rejects(
    () => transport.bootstrap(),
    (error: unknown) => {
      assert.equal((error as ClientError).code, "TRANSPORT_ERROR");
      return true;
    },
  );
  const delivered: ClientEvent[] = [];
  transport.subscribe({ scope: "all" }, (e) => delivered.push(e));
  transport.emit(changed(11));
  assert.equal(delivered.length, 0);
});
