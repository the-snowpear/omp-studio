import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInitialConversationState,
  reduceConversationState,
  selectConversationViews,
} from "@omp-studio/client";
import {
  CONVERSATION_FIXTURE_IDS,
  conversationLiveSequence,
  conversationPages,
} from "@omp-studio/testkit";
import { ConversationItemView } from "./ConversationItemView";
import { ConversationPane } from "./ConversationPane";
import { ConvoTranscript } from "./ConvoTranscript";
import { distanceFromBottom, shouldFollow } from "./useConversationScroll";
import {
  applyLiveEvent,
  buildTimeline,
  hydratePage,
  resetConversation,
} from "./conversationViewModel";

afterEach(cleanup);

const identity = {
  runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
  sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
};

describe("plan 07 renderer gate", () => {
  it("MVP-A: client and renderer each show one user and one assistant from the shared page", () => {
    const clientState = reduceConversationState(createInitialConversationState(), {
      type: "hydrate",
      generation: 0,
      page: conversationPages.userAssistant,
    });
    const clientMessages = selectConversationViews(clientState).filter(
      (view) => view.kind === "item" && view.item.kind === "message",
    );
    expect(clientMessages).toHaveLength(2);

    let rendererState = resetConversation(1, identity, "ready");
    rendererState = hydratePage(rendererState, conversationPages.userAssistant, 1, "replace");
    const rows = buildTimeline(rendererState).filter((row) => row.type === "user" || row.type === "assistant");
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.type === "user")).toHaveLength(1);
    expect(rows.filter((row) => row.type === "assistant")).toHaveLength(1);

    render(<ConvoTranscript rows={buildTimeline(rendererState)} />);
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("world")).toBeTruthy();
    expect(document.querySelector("[data-demo], .convo-demo-banner")).toBeNull();
  });

  it("MVP-B: live sequence is one assistant node; completed replaces live; reload uses history", () => {
    let rendererState = resetConversation(1, identity, "ready");
    rendererState = hydratePage(rendererState, conversationPages.empty, 1, "replace");
    for (const [index, event] of conversationLiveSequence.entries()) {
      rendererState = applyLiveEvent(rendererState, event, identity, index + 1);
    }
    const liveRows = buildTimeline(rendererState).filter((row) => row.type === "assistant");
    expect(liveRows).toHaveLength(1);
    expect(rendererState.liveMessages[CONVERSATION_FIXTURE_IDS.assistantItemId]).toBeUndefined();
    expect(rendererState.liveTools[CONVERSATION_FIXTURE_IDS.toolCallId]?.status).toBe("succeeded");
    expect(liveRows[0]?.type === "assistant" && liveRows[0].segments.some((segment) => segment.type === "batch")).toBe(true);

    rendererState = hydratePage(rendererState, conversationPages.thinkingTool, 1, "replace");
    const historyRows = buildTimeline(rendererState).filter((row) => row.type === "assistant");
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]?.status === undefined || historyRows[0]?.status !== "streaming").toBe(true);
  });

  it("reload of the same shared page does not duplicate rows", () => {
    let rendererState = resetConversation(1, identity, "ready");
    rendererState = hydratePage(rendererState, conversationPages.userAssistant, 1, "replace");
    rendererState = hydratePage(rendererState, conversationPages.userAssistant, 1, "replace");
    expect(buildTimeline(rendererState).filter((row) => row.type === "user" || row.type === "assistant")).toHaveLength(2);
  });

  it("HTML/script from transcript text is rendered as text", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "evil",
          createdAt: "2026-08-15T12:00:00.000Z",
          text: '<script>alert(1)</script><img src=x onerror="alert(1)">',
        }}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("truncated tool result shows a visible 已截断 mark", () => {
    let rendererState = resetConversation(1, identity, "ready");
    rendererState = hydratePage(
      rendererState,
      {
        ...conversationPages.thinkingTool,
        items: conversationPages.thinkingTool.items.map((item) => {
          if (item.kind !== "message" || item.role !== "assistant") return item;
          return {
            ...item,
            content: item.content.map((block) =>
              block.type === "toolResult" ? { ...block, truncated: true as const } : block,
            ),
          };
        }),
      },
      1,
      "replace",
    );
    const row = buildTimeline(rendererState).find((entry) => entry.type === "assistant");
    expect(row?.type).toBe("assistant");
    if (row?.type === "assistant") {
      const batch = row.segments.find((segment) => segment.type === "batch");
      expect(batch?.type === "batch" ? batch.tools[0]?.truncated : undefined).toBe(true);
    }
    render(<ConversationItemView row={row!} />);
    fireEvent.click(screen.getByRole("button", { name: /Read/ }));
    expect(screen.getByRole("note", { name: "已截断" })).toBeTruthy();
    expect(screen.getByText("已截断")).toBeTruthy();
  });

  it("scroll-follow is proven here, not by Desktop E2E", () => {
    expect(shouldFollow(distanceFromBottom({ scrollHeight: 1000, scrollTop: 940, clientHeight: 80 }))).toBe(true);
    expect(shouldFollow(distanceFromBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 80 }))).toBe(false);
  });

  it("real mode transcript does not show the preview demo banner", () => {
    let rendererState = resetConversation(1, identity, "ready");
    rendererState = hydratePage(rendererState, conversationPages.userAssistant, 1, "replace");
    render(<ConvoTranscript rows={buildTimeline(rendererState)} />);
    expect(screen.queryByText("演示")).toBeNull();
  });

  it("missing conversation snapshot does not throw reading state", () => {
    render(<ConversationPane onLoadOlder={() => undefined} />);
    expect(screen.getByLabelText("对话内容")).toBeTruthy();
    expect(screen.getByText("对话不可用")).toBeTruthy();
    expect(screen.queryByText(/Cannot read properties of undefined/)).toBeNull();
  });
});
