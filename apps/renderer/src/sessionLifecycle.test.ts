import { describe, expect, it } from "vitest";
import type {
  ClientInteraction,
  CommandReceipt,
  CommandRequestId,
  CommandState,
  EnvironmentId,
  HistoryEntryId,
  InteractionId,
  RuntimeEpoch,
  RuntimeId,
  SessionHistoryEntry,
  SessionId,
  StateVersion,
  ThreadId,
} from "@omp-studio/client-contract";
import {
  createResumeGenerationGate,
  isNewConversationAvailable,
  NEW_CONVERSATION_UNAVAILABLE_REASON,
  resumeHistoryEntry,
  selectPendingInteraction,
  waitForCommandReceipt,
} from "./sessionLifecycle";

function confirm(requestId: string): ClientInteraction {
  return {
    kind: "confirm",
    interactionId: `int-${requestId}` as InteractionId,
    sessionId: "session-1" as SessionId,
    leaseGeneration: 1,
    title: "Continue?",
    requestId: requestId as CommandRequestId,
    message: "Continue?",
    destructive: false,
  };
}

function history(id: string): SessionHistoryEntry {
  return {
    historyId: `hist-${id}` as HistoryEntryId,
    threadId: `thread-${id}` as ThreadId,
    environmentId: `env-${id}` as EnvironmentId,
    title: id,
    startedAt: "2026-08-15T00:00:00.000Z",
    lastActiveAt: "2026-08-15T00:00:00.000Z",
    messageCount: 1,
    status: "active",
  };
}

describe("sessionLifecycle", () => {
  it("treats new conversation as available under the current shell contract", () => {
    // The production shell exposes session.create end to end. The reason text
    // remains available for adapters that intentionally omit that command.
    expect(isNewConversationAvailable()).toBe(true);
    expect(NEW_CONVERSATION_UNAVAILABLE_REASON).toMatch(/session.create/);
  });

  it("selects the current interaction_required identity instead of an arbitrary first command", () => {
    const commands: Record<string, CommandState> = {
      old: {
        requestId: "old" as CommandRequestId,
        commandName: "core.prompt",
        status: "accepted",
        acceptedAt: "2026-08-15T00:00:00.000Z",
      },
      live: {
        requestId: "live" as CommandRequestId,
        commandName: "core.prompt",
        status: "interaction_required",
        interaction: confirm("live"),
      },
    };
    expect(selectPendingInteraction(commands)?.requestId).toBe("live");
    expect(selectPendingInteraction({})).toBeNull();
  });

  it("calls session.resume with the opaque threadId and ignores a late A after B", async () => {
    const calls: string[] = [];
    const listeners = new Map<string, Array<(event: { kind: string; receipt?: CommandReceipt }) => void>>();
    const client = {
      async command(_name: "session.resume", input: { threadId: ThreadId }) {
        calls.push(input.threadId);
        const requestId = `req-${input.threadId}` as CommandRequestId;
        return { requestId };
      },
      subscribe(scope: { scope: "command"; requestId: CommandRequestId }, listener: (event: { kind: string; receipt?: CommandReceipt }) => void) {
        const bucket = listeners.get(scope.requestId) ?? [];
        bucket.push(listener);
        listeners.set(scope.requestId, bucket);
        return () => undefined;
      },
    };
    const gate = createResumeGenerationGate();
    const completed = (requestId: string): CommandReceipt => ({
      requestId: requestId as CommandRequestId,
      commandName: "session.resume",
      status: "completed",
      result: {
        runtimeId: "rt-1" as RuntimeId,
        runtimeEpoch: 1 as RuntimeEpoch,
        stateVersion: 1 as StateVersion,
        sessionId: "sess-1" as SessionId,
        isStreaming: false,
        isCompacting: false,
        activeMode: "normal", approvalMode: "yolo",
        pendingMessages: 0,
        activeCommandIds: [],
        agentsRevision: 0,
        jobsRevision: 0,
        agents: [],
        jobs: [],
      },
      observedAt: "2026-08-15T00:00:02.000Z",
    });
    const aPromise = resumeHistoryEntry(client, history("a"), gate);
    const bPromise = resumeHistoryEntry(client, history("b"), gate);
    await Promise.resolve();
    await Promise.resolve();
    for (const listener of listeners.get("req-thread-b") ?? []) {
      listener({ kind: "command.receipt", receipt: completed("req-thread-b") });
    }
    const bResult = await bPromise;
    expect(gate.isCurrent(bResult.generation)).toBe(true);
    for (const listener of listeners.get("req-thread-a") ?? []) {
      listener({ kind: "command.receipt", receipt: completed("req-thread-a") });
    }
    const aResult = await aPromise;
    expect(gate.isCurrent(aResult.generation)).toBe(false);
    expect(calls).toEqual(["thread-a", "thread-b"]);
  });

  it("resolves a terminal receipt that already landed before subscribe", async () => {
    const requestId = "req-already" as CommandRequestId;
    const receipt: CommandReceipt = {
      requestId,
      commandName: "core.prompt",
      status: "failed",
      error: { code: "INTERNAL_ERROR", message: "prompt failed" },
      observedAt: "2026-08-15T00:00:03.000Z",
    };
    const client = {
      subscribe() {
        return () => undefined;
      },
      getState() {
        return { commands: { [requestId]: receipt } };
      },
    };
    await expect(waitForCommandReceipt(client, requestId)).resolves.toEqual(receipt);
  });
});
