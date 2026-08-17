/**
 * session.archive of a live resident session: abort a streaming turn,
 * switch the Runtime off the file, then move with skipWriteGrace.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { threadIdFor } from "@omp-studio/host-client-api";
import type { StudioSessionArchiveService } from "@omp-studio/studio-host";
import type {
  OperatorStateSnapshot,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
  StudioReceipt,
  StudioRequest,
  ThreadId,
} from "@omp-studio/studio-protocol";

import type { DesktopRuntimeSession } from "../src/host-composition.js";
import type { DesktopInteractionHost } from "../src/interaction-host.js";
import { createDesktopSemanticCommands } from "../src/session-commands.js";

const SESSION_A = "sess-aaa" as SessionId;
const SESSION_B = "sess-bbb" as SessionId;
const T0 = "2026-08-15T00:00:00.000Z";

function snapshotOf(sessionId: SessionId, streaming: boolean): OperatorStateSnapshot {
  return {
    runtimeId: "rt-0001" as RuntimeId,
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 1 as StateVersion,
    sessionId,
    isStreaming: streaming,
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

function fakeSession(initial: OperatorStateSnapshot): {
  session: DesktopRuntimeSession;
  invokes: StudioRequest[];
  setSnapshot(next: OperatorStateSnapshot): void;
} {
  const invokes: StudioRequest[] = [];
  let snapshot = initial;
  const session = {
    controller: {
      invoke: async (request: StudioRequest): Promise<StudioReceipt> => {
        invokes.push(request);
        return {
          type: "studio.receipt",
          requestId: request.requestId,
          runtimeEpoch: snapshot.runtimeEpoch,
          stateVersion: snapshot.stateVersion,
          status: "completed",
        };
      },
      publication: () => ({ commitSeq: 1, publishedAt: T0, snapshot, terminalOutcomes: [] }),
    },
    hello: () => undefined,
    onPublication: () => () => {},
    capabilityManifest: () => undefined,
    commandManifest: () => undefined,
  } as unknown as DesktopRuntimeSession;
  return {
    session,
    invokes,
    setSnapshot(next) {
      snapshot = next;
    },
  };
}

test("session.archive aborts a streaming resident session, switches away, then skips the write grace", async () => {
  const live = fakeSession(snapshotOf(SESSION_A, true));
  const next = fakeSession(snapshotOf(SESSION_B, false));
  const archived: Array<{ sessionId: string; skipWriteGrace?: boolean }> = [];
  const switches: Array<{ kind: string }> = [];
  const sessionRef = { current: live.session as DesktopRuntimeSession | undefined };
  const commands = createDesktopSemanticCommands({
    sessionRef,
    catalog: {
      list: async () => [
        { sessionId: SESSION_A, modifiedAt: T0, messageCount: 1, status: "active" as const },
      ],
    },
    archive: () =>
      ({
        archive: async (sessionId: string, options?: { readonly skipWriteGrace?: boolean }) => {
          archived.push({ sessionId, ...(options?.skipWriteGrace === true ? { skipWriteGrace: true } : {}) });
          return { sessionId, archived: true };
        },
      }) as unknown as StudioSessionArchiveService,
    switchSession: async (intent) => {
      switches.push({ kind: intent.kind });
      return next.session;
    },
    bindSession: (session) => {
      sessionRef.current = session;
    },
    interaction: {} as DesktopInteractionHost,
  });

  const result = await commands.archive!({ threadId: threadIdFor(SESSION_A) as ThreadId });
  assert.equal(result.applied, true);
  assert.equal(live.invokes.length, 1);
  assert.equal("operation" in live.invokes[0]! && live.invokes[0].operation.kind, "core.abort");
  assert.deepEqual(switches, [{ kind: "fresh" }]);
  assert.deepEqual(archived, [{ sessionId: SESSION_A, skipWriteGrace: true }]);
  assert.equal(sessionRef.current, next.session);
});

test("session.archive of a non-resident session does not abort or switch", async () => {
  const live = fakeSession(snapshotOf(SESSION_B, true));
  const archived: Array<{ sessionId: string; skipWriteGrace?: boolean }> = [];
  const switches: Array<{ kind: string }> = [];
  const sessionRef = { current: live.session as DesktopRuntimeSession | undefined };
  const commands = createDesktopSemanticCommands({
    sessionRef,
    catalog: {
      list: async () => [
        { sessionId: SESSION_A, modifiedAt: T0, messageCount: 1, status: "active" as const },
      ],
    },
    archive: () =>
      ({
        archive: async (sessionId: string, options?: { readonly skipWriteGrace?: boolean }) => {
          archived.push({ sessionId, ...(options?.skipWriteGrace === true ? { skipWriteGrace: true } : {}) });
          return { sessionId, archived: true };
        },
      }) as unknown as StudioSessionArchiveService,
    switchSession: async (intent) => {
      switches.push({ kind: intent.kind });
      return live.session;
    },
    bindSession: (session) => {
      sessionRef.current = session;
    },
    interaction: {} as DesktopInteractionHost,
  });

  await commands.archive!({ threadId: threadIdFor(SESSION_A) as ThreadId });
  assert.equal(live.invokes.length, 0);
  assert.deepEqual(switches, []);
  assert.deepEqual(archived, [{ sessionId: SESSION_A }]);
});
