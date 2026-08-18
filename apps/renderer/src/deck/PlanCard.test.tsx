import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanReviewDeck, PlanViewDialog } from "./PlanCard";

afterEach(cleanup);

const BODY = "## 目标\n\nFreeze the protocol.\n\n## 步骤\n\nDo work.\n";

describe("PlanReviewDeck", () => {
  it("shows the plan title, markdown body, and four review actions", () => {
    const onAction = vi.fn();
    const view = render(<PlanReviewDeck title="Preview 缩放惯性" body={BODY} onAction={onAction} />);
    expect(view.container.querySelector(".deck.active.preview-queue")).toBeTruthy();
    expect(screen.getByText("Plan Review")).toBeTruthy();
    expect(screen.getByText("Preview 缩放惯性")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "目标" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "放大计划" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭计划" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and execute" }));
    expect(onAction).toHaveBeenCalledWith("execute");
    fireEvent.click(screen.getByRole("button", { name: "Approve and keep context" }));
    expect(onAction).toHaveBeenCalledWith("keep");
    fireEvent.click(screen.getByRole("button", { name: "Approve and compact context" }));
    expect(onAction).toHaveBeenCalledWith("compact");
    fireEvent.click(screen.getByRole("button", { name: "Refine plan" }));
    expect(onAction).toHaveBeenCalledWith("refine");
    expect(onAction.mock.calls.at(-1)).toEqual(["refine"]);
  });

  it("dismisses from the compact card close button", () => {
    const onAction = vi.fn();
    render(<PlanReviewDeck title="Preview 缩放惯性" body={BODY} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭计划" }));
    expect(onAction).toHaveBeenCalledWith("dismiss");
  });

  it("expands the full dialog when the compact preview is clicked", () => {
    render(<PlanReviewDeck title="Preview 缩放惯性" body={BODY} onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "展开完整计划" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Plan Review · Preview 缩放惯性");
    expect(within(screen.getByRole("dialog")).getByLabelText("全文批注")).toBeTruthy();
  });

  it("sends whole-plan feedback from the pinned overall note", async () => {
    const onAction = vi.fn();
    render(<PlanReviewDeck title="Preview 缩放惯性" body={BODY} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("全文批注"), { target: { value: "rewrite the rollout" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Refine plan" }));
    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith("refine", {
        feedback: "Refinement feedback on the plan:\n\n## Entire plan\n- rewrite the rollout\n",
      });
    });
  });

  it("keeps the overall note after closing so compact Refine still sends it", async () => {
    const onAction = vi.fn();
    render(<PlanReviewDeck title="Preview 缩放惯性" body={BODY} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("全文批注"), { target: { value: "rewrite the rollout" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "收起计划" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Refine plan" }));
    expect(onAction).toHaveBeenCalledWith("refine", {
      feedback: "Refinement feedback on the plan:\n\n## Entire plan\n- rewrite the rollout\n",
    });
  });

  it("sends formatted section feedback from an unsaved draft when Refine is clicked", async () => {
    const onAction = vi.fn();
    render(<PlanReviewDeck title="Preview 缩放惯性" body={BODY} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "批注 目标" }));
    fireEvent.change(within(dialog).getByLabelText("批注内容 目标"), { target: { value: "needs detail" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Refine plan" }));
    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith("refine", {
        feedback: "Refinement feedback on the plan:\n\n## 目标\n- needs detail\n",
      });
    });
  });

  it("sends formatted section feedback after annotating in the expanded dialog", async () => {
    const onAction = vi.fn();
    render(<PlanReviewDeck title="Preview 缩放惯性" body={BODY} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "批注 目标" }));
    fireEvent.change(within(dialog).getByLabelText("批注内容 目标"), { target: { value: "needs detail" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(within(dialog).getByText("needs detail")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Refine plan" }));
    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith("refine", {
        feedback: "Refinement feedback on the plan:\n\n## 目标\n- needs detail\n",
      });
    });
  });

  it("keeps an unsaved draft after closing the dialog so compact Refine still sends it", async () => {
    const onAction = vi.fn();
    render(<PlanReviewDeck title="Preview 缩放惯性" body={BODY} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "批注 目标" }));
    fireEvent.change(within(dialog).getByLabelText("批注内容 目标"), { target: { value: "needs detail" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "收起计划" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Refine plan" }));
    expect(onAction).toHaveBeenCalledWith("refine", {
      feedback: "Refinement feedback on the plan:\n\n## 目标\n- needs detail\n",
    });
  });

  it("keeps annotations after closing the dialog so compact Refine still sends them", async () => {
    const onAction = vi.fn();
    render(<PlanReviewDeck title="Preview 缩放惯性" body={BODY} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "批注 目标" }));
    fireEvent.change(within(dialog).getByLabelText("批注内容 目标"), { target: { value: "needs detail" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "收起计划" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "Refine plan" }));
    expect(onAction).toHaveBeenCalledWith("refine", {
      feedback: "Refinement feedback on the plan:\n\n## 目标\n- needs detail\n",
    });
  });

  it("collapses the expanded dialog from the X button without dismissing the compact card", async () => {
    const onAction = vi.fn();
    render(<PlanReviewDeck title="Preview 缩放惯性" body={BODY} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "收起计划" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "关闭计划" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "放大计划" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "收起计划" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText("Plan Review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭计划" })).toBeTruthy();
  });

  it("shows a read-only viewer without review actions or annotation", async () => {
    const onClose = vi.fn();
    render(
      <PlanViewDialog
        title="已执行计划"
        body={"## 目标\n\nShip it.\n"}
        originRef={{ current: null }}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Plan Review · 已执行计划");
    expect(dialog.textContent).toContain("Ship it.");
    expect(within(dialog).queryByRole("button", { name: "Refine plan" })).toBeNull();
    expect(within(dialog).queryByLabelText("全文批注")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "收起计划" }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("opens the dialog immediately when expanded is controlled", () => {
    render(
      <PlanReviewDeck
        title="Preview 缩放惯性"
        body={BODY}
        expanded
        onExpandedChange={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Plan Review · Preview 缩放惯性");
  });

  it("notifies onExpandedChange when the controlled dialog is collapsed", async () => {
    const onExpandedChange = vi.fn();
    render(
      <PlanReviewDeck
        title="Preview 缩放惯性"
        body={BODY}
        expanded
        onExpandedChange={onExpandedChange}
        onAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "收起计划" }));
    await waitFor(() => {
      expect(onExpandedChange).toHaveBeenCalledWith(false);
    });
  });
});
