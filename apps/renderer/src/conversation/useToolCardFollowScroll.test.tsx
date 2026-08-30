import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolCardScroll } from "./useToolCardFollowScroll";

afterEach(cleanup);

/** jsdom reports every box as 0×0, so the scroll geometry has to be staged. */
function stageScrollBox(el: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  if (!Object.getOwnPropertyDescriptor(el, "scrollTop")?.writable) {
    Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: 0 });
  }
}

describe("ToolCardScroll follow", () => {
  it("keeps following as output grows while `follow` stays true", () => {
    // The regression this locks down: an effect keyed only on `follow` never
    // reruns during a streaming turn, so the card stops at the first paint.
    const { container, rerender } = render(<ToolCardScroll follow className="tc">first</ToolCardScroll>);
    const box = container.querySelector<HTMLElement>(".tc")!;
    stageScrollBox(box, { scrollHeight: 400, clientHeight: 100 });
    act(() => { rerender(<ToolCardScroll follow className="tc">second</ToolCardScroll>); });
    expect(box.scrollTop).toBe(400);

    stageScrollBox(box, { scrollHeight: 900, clientHeight: 100 });
    act(() => { rerender(<ToolCardScroll follow className="tc">third</ToolCardScroll>); });
    expect(box.scrollTop).toBe(900);
  });

  it("does not write scrollTop into a zero-height box", () => {
    const { container, rerender } = render(<ToolCardScroll follow className="tc">a</ToolCardScroll>);
    const box = container.querySelector<HTMLElement>(".tc")!;
    stageScrollBox(box, { scrollHeight: 400, clientHeight: 0 });
    act(() => { rerender(<ToolCardScroll follow className="tc">b</ToolCardScroll>); });
    expect(box.scrollTop).toBe(0);
  });

  it("stops following after an upward wheel gesture", () => {
    const { container, rerender } = render(<ToolCardScroll follow className="tc">a</ToolCardScroll>);
    const box = container.querySelector<HTMLElement>(".tc")!;
    stageScrollBox(box, { scrollHeight: 400, clientHeight: 100 });
    act(() => { box.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); });
    act(() => { rerender(<ToolCardScroll follow className="tc">b</ToolCardScroll>); });
    expect(box.scrollTop).toBe(0);
  });

  it("re-pins once the reader scrolls back to the tail", () => {
    const { container, rerender } = render(<ToolCardScroll follow className="tc">a</ToolCardScroll>);
    const box = container.querySelector<HTMLElement>(".tc")!;
    stageScrollBox(box, { scrollHeight: 400, clientHeight: 100 });
    act(() => { box.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); });
    box.scrollTop = 300;
    act(() => { box.dispatchEvent(new Event("scroll", { bubbles: false })); });
    stageScrollBox(box, { scrollHeight: 500, clientHeight: 100 });
    act(() => { rerender(<ToolCardScroll follow className="tc">c</ToolCardScroll>); });
    expect(box.scrollTop).toBe(500);
  });

  it("resumes following when `follow` flips back to true after an in-card unpin", () => {
    // 回到最新 re-arms the card. Without an edge reset the in-card unpin sticks
    // forever and the card silently stops tracking its own output.
    const { container, rerender } = render(<ToolCardScroll follow className="tc">a</ToolCardScroll>);
    const box = container.querySelector<HTMLElement>(".tc")!;
    stageScrollBox(box, { scrollHeight: 400, clientHeight: 100 });
    act(() => { box.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); });
    act(() => { rerender(<ToolCardScroll follow={false} className="tc">b</ToolCardScroll>); });
    expect(box.scrollTop).toBe(0);
    stageScrollBox(box, { scrollHeight: 700, clientHeight: 100 });
    act(() => { rerender(<ToolCardScroll follow className="tc">c</ToolCardScroll>); });
    expect(box.scrollTop).toBe(700);
  });

  it("does not re-pin on a plain re-render while `follow` stays true", () => {
    const { container, rerender } = render(<ToolCardScroll follow className="tc">a</ToolCardScroll>);
    const box = container.querySelector<HTMLElement>(".tc")!;
    stageScrollBox(box, { scrollHeight: 400, clientHeight: 100 });
    act(() => { box.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); });
    act(() => { rerender(<ToolCardScroll follow className="tc">b</ToolCardScroll>); });
    act(() => { rerender(<ToolCardScroll follow className="tc">c</ToolCardScroll>); });
    expect(box.scrollTop).toBe(0);
  });

  it("leaves the box alone when not following", () => {
    const { container, rerender } = render(<ToolCardScroll follow={false} className="tc">a</ToolCardScroll>);
    const box = container.querySelector<HTMLElement>(".tc")!;
    stageScrollBox(box, { scrollHeight: 400, clientHeight: 100 });
    act(() => { rerender(<ToolCardScroll follow={false} className="tc">b</ToolCardScroll>); });
    expect(box.scrollTop).toBe(0);
  });

  it("observes only the live tail's own scroll box", () => {
    // A transcript mounts one of these per body region of every card in the
    // viewport. Observing cards that can never stick — and, worse, each child of
    // them (a code block's children are its lines) — means the browser sizes all
    // of those boxes on every frame of a neighbouring card's expand transition.
    let created = 0;
    const observed: Element[] = [];
    class Stub {
      constructor(_callback: () => void) { created += 1; }
      observe(element: Element): void { observed.push(element); }
      unobserve(): void {}
      disconnect(): void {}
    }
    const globals = globalThis as Record<string, unknown>;
    globals.ResizeObserver = Stub;
    try {
      const body = <><span>a</span><span>b</span></>;
      const { container, rerender } = render(<ToolCardScroll follow={false} className="tc">{body}</ToolCardScroll>);
      expect(created).toBe(0);
      act(() => { rerender(<ToolCardScroll follow className="tc">{body}</ToolCardScroll>); });
      expect(created).toBe(1);
      expect(observed).toEqual([container.querySelector(".tc")]);
    } finally {
      delete globals.ResizeObserver;
    }
  });
});
