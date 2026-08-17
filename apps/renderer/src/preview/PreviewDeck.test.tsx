import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewDeck } from "./PreviewDeck";
import { PREVIEW_DECK_ITEMS } from "./deckFixtures";

afterEach(cleanup);

function dismissPlan() {
  fireEvent.click(screen.getByRole("button", { name: "Approve and execute" }));
}

/** 在场的那一格正文（切换时另有一格 .dk-cell-out 正在淡出）。 */
function liveCell(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".dk-swap > .dk-cell:not(.dk-cell-out)");
}

function focusSlot(): string | null {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active.getAttribute("data-dk-focus") : null;
}

describe("preview deck", () => {
  it("shows the plan card first with four review actions", () => {
    render(<PreviewDeck />);
    expect(PREVIEW_DECK_ITEMS.map((item) => item.kind)).toEqual(["plan", "ask", "ask"]);
    expect(screen.getByText("Plan Review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve and execute" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve and keep context" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve and compact context" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refine plan" })).toBeTruthy();
    expect(screen.queryByText("缩放交互确认：拖拽平移是否需要惯性？")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull(); /* 非 ask 卡不显示 header 胶囊 */
    expect(screen.queryByText("1/3")).toBeNull();
    expect(screen.queryByRole("button", { name: "下一个请求" })).toBeNull();
    expect(document.querySelectorAll(".deck-card")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "实施步骤" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "放大计划" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("expanding the plan opens a dialog with the full body and four actions", () => {
    render(<PreviewDeck />);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    const dialog = screen.getByRole("dialog");
    expect(document.body.querySelector(":scope > .plan-review-overlay")).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("Plan Review · Preview 缩放惯性");
    expect(dialog.querySelector("h2")?.textContent).toBe("目标");
    expect(dialog.textContent).toContain("velocity *= 0.92");
    expect(dialog.querySelectorAll(".dk-actions button")).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: "Approve and execute" })).toHaveLength(2);
  });

  it("closing the expanded plan dialog keeps the compact plan card", async () => {
    render(<PreviewDeck />);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭计划" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByText("Plan Review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Approve and execute" })).toBeTruthy();
  });

  it("approving from the expanded dialog dismisses the plan card and keeps the ask queue", async () => {
    render(<PreviewDeck />);
    fireEvent.click(screen.getByRole("button", { name: "放大计划" }));
    const dialog = screen.getByRole("dialog");
    const approve = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Approve and execute");
    expect(approve).toBeTruthy();
    fireEvent.click(approve!);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.queryByText("Plan Review")).toBeNull();
    expect(screen.getByText("缩放交互确认：拖拽平移是否需要惯性？")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("queue next shows the first ask card with options, recommended, preview, custom input, and head chips for every ask", () => {
    render(<PreviewDeck />);
    dismissPlan();
    expect(screen.queryByRole("button", { name: "Approve and execute" })).toBeNull();
    expect(screen.getByText("缩放交互确认：拖拽平移是否需要惯性？")).toBeTruthy();
    expect(screen.getByText("需要惯性")).toBeTruthy();
    expect(screen.getByText("松手后继续滑行，大图定位更轻松。")).toBeTruthy();
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.getByText("velocity *= 0.92; pan += velocity")).toBeTruthy();
    expect(screen.getByLabelText("自定义回答")).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
    /* 标题行右侧的 header 胶囊：本批次全部 ask 都显示，当前卡高亮 */
    const inertiaTab = screen.getByRole("tab", { name: "惯性" });
    const defaultTab = screen.getByRole("tab", { name: "默认" });
    expect(inertiaTab.getAttribute("aria-selected")).toBe("true");
    expect(defaultTab.getAttribute("aria-selected")).toBe("false");
    expect(document.querySelector(".dk-head-chips")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("queue next again shows the second ask card", () => {
    render(<PreviewDeck />);
    dismissPlan();
    fireEvent.click(screen.getByRole("button", { name: "下一个请求" }));
    expect(screen.getByText(/如果做成设置项/)).toBeTruthy();
    expect(screen.getByRole("radio", { name: /默认开/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "默认" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "惯性" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("clicking a head chip jumps straight to that ask card", () => {
    render(<PreviewDeck />);
    dismissPlan();
    expect(screen.getByText("缩放交互确认：拖拽平移是否需要惯性？")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "默认" }));
    /* 切换时旧卡还在场做淡出（aria-hidden + inert，不吃点击也不进无障碍树），
       在场的那一格已经是新卡 */
    expect(liveCell()?.textContent).toContain("如果做成设置项");
    expect(liveCell()?.textContent).not.toContain("缩放交互确认");
    expect(document.querySelector(".dk-cell-out")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("tab", { name: "默认" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "惯性" }));
    expect(liveCell()?.textContent).toContain("缩放交互确认：拖拽平移是否需要惯性？");
  });

  it("switching ask cards cross-fades only the question body and keeps the head / action rows in place", () => {
    render(<PreviewDeck />);
    dismissPlan();
    const next = screen.getByRole("button", { name: "下一个请求" });
    next.focus();
    expect(focusSlot()).toBe("queue-next");
    fireEvent.click(next);
    /* 往后翻：旧正文向左淡出，新正文从右淡入 */
    const out = document.querySelector(".dk-cell-out");
    expect(out?.className).toContain("dk-cell-leave-fwd");
    expect(out?.hasAttribute("inert")).toBe(true);
    expect(liveCell()?.className).toContain("dk-cell-enter-fwd");
    /* 动的只有正文那一段：标题行与底部操作行常驻，不复制、不跟着平移 */
    expect(out?.querySelector(".ask-head")).toBeNull();
    expect(out?.querySelector(".dk-actions")).toBeNull();
    expect(document.querySelectorAll(".dk-stage .ask-head")).toHaveLength(1);
    expect(document.querySelectorAll(".dk-stage .dk-actions")).toHaveLength(1);
    expect(document.querySelectorAll(".dk-stage .ask-card")).toHaveLength(1);
    /* 常驻标题行立即报当前位置，不留旧卡的 1/2 */
    expect(screen.getByText("2/2")).toBeTruthy();
    expect(screen.queryByText("1/2")).toBeNull();
    /* 焦点跟到新位置：末页「下一个请求」已禁用，退到「上一个请求」 */
    expect(focusSlot()).toBe("queue-prev");
    /* 往前翻：方向反过来 */
    fireEvent.click(screen.getByRole("button", { name: "上一个请求" }));
    expect(document.querySelector(".dk-cell-out")?.className).toContain("dk-cell-leave-back");
    expect(liveCell()?.className).toContain("dk-cell-enter-back");
    expect(focusSlot()).toBe("queue-next");
  });

  it("keeps an answer when paging away and back", () => {
    render(<PreviewDeck />);
    dismissPlan();
    fireEvent.click(screen.getByRole("radio", { name: /需要惯性/ }));
    expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "默认" }));
    /* 另一张卡还没答，常驻的「提交」跟着当前卡回到禁用 */
    expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "惯性" }));
    expect(screen.getByRole("radio", { name: /需要惯性/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(false);
  });

  it("dismissing a card swaps without leaving the old body on stage", () => {
    render(<PreviewDeck />);
    dismissPlan();
    expect(document.querySelector(".dk-cell-out")).toBeNull();
    expect(liveCell()?.className).not.toContain("dk-cell-enter");
  });

  it("demo plan approve dismisses the current card and keeps the ask queue", () => {
    render(<PreviewDeck />);
    fireEvent.click(screen.getByRole("button", { name: "Approve and execute" }));
    expect(screen.queryByRole("button", { name: "Approve and execute" })).toBeNull();
    expect(screen.getByText("缩放交互确认：拖拽平移是否需要惯性？")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("ask card puts submit/cancel in the bottom action area; submit unlocks once answered and dismisses to the next card", () => {
    render(<PreviewDeck />);
    dismissPlan();
    const submit = screen.getByRole("button", { name: "提交" });
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(document.querySelector(".ask-card .dk-actions")).toBeTruthy();
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /需要惯性/ }));
    expect(submit.hasAttribute("disabled")).toBe(false);
    expect(cancel.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);
    expect(screen.queryByText("缩放交互确认：拖拽平移是否需要惯性？")).toBeNull();
    expect(screen.getByText(/如果做成设置项/)).toBeTruthy();
  });

  it("ask card cancel dismisses the card without answering", () => {
    render(<PreviewDeck />);
    dismissPlan();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("缩放交互确认：拖拽平移是否需要惯性？")).toBeNull();
    expect(screen.getByText(/如果做成设置项/)).toBeTruthy();
  });
});
