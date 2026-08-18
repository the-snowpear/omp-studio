import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCardScroll } from "./useToolCardFollowScroll";

type Box = { scrollHeight: number; clientHeight: number };

function mockScroller(el: HTMLElement, box: Box): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
}

function Harness({ follow, text }: { follow: boolean; text: string }) {
  return <ToolCardScroll follow={follow}>{text}</ToolCardScroll>;
}

describe("tool card follow scroll", () => {
  it("sticks to the bottom while following as output grows", () => {
    const box = { scrollHeight: 400, clientHeight: 200 };
    const { container, rerender } = render(<Harness follow text="one" />);
    const el = container.firstElementChild as HTMLElement;
    mockScroller(el, box);
    rerender(<Harness follow text="one\ntwo" />);
    expect(el.scrollTop).toBe(400);

    box.scrollHeight = 900;
    rerender(<Harness follow text="one\ntwo\nthree" />);
    expect(el.scrollTop).toBe(900);
    expect(el.getAttribute("data-live")).toBe("tail");
    expect(el.classList.contains("is-live")).toBe(true);
  });

  it("stops sticking after the user scrolls up, and re-pins when follow turns back on", () => {
    const box = { scrollHeight: 800, clientHeight: 200 };
    const { container, rerender } = render(<Harness follow text="live" />);
    const el = container.firstElementChild as HTMLElement;
    mockScroller(el, box);
    rerender(<Harness follow text="live-1" />);
    expect(el.scrollTop).toBe(800);

    el.scrollTop = 40;
    fireEvent.scroll(el);
    box.scrollHeight = 1200;
    rerender(<Harness follow text="live-2" />);
    expect(el.scrollTop).toBe(40);

    rerender(<Harness follow={false} text="live-2" />);
    expect(el.getAttribute("data-live")).toBeNull();
    rerender(<Harness follow text="live-3" />);
    expect(el.scrollTop).toBe(1200);
  });

  it("does not unpin while the expanded card still has no visible height", () => {
    const box = { scrollHeight: 800, clientHeight: 0 };
    const { container, rerender } = render(<Harness follow text="hidden" />);
    const el = container.firstElementChild as HTMLElement;
    mockScroller(el, box);
    el.scrollTop = 0;
    fireEvent.scroll(el);

    box.clientHeight = 200;
    rerender(<Harness follow text="visible" />);
    expect(el.scrollTop).toBe(800);
  });
});
