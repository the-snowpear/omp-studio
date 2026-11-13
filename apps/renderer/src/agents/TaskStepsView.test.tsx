import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StudioTaskStepState } from "@omp-studio/studio-protocol";
import { TaskStepsView } from "./TaskStepsView";

afterEach(cleanup);
const live: StudioTaskStepState = { prompts: ["Inspect contracts", "Implement the native seam", "Verify native execution", "Report the result"], sent: 2, completed: 1, phase: "running" };

describe("native task phase presentation", () => {
  it("distinguishes dispatch from completion and shows one native prompt group at a time", () => {
    render(<TaskStepsView state={live} zh />);
    expect(screen.getByText("已发送 2/4 组 · 已完成 1/4 组")).toBeTruthy();
    expect(screen.getByText("Implement the native seam")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /第 3 组/ }));
    expect(screen.getByText("Verify native execution")).toBeTruthy();
    expect(screen.queryByText("Implement the native seam")).toBeNull();
  });

  it("keeps a deliberately selected older group while native progress advances", () => {
    const view = render(<TaskStepsView state={live} zh />);
    const first = screen.getByRole("button", { name: /第 1 组/ });
    first.focus(); fireEvent.click(first);
    view.rerender(<TaskStepsView state={{ ...live, sent: 3, completed: 2 }} zh />);
    expect(screen.getByText("Inspect contracts")).toBeTruthy();
    expect(document.activeElement).toBe(first);
    expect(screen.getByText("已发送 3/4 组 · 已完成 2/4 组")).toBeTruthy();
  });

  it.each(["interrupted", "budget"] as const)("does not invent completion or resume controls for a %s stop", phase => {
    render(<TaskStepsView state={{ ...live, phase, reason: phase === "budget" ? "Native request budget reached" : "Stopped by the operator" }} zh />);
    expect(screen.getByText("已发送 2/4 组 · 已完成 1/4 组")).toBeTruthy();
    expect(screen.getAllByText("未发送")).toHaveLength(2);
    expect(screen.getByText(/剩余阶段保留在原任务记录中/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /运行|恢复|继续/ })).toBeNull();
  });

  it("keeps older dispatch-only records unknown and renders prompt text without parsing HTML or Markdown", () => {
    const raw = "# not a phase\n- [x] not execution status\n<img src=x onerror=alert(1)>";
    const view = render(<TaskStepsView state={{ prompts: [raw], sent: 1, completed: 0, phase: "unknown" }} zh />);
    expect(screen.getByText("未记录执行结果")).toBeTruthy();
    expect(view.container.querySelector("pre")?.textContent).toBe(raw);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByText(/已发送不代表最后一组已经完成/)).toBeTruthy();
    view.rerender(<TaskStepsView zh />);
    expect(screen.getByText("暂无原生步骤记录。")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
