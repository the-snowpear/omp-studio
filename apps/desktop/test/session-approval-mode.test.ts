/**
 * permissions.mode.set must stay callable during a live turn so the Host can
 * record the next-turn trust level instead of returning BUSY_STREAMING.
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

import type { DesktopRuntimeSession } from "../src/host-composition.js";
import type { DesktopInteractionHost } from "../src/interaction-host.js";
import { createDesktopSemanticCommands } from "../src/session-commands.js";

const SESSION = "sess-live" as SessionId;
const T0 = "2026-08-19T00:00:00.000Z";

function snapshotOf(sessionId: SessionId, streaming: boolean): OperatorStateSnapshot {
  return {
    runtimeId: "rt-0001" as RuntimeId,
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 4 as StateVersion,
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

function fakeSession(streaming: boolean): DesktopRuntimeSession {
  const snapshot = snapshotOf(SESSION, streaming);
  return {
    controller: {
      publication: () => ({ commitSeq: 1, publishedAt: T0, snapshot, terminalOutcomes: [] }),
    },
    hello: () => ({ runtimeId: "rt-0001", runtimeEpoch: 1 }),
    onPublication: () => () => {},
    capabilityManifest: () => undefined,
    commandManifest: () => undefined,
  } as unknown as DesktopRuntimeSession;
}

test("setApprovalMode while streaming still forwards to applyApprovalMode", async () => {
  const applied: string[] = [];
  const commands = createDesktopSemanticCommands({
    sessionRef: { current: fakeSession(true) },
    catalog: { list: async () => [] },
    applyApprovalMode: async (mode) => {
      applied.push(mode);
      return { mode, syncStatus: "complete", appliedSessions: 1, failedSessions: 0 };
    },
    bindSession: () => {},
    interaction: {} as DesktopInteractionHost,
  });

  const result = await commands.setApprovalMode!({ mode: "write" });
  assert.deepEqual(applied, ["write"]);
  assert.deepEqual(result, { mode: "write", syncStatus: "complete", appliedSessions: 1, failedSessions: 0 });
});
