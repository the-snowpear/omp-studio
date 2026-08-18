/**
 * session.create must start a managed Runtime when switchSession cannot
 * (boot skipped start / read-only composition).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  OperatorStateSnapshot,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
} from "@omp-studio/studio-protocol";

import { threadIdFor } from "@omp-studio/host-client-api";
import { StudioHostError } from "@omp-studio/studio-host";

import type { DesktopRuntimeSession } from "../src/host-composition.js";
import type { DesktopInteractionHost } from "../src/interaction-host.js";
import { createDesktopSemanticCommands } from "../src/session-commands.js";

const SESSION = "sess-fresh" as SessionId;
const T0 = "2026-08-15T00:00:00.000Z";

function snapshotOf(sessionId: SessionId): OperatorStateSnapshot {
  return {
    runtimeId: "rt-0001" as RuntimeId,
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 1 as StateVersion,
    sessionId,
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal",
    approvalMode: "yolo",
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  };
}

function fakeSession(sessionId: SessionId): DesktopRuntimeSession {
  const snapshot = snapshotOf(sessionId);
  return {
    controller: {
      publication: () => ({ commitSeq: 1, publishedAt: T0, snapshot, terminalOutcomes: [] }),
    },
    hello: () => undefined,
    onPublication: () => () => {},
    capabilityManifest: () => undefined,
    commandManifest: () => undefined,
  } as unknown as DesktopRuntimeSession;
}

test("session.create starts a managed Runtime when switchSession returns nothing", async () => {
  const started = fakeSession(SESSION);
  const sessionRef = { current: undefined as DesktopRuntimeSession | undefined };
  let ensured = 0;
  const commands = createDesktopSemanticCommands({
    sessionRef,
    catalog: { list: async () => [] },
    switchSession: async () => undefined,
    ensureRuntime: async () => {
      ensured += 1;
      return started;
    },
    bindSession: (session) => {
      sessionRef.current = session;
    },
    interaction: {} as DesktopInteractionHost,
  });

  const created = await commands.create!();
  assert.equal(ensured, 1);
  assert.equal(created.sessionId, SESSION);
  assert.equal(sessionRef.current, started);
});

test("session.create does not call ensureRuntime when switchSession already produced a snapshot", async () => {
  const started = fakeSession(SESSION);
  const sessionRef = { current: undefined as DesktopRuntimeSession | undefined };
  let ensured = 0;
  const commands = createDesktopSemanticCommands({
    sessionRef,
    catalog: { list: async () => [] },
    switchSession: async () => started,
    ensureRuntime: async () => {
      ensured += 1;
      return started;
    },
    bindSession: (session) => {
      sessionRef.current = session;
    },
    interaction: {} as DesktopInteractionHost,
  });

  const created = await commands.create!();
  assert.equal(ensured, 0);
  assert.equal(created.sessionId, SESSION);
});

test("session.resume starts a managed Runtime when switchSession returns nothing", async () => {
  const started = fakeSession(SESSION);
  const sessionRef = { current: undefined as DesktopRuntimeSession | undefined };
  let ensured = 0;
  let switchCalls = 0;
  const commands = createDesktopSemanticCommands({
    sessionRef,
    catalog: {
      list: async () => [{ sessionId: SESSION, modifiedAt: T0, messageCount: 0, status: "active" }],
    },
    switchSession: async () => {
      switchCalls += 1;
      return switchCalls === 1 ? undefined : started;
    },
    ensureRuntime: async () => {
      ensured += 1;
      return started;
    },
    bindSession: (session) => {
      sessionRef.current = session;
    },
    interaction: {} as DesktopInteractionHost,
  });

  const restored = await commands.resume!({ threadId: threadIdFor(SESSION) });
  assert.equal(ensured, 1);
  assert.equal(switchCalls, 2);
  assert.equal(restored.sessionId, SESSION);
  assert.equal(sessionRef.current, started);
});

test("session.resume does not call ensureRuntime when switchSession already produced a snapshot", async () => {
  const started = fakeSession(SESSION);
  const sessionRef = { current: undefined as DesktopRuntimeSession | undefined };
  let ensured = 0;
  const commands = createDesktopSemanticCommands({
    sessionRef,
    catalog: {
      list: async () => [{ sessionId: SESSION, modifiedAt: T0, messageCount: 0, status: "active" }],
    },
    switchSession: async () => started,
    ensureRuntime: async () => {
      ensured += 1;
      return started;
    },
    bindSession: (session) => {
      sessionRef.current = session;
    },
    interaction: {} as DesktopInteractionHost,
  });

  const restored = await commands.resume!({ threadId: threadIdFor(SESSION) });
  assert.equal(ensured, 0);
  assert.equal(restored.sessionId, SESSION);
});

test("session.create error uses the last disconnect reason", async () => {
  const sessionRef = { current: undefined as DesktopRuntimeSession | undefined };
  const commands = createDesktopSemanticCommands({
    sessionRef,
    catalog: { list: async () => [] },
    switchSession: async () => undefined,
    runtimeMissing: () => ({
      disconnect: { code: "process-exit", reason: "Runtime process exited (code=1)" },
    }),
    bindSession: (session) => {
      sessionRef.current = session;
    },
    interaction: {} as DesktopInteractionHost,
  });

  await assert.rejects(
    async () => {
      await commands.create!();
    },
    (error: unknown) => {
      assert.ok(error instanceof StudioHostError);
      assert.equal(error.code, "CAPABILITY_UNAVAILABLE");
      assert.match(error.message, /Runtime process exited/u);
      return true;
    },
  );
});
