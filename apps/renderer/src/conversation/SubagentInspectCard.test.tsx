import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationPages } from "@omp-studio/testkit";
import type { AgentId, Generation, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { ConversationItemView } from "./ConversationItemView";
import { SubagentInspectCard } from "./SubagentInspectCard";
import type { SubagentConversationClient } from "./subagentConversationEngine";
import type { SubagentComposerClient } from "./useSubagentComposer";
import type { SubagentHubTarget } from "./toolMeta";

afterEach(cleanup);

const TARGET: SubagentHubTarget = {
  agentId: "agent-019fcb01",
  toolCallId: "task-1",
  task: "audit lockfile",
};

const LIVE_AGENT: StudioAgentSnapshot = {
  agentId: "agent-019fcb01" as AgentId,
  generation: 1 as Generation,
  kind: "task",
  displayName: "deps",
  status: "idle",
  updatedAt: "2026-08-17T00:00:00.000Z",
  hasLiveSession: true,
  hasTranscript: true,
  unreadCount: 0,
  activeJobIds: [],
};

const SEND: SubagentComposerClient = {
  command: vi.fn(),
  subscribe: () => () => undefined,
};

function renderInspect(overrides: {
  preview?: boolean;
  client?: SubagentConversationClient | null;
  sendClient?: SubagentComposerClient | null;
  agents?: readonly StudioAgentSnapshot[];
  canSend?: boolean;
  runtimeConnected?: boolean;
  onClose?: () => void;
  onOpenHub?: (agentId: string) => void;
} = {}) {
  return render(
    <SubagentInspectCard
      target={TARGET}
      preview={overrides.preview ?? true}
      client={overrides.client ?? null}
      sendClient={overrides.sendClient ?? null}
      agents={overrides.agents ?? []}
      canSend={overrides.canSend ?? false}
      runtimeConnected={overrides.runtimeConnected ?? false}
      onClose={overrides.onClose ?? (() => undefined)}
      onOpenHub={overrides.onOpenHub ?? (() => undefined)}
    />,
  );
}

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

  it("opens a Runtime-allocated task id such as deps", () => {
    const onInspect = vi.fn();
    render(
      <ConversationItemView
        row={{
          ...taskRow,
          segments: [
            {
              type: "batch",
              key: "batch-runtime",
              tools: [
                {
                  toolCallId: "task-3",
                  toolName: "task",
                  status: "succeeded",
                  arguments: { spawn: { tasks: [{ name: "deps", task: "audit lockfile" }] } },
                  result: {
                    type: "toolResult",
                    toolCallId: "task-3",
                    toolName: "task",
                    isError: false,
                    data: { results: [{ id: "deps", agent: "scout", status: "completed", task: "audit lockfile" }] },
                  },
                },
              ],
            },
          ],
        }}
        onInspectSubagent={onInspect}
      />,
    );
    const card = screen.getByRole("button", { name: /deps/ });
    expect(card.classList.contains("is-inspectable")).toBe(true);
    fireEvent.click(card);
    expect(onInspect).toHaveBeenCalledWith({
      agentId: "deps",
      toolCallId: "task-3",
      task: "audit lockfile",
    });
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
    renderInspect({ preview: true, client, runtimeConnected: true });
    expect(screen.getByRole("dialog", { name: "audit lockfile" })).toBeTruthy();
    expect(document.querySelector(".sa-inspect-dim")).toBeTruthy();
    expect(screen.getAllByText("演示").length).toBeGreaterThan(0);
    expect(screen.getByText(/已扫过 lockfile/)).toBeTruthy();
    expect(document.querySelector("#saInspectComposer")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("hides the composer in preview even when the roster would allow chat", () => {
    renderInspect({
      preview: true,
      sendClient: SEND,
      agents: [LIVE_AGENT],
      canSend: true,
      runtimeConnected: true,
    });
    expect(document.querySelector("#saInspectComposer")).toBeNull();
  });

  it("shows ChipComposer when the subagent can receive agent.send", () => {
    const query = vi.fn(async () => conversationPages.userAssistant);
    const client: SubagentConversationClient = {
      query: query as SubagentConversationClient["query"],
      subscribe: () => () => undefined,
    };
    renderInspect({
      preview: false,
      client,
      sendClient: SEND,
      agents: [LIVE_AGENT],
      canSend: true,
      runtimeConnected: true,
    });
    expect(document.querySelector(".sa-inspect.has-composer #saInspectComposer")).toBeTruthy();
    expect(document.querySelector(".chip-composer-editor")?.getAttribute("aria-placeholder")).toMatch(/发给子 Agent/);
    expect(screen.getByRole("button", { name: "附件 / 图片" })).toBeTruthy();
  });

  it("hides ChipComposer for a terminal agent", () => {
    const query = vi.fn(async () => conversationPages.userAssistant);
    const client: SubagentConversationClient = {
      query: query as SubagentConversationClient["query"],
      subscribe: () => () => undefined,
    };
    renderInspect({
      preview: false,
      client,
      sendClient: SEND,
      agents: [{ ...LIVE_AGENT, status: "aborted" }],
      canSend: true,
      runtimeConnected: true,
    });
    expect(document.querySelector("#saInspectComposer")).toBeNull();
  });

  it("closes from the button after the leave animation and restores focus", async () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = renderInspect({ preview: true, onClose });
    expect(screen.getByRole("button", { name: "关闭子 Agent 对话" })).toBe(document.activeElement);
    fireEvent.click(screen.getByRole("button", { name: "关闭子 Agent 对话" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".sa-inspect.is-leave")).toBeTruthy();
    expect(document.querySelector(".sa-inspect-dim.is-leave")).toBeTruthy();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(document.querySelector(".sa-inspect-dim")!);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector(".sa-inspect")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("closes from the dim and Escape after the leave animation, not from clicks on the dialog", async () => {
    const onClose = vi.fn();
    renderInspect({ preview: true, onClose });
    fireEvent.mouseDown(document.querySelector(".sa-inspect")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".sa-inspect.is-leave")).toBeNull();
    fireEvent.mouseDown(document.querySelector(".sa-inspect-dim")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".sa-inspect.is-leave")).toBeTruthy();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("closes from Escape after the leave animation", async () => {
    const onClose = vi.fn();
    renderInspect({ preview: true, onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".sa-inspect.is-leave")).toBeTruthy();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("closes immediately when reduced motion is preferred", () => {
    const previous = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const onClose = vi.fn();
      renderInspect({ preview: true, onClose });
      fireEvent.click(screen.getByRole("button", { name: "关闭子 Agent 对话" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.querySelector(".sa-inspect.is-leave")).toBeNull();
    } finally {
      window.matchMedia = previous;
    }
  });

  it("jumps to Agent Hub after the leave animation with the real agent id", async () => {
    const onOpenHub = vi.fn();
    const onClose = vi.fn();
    renderInspect({ preview: true, onOpenHub, onClose });
    fireEvent.click(screen.getByRole("button", { name: "前往 Agent Hub" }));
    expect(onOpenHub).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(onOpenHub).toHaveBeenCalledWith("agent-019fcb01");
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("does not recurse inspect into the nested transcript", async () => {
    const query = vi.fn(async () => conversationPages.userAssistant);
    const client: SubagentConversationClient = {
      query: query as SubagentConversationClient["query"],
      subscribe: () => () => undefined,
    };
    renderInspect({
      preview: false,
      client,
      runtimeConnected: true,
    });
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledWith("agent.conversation.read", { agentId: "agent-019fcb01", limit: 50 });
    });
    expect(document.querySelector(".sa-inspect .sa-card.is-inspectable")).toBeNull();
  });

  it("overlays Hub roster usage onto a spawn-placeholder compact card", () => {
    render(
      <ConversationItemView
        row={{
          ...taskRow,
          segments: [{
            type: "batch",
            key: "batch-placeholder",
            tools: [{
              toolCallId: "task-1",
              toolName: "task",
              status: "running",
              arguments: { spawn: { tasks: [{ name: "WorkerAlpha", task: "scan lockfile" }] } },
              result: {
                type: "toolResult",
                toolCallId: "task-1",
                toolName: "task",
                isError: false,
                data: {
                  progress: [{
                    id: "WorkerAlpha",
                    name: "WorkerAlpha",
                    status: "pending",
                    tokens: "[redacted]",
                    requests: 0,
                    durationMs: 0,
                  }],
                },
              },
            }],
          }],
        }}
        liveAgents={[{
          ...LIVE_AGENT,
          agentId: "WorkerAlpha" as AgentId,
          displayName: "WorkerAlpha",
          status: "running",
          assignment: "scan lockfile",
          usage: { tokens: 12_600, requests: 9, tools: 14, cost: 0.51, durationMs: 38_000 },
        }]}
        onInspectSubagent={vi.fn()}
      />,
    );
    const card = screen.getByRole("button", { name: /WorkerAlpha/ });
    expect(card.classList.contains("running")).toBe(true);
    expect(card.querySelector(".hub-act")?.textContent).toBe("Thinking");
    expect(card.querySelector(".sa-dur")?.textContent).toBe("38.0s");
    expect(card.querySelector(".sa-tok")?.textContent).toBe("12.6ktok");
    expect(card.querySelector(".sa-metrics")?.textContent).toContain("req9");
    expect(card.textContent).not.toContain("[redacted]");
  });

  it("puts token, tool, and cost counts on the compact card data row", () => {
    const onInspect = vi.fn();
    render(
      <ConversationItemView
        row={{
          ...taskRow,
          segments: [{
            type: "batch",
            key: "batch-metrics",
            tools: [{
              toolCallId: "task-1",
              toolName: "task",
              status: "succeeded",
              arguments: { spawn: { tasks: [{ name: "deps", task: "audit lockfile" }] } },
              result: {
                type: "toolResult",
                toolCallId: "task-1",
                toolName: "task",
                isError: false,
                data: {
                  progress: [{
                    id: "agent-019fcb01",
                    name: "deps",
                    status: "running",
                    task: "audit lockfile",
                    tokens: "12.6k",
                    tools: 8,
                    cost: "¥ 0.51",
                  }],
                },
              },
            }],
          }],
        }}
        onInspectSubagent={onInspect}
      />,
    );
    const card = screen.getByRole("button", { name: /deps/ });
    expect(card.querySelector(".sa-top .sa-name")?.textContent).toBe("deps");
    expect(card.querySelector(".sa-top .sa-tok")).toBeNull();
    const metrics = card.querySelector(":scope > .sa-metrics");
    expect(metrics?.querySelector(".sa-tok")?.textContent).toBe("12.6ktok");
    expect(metrics?.querySelector(".hub-num")?.textContent).toBe("tools8");
    expect(metrics?.querySelector(".sa-cost")?.textContent).toBe("¥ 0.51");
    fireEvent.click(card);
    expect(onInspect).toHaveBeenCalledWith({
      ...TARGET,
      tokens: "12.6k",
      tools: 8,
      cost: "¥ 0.51",
    });
  });

  it("shows live usage on the inspect title row in the same chips", () => {
    renderInspect({
      preview: true,
      agents: [{
        ...LIVE_AGENT,
        usage: { tokens: 12_600, requests: 9, tools: 14, cost: 0.51, durationMs: 167_000 },
      }],
    });
    const head = document.querySelector(".sa-inspect-head");
    expect(head?.querySelector(".sa-tok")?.textContent).toBe("12.6ktok");
    expect(head?.querySelector(".hub-num")?.textContent).toContain("14");
    expect(head?.querySelector(".sa-cost")?.textContent).toBe("$0.510");
  });
});
