import { describe, expect, it } from "vitest";
import { createInitialClientState, type ClientState } from "@omp-studio/client";
import type { ClientEvent, CommandRequestId, EventCursor, IdempotencyKey, RuntimeEpoch, SessionId, StateVersion } from "@omp-studio/client-contract";
import {
  clientShellChanged,
  layoutRestoreNeeded,
  liveToolActivitySignature,
  shouldRecordShellEvent,
  toShellEventLogEntry,
} from "./shellMemory";

const TS = "2026-08-19T00:00:00.000Z";

function conversationChanged(kind: "conversation.message.delta" | "conversation.message.completed" | "conversation.tool.updated"): ClientEvent {
  const update =
    kind === "conversation.message.delta"
      ? {
          kind,
          sessionId: "s1" as SessionId,
          turnId: "t1",
          messageId: "m1",
          blockId: "b1",
          blockType: "text" as const,
          delta: "x".repeat(1024),
        }
      : kind === "conversation.tool.updated"
        ? {
            kind,
            sessionId: "s1" as SessionId,
            turnId: "t1",
            toolCallId: "c1",
            updateMode: "replace" as const,
            output: "x".repeat(1024),
          }
        : {
            kind,
            sessionId: "s1" as SessionId,
            turnId: "t1",
            messageId: "m1",
            item: {
              kind: "message" as const,
              itemId: "m1",
              parentId: null,
              role: "assistant" as const,
              createdAt: TS,
              content: [{ type: "text" as const, text: "done" }],
            },
          };
  return {
    kind: "conversation.changed",
    authorityEpoch: 1 as ClientEvent["authorityEpoch"],
    runtimeEpoch: 1 as RuntimeEpoch,
    stateVersion: 1 as StateVersion,
    cursor: "42" as EventCursor,
    occurredAt: TS,
    sessionId: "s1" as SessionId,
    eventSeq: 7,
    update,
  };
}

function withLiveTool(state: ClientState, output: string, status: "started" | "updated" = "updated"): ClientState {
  return {
    ...state,
    conversation: {
      ...state.conversation,
      liveTools: {
        c1: {
          toolCallId: "c1",
          turnId: "t1",
          toolName: "bash",
          status,
          output,
        },
      },
    },
  };
}

describe("shell memory gate", () => {
  it("does not record streaming conversation payloads that would retain full tool/text frames in App state", () => {
    expect(shouldRecordShellEvent(conversationChanged("conversation.message.delta"))).toBe(false);
    expect(shouldRecordShellEvent(conversationChanged("conversation.tool.updated"))).toBe(false);
    expect(shouldRecordShellEvent(conversationChanged("conversation.message.completed"))).toBe(true);
  });

  it("strips live payloads from the event log row", () => {
    const event = conversationChanged("conversation.message.completed");
    expect(toShellEventLogEntry(event)).toEqual({
      cursor: event.cursor,
      kind: event.kind,
      occurredAt: event.occurredAt,
    });
    expect(toShellEventLogEntry(event)).not.toHaveProperty("update");
  });

  it("treats growing tool stdout as the same explorer activity so App does not re-render per chunk", () => {
    const idle = createInitialClientState();
    const started = withLiveTool(idle, "", "started");
    const firstChunk = withLiveTool(idle, "hello", "updated");
    const laterChunk = withLiveTool(idle, "hello\nworld".repeat(200), "updated");
    expect(liveToolActivitySignature(started.conversation.liveTools)).not.toBe(
      liveToolActivitySignature(firstChunk.conversation.liveTools),
    );
    expect(liveToolActivitySignature(firstChunk.conversation.liveTools)).toBe(
      liveToolActivitySignature(laterChunk.conversation.liveTools),
    );
    expect(clientShellChanged(firstChunk, laterChunk)).toBe(false);
  });

  it("still treats a new command receipt as a shell change", () => {
    const idle = createInitialClientState();
    const next: ClientState = {
      ...idle,
      commands: {
        ["req-1" as CommandRequestId]: {
          requestId: "req-1" as CommandRequestId,
          commandName: "session.resume",
          status: "local_pending",
          idempotencyKey: "idem-1" as IdempotencyKey,
          issuedAt: TS,
        },
      },
    };
    expect(clientShellChanged(idle, next)).toBe(true);
  });
});

describe("layoutRestoreNeeded", () => {
  it("restores saved chrome when leaving preview even if the layout scope is unchanged", () => {
    expect(layoutRestoreNeeded({
      preview: false,
      rememberLayout: true,
      leavingPreview: true,
      appliedScope: "global",
      layoutScope: "global",
    })).toBe(true);
  });

  it("skips restore while preview is on or layout memory is disabled", () => {
    expect(layoutRestoreNeeded({
      preview: true,
      rememberLayout: true,
      leavingPreview: false,
      appliedScope: null,
      layoutScope: "global",
    })).toBe(false);
    expect(layoutRestoreNeeded({
      preview: false,
      rememberLayout: false,
      leavingPreview: true,
      appliedScope: null,
      layoutScope: "global",
    })).toBe(false);
  });
});
