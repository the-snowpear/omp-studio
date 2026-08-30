import { describe, expect, it } from "vitest";
import type { ConversationMessageItem, SessionId } from "@omp-studio/client-contract";
import { buildPersistedTimelineRow, emptyConversationState, type ConversationState } from "./conversationViewModel";

const sessionId = "session" as SessionId;

function assistantWithTool(): ConversationMessageItem {
  return {
    kind: "message",
    itemId: "assistant",
    parentId: null,
    createdAt: "now",
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "task-1", toolName: "task", arguments: { agent: "explorer", task: "Inspect the renderer" } }],
  };
}

describe("conversation tool lifecycle projection", () => {
  it("uses the matching live completion before the turn closes", () => {
    const item = assistantWithTool();
    const result = { type: "toolResult" as const, toolCallId: "task-1", toolName: "task", output: "done", isError: false };
    const state: ConversationState = {
      ...emptyConversationState(),
      identity: { sessionId },
      items: [item],
      openTurnItems: { assistant: "turn-1" },
      liveTools: {
        "task-1": {
          toolCallId: "task-1",
          messageId: "assistant",
          turnId: "turn-1",
          toolName: "task",
          result,
          status: "succeeded",
        },
      },
    };

    const row = buildPersistedTimelineRow(state, item);

    expect(row).toMatchObject({
      type: "assistant",
      turnOpen: true,
      segments: [{ type: "batch", tools: [{ toolCallId: "task-1", status: "succeeded", result }] }],
    });
  });

  it("keeps live output on a persisted call while it is running", () => {
    const item = assistantWithTool();
    const state: ConversationState = {
      ...emptyConversationState(),
      items: [item],
      openTurnItems: { assistant: "turn-1" },
      liveTools: {
        "task-1": {
          toolCallId: "task-1",
          messageId: "assistant",
          turnId: "turn-1",
          toolName: "task",
          output: "starting agent",
          status: "running",
        },
      },
    };

    const row = buildPersistedTimelineRow(state, item);
    expect(row.type === "assistant" ? row.segments[0] : undefined).toMatchObject({
      type: "batch",
      tools: [{ status: "running", output: "starting agent" }],
    });
  });
});
