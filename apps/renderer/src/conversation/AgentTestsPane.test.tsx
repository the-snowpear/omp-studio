import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTestsPane } from "./AgentTestsPane";
import type { AgentTestRun } from "./agentTestRuns";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const run = (partial: Partial<AgentTestRun> & Pick<AgentTestRun, "toolCallId" | "command" | "status">): AgentTestRun => ({
  itemId: "msg-1",
  ...partial,
});

describe("AgentTestsPane", () => {
  it("shows the honest empty state when the session has no test commands", () => {
    render(
      <AgentTestsPane
        runs={[]}
        rerunDisabled
        rerunTitle="未就绪"
        onRerun={() => undefined}
      />,
    );
    expect(screen.getByText("当前会话还没有 Agent 跑过的测试命令")).toBeTruthy();
    expect(screen.queryByText("Tests 不在公共 contract 中。")).toBeNull();
    expect(screen.queryByRole("button", { name: "请 Agent 再跑" })).toBeNull();
  });

  it("shows the failed log immediately and jumps to the conversation card", () => {
    const onRerun = vi.fn();
    const onReveal = vi.fn();
    const failed = run({
      toolCallId: "fail-1",
      itemId: "msg-9",
      command: "bun test",
      status: "fail",
      exitCode: 1,
      durationMs: 1180,
      cwd: "packages/foo",
      output: "rpc › should negotiate capability v2",
      truncated: true,
    });
    render(
      <AgentTestsPane
        runs={[failed]}
        rerunDisabled={false}
        rerunTitle="重跑"
        onRerun={onRerun}
        onReveal={onReveal}
      />,
    );
    expect(screen.getByText("bun test")).toBeTruthy();
    expect(screen.getByText("packages/foo")).toBeTruthy();
    expect(screen.getByText("失败 · exit 1")).toBeTruthy();
    expect(screen.getByText("已截断")).toBeTruthy();
    expect(screen.getByText("rpc › should negotiate capability v2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "输出" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "在对话中定位这次测试：bun test" }));
    expect(onReveal).toHaveBeenCalledWith(failed);
    fireEvent.click(screen.getByRole("button", { name: "请 Agent 再跑" }));
    expect(onRerun).toHaveBeenCalledWith("bun test");
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("disables rerun when the prompt channel is not ready", () => {
    render(
      <AgentTestsPane
        runs={[run({ toolCallId: "ok", command: "npm test", status: "pass", exitCode: 0 })]}
        rerunDisabled
        rerunTitle="未就绪"
        onRerun={() => undefined}
      />,
    );
    const button = screen.getByRole("button", { name: "请 Agent 再跑" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("data-tip")).toBe("未就绪");
  });
});
