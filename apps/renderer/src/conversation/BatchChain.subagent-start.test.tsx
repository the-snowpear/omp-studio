import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

    // 运行中的尾卡走两帧自动展开：把挂起的动画帧跑完，不让它在测试环境拆除后
    // 再触发 setState（CI 上会以 window is not defined 的未捕获异常失败）。
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  });
});
