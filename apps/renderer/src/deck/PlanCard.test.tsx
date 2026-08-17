import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanReviewDeck } from "./PlanCard";

afterEach(cleanup);

describe("PlanReviewDeck", () => {
  it("shows the plan title, markdown body, and four review actions", () => {
    const onAction = vi.fn();
    render(<PlanReviewDeck title="Preview 缩放惯性" body={"## 目标\n\nFreeze the protocol."} onAction={onAction} />);
    expect(screen.getByText("Plan Review")).toBeTruthy();
    expect(screen.getByText("Preview 缩放惯性")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "目标" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and execute" }));
    expect(onAction).toHaveBeenCalledWith("execute");
    fireEvent.click(screen.getByRole("button", { name: "Refine plan" }));
    expect(onAction).toHaveBeenCalledWith("refine");
  });
});
