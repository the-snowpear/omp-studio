import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentId, Generation, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { BatchChain } from "./BatchChain";
import type { ToolView } from "./conversationViewModel";

afterEach(cleanup);

describe("BatchChain subagent start", () => {
  it("renders a starting subagent card from task arguments", async () => {
    const tool: ToolView = {
      toolCallId: "task-1",
      toolName: "task",
      arguments: { name: "renderer", agent: "explorer", task: "Inspect renderer" },
      status: "running",
    };

    const { container } = render(
      <BatchChain items={[{ kind: "tool", tool }]} batchKey="task-chain" liveTail />,
    );

    expect(container.querySelector(".subagent-strip .sa-card")?.textContent).toContain("renderer");
    expect(container.querySelector(".subagent-strip .hub-act")?.textContent).toBe("Starting");
    expect(container.querySelector(".sa-task")?.textContent).toBe("Inspect renderer");

    // 运行中的尾卡走两帧自动展开：把挂起的动画帧跑完，不让它在测试环境拆除后
    // 再触发 setState（CI 上会以 window is not defined 的未捕获异常失败）。
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  });

  it("shows the assignment without a duplicate latest activity row", () => {
    const tool: ToolView = {
      toolCallId: "task-live",
      toolName: "task",
      arguments: { name: "renderer", task: "Review the renderer layout" },
      status: "succeeded",
      result: {
        type: "toolResult", toolCallId: "task-live", isError: false,
        data: { progress: [{
          id: "renderer", status: "running", currentTool: "grep",
          currentToolIntent: "Find the conversation card styles",
        }] },
      },
    };
    const { container } = render(<BatchChain items={[{ kind: "tool", tool }]} batchKey="task-live" />);
    expect(container.querySelector(".sa-task")?.textContent).toBe("Review the renderer layout");
    expect(container.querySelector(".sa-brief")?.textContent).toBe("Review the renderer layout");
    expect(container.querySelector(".sa-activity")).toBeNull();
  });

  it("refreshes the brief from the live roster and still opens the same agent", () => {
    const tool: ToolView = {
      toolCallId: "task-brief",
      toolName: "task",
      arguments: { agents: [{ id: "renderer", name: "renderer", status: "done", task: "Old task", lastTool: "Read · App.tsx" }] },
      status: "succeeded",
    };
    const onInspectSubagent = vi.fn();
    const { container, rerender } = render(<BatchChain items={[{ kind: "tool", tool }]} batchKey="task-brief" onInspectSubagent={onInspectSubagent} />);
    expect(container.querySelector(".sa-task")?.textContent).toBe("Old task");

    const live: StudioAgentSnapshot = {
      agentId: "renderer" as AgentId, generation: 1 as Generation, kind: "task", displayName: "renderer", status: "running",
      assignment: "Refine the subagent cards", stage: "Checking the narrow layout",
      updatedAt: "2026-11-04T00:00:00Z", hasLiveSession: true, hasTranscript: true, unreadCount: 0, activeJobIds: [],
    };
    rerender(<BatchChain items={[{ kind: "tool", tool }]} batchKey="task-brief" liveAgents={[live]} onInspectSubagent={onInspectSubagent} />);
    expect(container.querySelector(".sa-task")?.textContent).toBe("Refine the subagent cards");
    expect(container.querySelector(".sa-brief")?.textContent).toBe("Refine the subagent cards");
    fireEvent.click(screen.getByRole("button", { name: /renderer.*打开对话/ }));
    expect(onInspectSubagent).toHaveBeenCalledWith(expect.objectContaining({ agentId: "renderer", task: "Refine the subagent cards" }));
  });
});
