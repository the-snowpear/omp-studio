import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityLine } from "./ActivityLine";
import { deriveActivityStatus } from "./activityStatus";
import { emptyConversationState, type ConversationState } from "./conversationViewModel";

describe("ActivityLine", () => {
  it("shows a pre-response send operation under the optimistic user row", () => {
    const view = render(<ActivityLine status={{ phase: "waiting", glyph: "working", label: "Starting OMP" }} />);
    expect(screen.getByRole("status").textContent).toContain("working");
    expect(screen.getByRole("status").textContent).toContain("Starting OMP");
    view.unmount();
  });

  it("changes the decorative glyph with live phases, tool kinds and retry backoff", () => {
    const state = emptyConversationState(1);
    const live = (blockType: "text" | "thinking"): ConversationState => ({
      ...state,
      liveOrder: ["message"],
      liveMessages: {
        message: { messageId: "message", turnId: "turn", role: "assistant", createdAt: "2026-11-22T00:00:00Z", aborted: false, blocks: [{ blockId: "block", blockType, text: "" }] },
      },
    });
    const tool = (toolName: string): ConversationState => ({
      ...state,
      liveTools: { call: { toolCallId: "call", messageId: "message", turnId: "turn", toolName, status: "running" } },
    });
    const inputs = [
      { state, streaming: true, pendingMessages: 0 },
      { state, streaming: false, pendingMessages: 1 },
      { state: live("thinking"), streaming: true, pendingMessages: 0 },
      { state: live("text"), streaming: true, pendingMessages: 0 },
      { state: tool("read"), streaming: true, pendingMessages: 0 },
      { state: tool("ast_edit"), streaming: true, pendingMessages: 0 },
      { state: tool("eval"), streaming: true, pendingMessages: 0 },
      { state: tool("grep"), streaming: true, pendingMessages: 0 },
      { state: tool("mcp__server_tool"), streaming: true, pendingMessages: 0 },
      { state, streaming: false, pendingMessages: 0, retry: { attempt: 2, maxAttempts: 5 } },
      { state, streaming: false, pendingMessages: 0, retry: { attempt: 2, maxAttempts: 5, nextRetryAt: Date.now() + 5000 } },
    ];
    const expected = ["working", "working", "thinking", "responding", "read", "edit", "bash", "search", "working", "working", "retry"];
    const view = render(<ActivityLine status={deriveActivityStatus(inputs[0]!)!} />);
    for (const [index, input] of inputs.entries()) {
      view.rerender(<ActivityLine status={deriveActivityStatus(input)!} />);
      const glyph = view.container.querySelector(".al-glyph");
      expect(glyph?.getAttribute("data-glyph")).toBe(expected[index]);
      expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    }
    view.unmount();
  });
});
