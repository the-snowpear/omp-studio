import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIP_DELAY_MS, TipHost } from "./TipHost";

const originalElementFromPoint = document.elementFromPoint;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.elementFromPoint = originalElementFromPoint;
});

describe("TipHost", () => {
  it("shows a portal tip from data-tip after the hover delay, not a native title", () => {
    vi.useFakeTimers();
    render(
      <>
        <TipHost />
        <button type="button" data-tip="恢复">go</button>
      </>,
    );
    const button = screen.getByRole("button", { name: "go" });
    document.elementFromPoint = () => button;
    fireEvent.pointerMove(document, { clientX: 12, clientY: 12 });
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS);
    });
    expect(screen.getByRole("tooltip").textContent).toBe("恢复");
    expect(button.getAttribute("title")).toBeNull();
  });

  it("reads data-tip on disabled controls via hit-testing", () => {
    vi.useFakeTimers();
    render(
      <>
        <TipHost />
        <button type="button" disabled data-tip="Fork（暂未实现）">fork</button>
      </>,
    );
    const button = screen.getByRole("button", { name: "fork" });
    document.elementFromPoint = () => button;
    fireEvent.pointerMove(document, { clientX: 8, clientY: 8 });
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS);
    });
    expect(screen.getByRole("tooltip").textContent).toBe("Fork（暂未实现）");
  });
});
