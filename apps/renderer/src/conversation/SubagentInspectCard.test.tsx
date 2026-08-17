import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationPages } from "@omp-studio/testkit";
import { ConversationItemView } from "./ConversationItemView";
import { SubagentInspectCard } from "./SubagentInspectCard";
import type { SubagentConversationClient } from "./subagentConversationEngine";
import type { SubagentHubTarget } from "./toolMeta";

afterEach(cleanup);

const TARGET: SubagentHubTarget = {
  agentId: "agent-019fcb01",
  toolCallId: "task-1",
  task: "audit lockfile",
};

const taskRow = {
  type: "assistant" as const,
  itemId: "a-task",
  createdAt: "2026-08-17T00:00:00.000Z",
  status: "completed" as const,
  segments: [
    {
      type: "batch" as const,
      key: "batch-task",
      tools: [
        {
          toolCallId: "task-1",
          toolName: "task",
          status: "succeeded" as const,
          arguments: { spawn: { tasks: [{ name: "deps", task: "audit lockfile" }] } },
          result: {
            type: "toolResult" as const,
            toolCallId: "task-1",
            toolName: "task",
            isError: false,
            data: {
              progress: [{ id: "agent-019fcb01", name: "deps", status: "running", task: "audit lockfile" }],
            },
          },
        },
        {
          toolCallId: "read-1",
          toolName: "read",
          status: "succeeded" as const,
          arguments: { path: "package.json" },
        },
      ],
    },
  ],
};

describe("subagent inspect card", () => {
  it("opens from an inspectable card without toggling the batch", () => {
    const onInspect = vi.fn();
    const { container } = render(
      <ConversationItemView row={taskRow} expandAll onInspectSubagent={onInspect} />,
    );
    const batch = container.querySelector(".ev-batch");
    expect(batch?.classList.contains("open")).toBe(true);
    const card = screen.getByRole("button", { name: /deps/ });
    expect(card.classList.contains("is-inspectable")).toBe(true);
    fireEvent.click(card);
    expect(onInspect).toHaveBeenCalledWith(TARGET);
    expect(batch?.classList.contains("open")).toBe(true);
  });

  it("keeps nameless task cards visible but not inspectable", () => {
    const onInspect = vi.fn();
    render(
      <ConversationItemView
        row={{
          ...taskRow,
          segments: [
            {
              type: "batch",
              key: "batch-anon",
              tools: [
                {
                  toolCallId: "task-2",
                  toolName: "task",
                  status: "succeeded",
                  arguments: { spawn: { name: "explore" } },
                  result: {
                    type: "toolResult",
                    toolCallId: "task-2",
                    toolName: "task",
                    isError: false,
                    data: { results: [{ name: "explore", status: "completed" }] },
                  },
                },
              ],
            },
          ],
        }}
        onInspectSubagent={onInspect}
      />,
    );
    const card = screen.getByRole("group", { name: /explore/ });
    expect(card.classList.contains("is-inspectable")).toBe(false);
    fireEvent.click(card);
    expect(onInspect).not.toHaveBeenCalled();
  });

  it("renders preview fixtures with a demo mark and never queries Host", () => {
    const query = vi.fn();
    const client: SubagentConversationClient = {
      query,
      subscribe: () => () => undefined,
    };
    render(
      <SubagentInspectCard
        target={TARGET}
        preview
        client={client}
        runtimeConnected
        onClose={() => undefined}
        onOpenHub={() => undefined}
      />,
    );
    expect(screen.getByRole("dialog", { name: "audit lockfile" })).toBeTruthy();
    expect(screen.getAllByText("演示").length).toBeGreaterThan(0);
    expect(screen.getByText(/已扫过 lockfile/)).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });

  it("closes from the button, backdrop, and Escape, then restores focus", () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(
      <SubagentInspectCard
        target={TARGET}
        preview
        client={null}
        runtimeConnected={false}
        onClose={onClose}
        onOpenHub={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "关闭子 Agent 对话" })).toBe(document.activeElement);
    fireEvent.click(screen.getByRole("button", { name: "关闭子 Agent 对话" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector(".sa-inspect-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.mouseDown(document.querySelector(".sa-inspect")!);
    expect(onClose).toHaveBeenCalledTimes(3);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("jumps to Agent Hub with the real agent id", () => {
    const onOpenHub = vi.fn();
    render(
      <SubagentInspectCard
        target={TARGET}
        preview
        client={null}
        runtimeConnected={false}
        onClose={() => undefined}
        onOpenHub={onOpenHub}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "前往 Agent Hub" }));
    expect(onOpenHub).toHaveBeenCalledWith("agent-019fcb01");
  });

  it("does not recurse inspect into the nested transcript", async () => {
    const query = vi.fn(async () => conversationPages.userAssistant);
    const client: SubagentConversationClient = {
      query: query as SubagentConversationClient["query"],
      subscribe: () => () => undefined,
    };
    render(
      <SubagentInspectCard
        target={TARGET}
        preview={false}
        client={client}
        runtimeConnected
        onClose={() => undefined}
        onOpenHub={() => undefined}
      />,
    );
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledWith("agent.conversation.read", { agentId: "agent-019fcb01", limit: 50 });
    });
    expect(document.querySelector(".sa-inspect .sa-card.is-inspectable")).toBeNull();
  });
});
