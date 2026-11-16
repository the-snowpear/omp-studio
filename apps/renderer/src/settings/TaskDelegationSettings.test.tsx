import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureSettingRow } from "@omp-studio/studio-protocol";
import { selectOption } from "../test/selectOption";
import { TaskDelegationSettings } from "./TaskDelegationSettings";

afterEach(cleanup);
const rows: FeatureSettingRow[] = [{ key: "task.steps", value: false, source: "default" }, { key: "task.autoParallel", value: "off", source: "global" }];

describe("contextual task delegation settings", () => {
  it("writes each native option through the owner and keeps suggestions distinct from execution", () => {
    const save = vi.fn(), clear = vi.fn();
    const view = render(<TaskDelegationSettings rows={rows} disabled={false} zh save={save} clear={clear} />);
    fireEvent.click(screen.getByRole("switch", { name: "向 Agent 提供分步任务" }));
    expect(save).toHaveBeenCalledWith("task.steps", true);
    selectOption(screen.getByRole("combobox", { name: "自动并行委派" }), "只建议");
    expect(save).toHaveBeenCalledWith("task.autoParallel", "suggest");
    view.rerender(<TaskDelegationSettings rows={[rows[0]!, { key: "task.autoParallel", value: "suggest", source: "runtime" }]} disabled={false} zh save={save} clear={clear} />);
    expect(screen.getByText(/只建议：原生 judge 报告可并行的部分，不会因此启动任务/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除会话覆盖" }));
    expect(clear).toHaveBeenCalledWith("task.autoParallel");
    expect(screen.queryByRole("button", { name: /采用建议|启动/ })).toBeNull();
  });

  it("does not supply mock defaults when the native read model omits delegation options", () => {
    const save = vi.fn();
    render(<TaskDelegationSettings rows={[]} disabled={false} zh save={save} clear={vi.fn()} />);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("当前 Runtime 未返回此委派设置。")).toHaveLength(2);
    fireEvent.click(screen.getByRole("switch"));
    expect(save).not.toHaveBeenCalled();
  });

  it("respects the owner's submission lock and settings filters", () => {
    const save = vi.fn();
    render(<TaskDelegationSettings rows={rows} keys={["task.steps"]} disabled zh save={save} clear={vi.fn()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("switch"));
    expect(save).not.toHaveBeenCalled();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  });
});
