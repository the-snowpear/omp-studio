import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewDeck } from "./PreviewDeck";
import { PREVIEW_DECK_ITEMS } from "./deckFixtures";

afterEach(cleanup);

describe("preview deck", () => {
  it("shows the plan card first with four review actions", () => {
    render(<PreviewDeck />);
    expect(PREVIEW_DECK_ITEMS.map((item) => item.kind)).toEqual(["plan", "ask"]);
    expect(screen.getByText("Plan Review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve and execute" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve and keep context" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve and compact context" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refine plan" })).toBeTruthy();
    expect(screen.queryByText("缩放交互确认：拖拽平移是否需要惯性？")).toBeNull();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(document.querySelectorAll(".deck-card")).toHaveLength(1);
  });

  it("queue next switches to the ask card with options, recommended, preview, and custom input", () => {
    render(<PreviewDeck />);
    fireEvent.click(screen.getByRole("button", { name: "下一个请求" }));
    expect(screen.queryByRole("button", { name: "Approve and execute" })).toBeNull();
    expect(screen.getByText("缩放交互确认：拖拽平移是否需要惯性？")).toBeTruthy();
    expect(screen.getByText("需要惯性")).toBeTruthy();
    expect(screen.getByText("松手后继续滑行，大图定位更轻松。")).toBeTruthy();
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.getByText("velocity *= 0.92; pan += velocity")).toBeTruthy();
    expect(screen.getByLabelText("自定义回答")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "惯性" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "默认" })).toBeTruthy();
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("demo plan approve dismisses the current card and keeps the ask", () => {
    render(<PreviewDeck />);
    fireEvent.click(screen.getByRole("button", { name: "Approve and execute" }));
    expect(screen.queryByRole("button", { name: "Approve and execute" })).toBeNull();
    expect(screen.getByText("缩放交互确认：拖拽平移是否需要惯性？")).toBeTruthy();
    expect(screen.queryByText("1/2")).toBeNull();
  });
});
