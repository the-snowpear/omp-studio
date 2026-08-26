import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationMinimap } from "./ConversationMinimap";
import { createConversationViewportController } from "./conversationViewportController";
import type { TimelineRow } from "./conversationViewModel";

describe("ConversationMinimap hot path", () => {
  const frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    frames.length = 0;
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  function flushFrame(): void {
    const frame = frames.shift();
    if (frame) act(() => frame(16));
  }

  function renderHarness() {
    let scroller: HTMLDivElement | null = null;
    const Harness = () => {
      const scrollerRef = useRef<HTMLDivElement | null>(null);
      return (
        <>
          <div ref={(node) => {
            scrollerRef.current = node;
            scroller = node;
          }} />
          <ConversationMinimap rows={[]} scrollerRef={scrollerRef} />
        </>
      );
    };
    const view = render(<Harness />);
    const resolvedScroller = scroller as unknown as HTMLDivElement;
    const track = view.container.querySelector<HTMLElement>(".minimap-track")!;
    let scrollTop = 0;
    let scrollWrites = 0;
    Object.defineProperties(resolvedScroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 4_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
          scrollWrites += 1;
        },
      },
    });
    Object.defineProperty(track, "clientHeight", { configurable: true, value: 600 });
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 48,
      bottom: 600,
      width: 48,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    });
    flushFrame();
    return { resolvedScroller, track, getScrollWrites: () => scrollWrites };
  }

  it("does not query transcript or mark layouts during a scroll burst", () => {
    const { resolvedScroller } = renderHarness();
    const query = vi.spyOn(resolvedScroller, "querySelectorAll");
    const rect = vi.spyOn(resolvedScroller, "getBoundingClientRect");

    for (let event = 0; event < 120; event += 1) fireEvent.scroll(resolvedScroller);
    expect(frames).toHaveLength(1);
    flushFrame();

    expect(query).not.toHaveBeenCalled();
    expect(rect).not.toHaveBeenCalled();
  });

  it("writes scrollTop at most once for a 120 Hz pointermove burst", () => {
    const { track, getScrollWrites } = renderHarness();

    fireEvent.pointerDown(track, { pointerId: 1, clientY: 10 });
    for (let event = 0; event < 120; event += 1) {
      fireEvent.pointerMove(track, { pointerId: 1, clientY: 50 + event });
    }
    expect(getScrollWrites()).toBe(0);
    expect(frames).toHaveLength(1);

    flushFrame();
    expect(getScrollWrites()).toBe(1);
    fireEvent.pointerUp(track, { pointerId: 1, clientY: 170 });
  });

  it("pulls the initial shared-controller snapshot without waiting for a scroll", () => {
    const controller = createConversationViewportController();
    const rows: readonly TimelineRow[] = [{
      type: "user",
      itemId: "initial-user",
      createdAt: "2026-08-26T00:00:00.000Z",
      text: "first",
    }];
    const Harness = () => {
      const scrollerRef = useRef<HTMLDivElement | null>(null);
      return (
        <>
          <div ref={scrollerRef} />
          <ConversationMinimap rows={rows} scrollerRef={scrollerRef} viewportController={controller} />
        </>
      );
    };

    const view = render(<Harness />);

    expect(view.getByRole("button", { name: "#1 用户消息" })).toBeDefined();
  });
});
