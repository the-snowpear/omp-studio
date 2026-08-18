import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIEvent } from "react";
import { useConversationScroll } from "./useConversationScroll";

function fakeScroller(scrollHeight: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 });
  el.scrollTop = 800;
  return el;
}

function mutableScroller(initialHeight: number): { el: HTMLElement; setHeight: (next: number) => void } {
  let height = initialHeight;
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 });
  el.scrollTop = 800;
  return { el, setHeight: (next) => { height = next; } };
}

function scrollEvent(el: HTMLElement): UIEvent<HTMLElement> {
  return {
    currentTarget: { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight },
  } as UIEvent<HTMLElement>;
}

describe("useConversationScroll pin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a welcome surface at the top instead of sticking to the bottom", () => {
    const el = fakeScroller(2000);
    const { result } = renderHook(() => useConversationScroll({
      scrollerRef: { current: el },
      identityKey: "welcome",
      itemCount: 0,
      loadingOlder: false,
      pin: "top",
    }));
    expect(el.scrollTop).toBe(0);
    expect(result.current.follow).toBe(false);
    expect(result.current.hasNewContent).toBe(false);
  });

  it("keeps transcripts stuck to the bottom", () => {
    const el = fakeScroller(2000);
    renderHook(() => useConversationScroll({
      scrollerRef: { current: el },
      identityKey: "thread",
      itemCount: 4,
      loadingOlder: false,
    }));
    expect(el.scrollTop).toBe(2000);
  });

  it("sticks again when contentKey grows while following", () => {
    const { el, setHeight } = mutableScroller(2000);
    const scrollerRef = { current: el };
    const { rerender } = renderHook(
      ({ contentKey }) => useConversationScroll({
        scrollerRef,
        identityKey: "thread",
        itemCount: 4,
        loadingOlder: false,
        contentKey,
      }),
      { initialProps: { contentKey: "10" } },
    );
    setHeight(2800);
    rerender({ contentKey: "80" });
    expect(el.scrollTop).toBe(2800);
  });

  it("keeps the scrolled position when live output grows after the user scrolls up", () => {
    const { el, setHeight } = mutableScroller(2000);
    const scrollerRef = { current: el };
    const { result, rerender } = renderHook(
      ({ contentKey }) => useConversationScroll({
        scrollerRef,
        identityKey: "thread",
        itemCount: 4,
        loadingOlder: false,
        contentKey,
      }),
      { initialProps: { contentKey: "10" } },
    );
    el.scrollTop = 100;
    act(() => {
      result.current.onScroll(scrollEvent(el));
    });
    expect(result.current.follow).toBe(false);
    setHeight(2800);
    rerender({ contentKey: "80" });
    expect(result.current.hasNewContent).toBe(true);
    expect(el.scrollTop).toBe(100);
  });

  it("does not stick when a new row arrives after the user scrolls up", () => {
    const { el, setHeight } = mutableScroller(2000);
    const scrollerRef = { current: el };
    const { result, rerender } = renderHook(
      ({ itemCount }) => useConversationScroll({
        scrollerRef,
        identityKey: "thread",
        itemCount,
        loadingOlder: false,
        contentKey: "10",
      }),
      { initialProps: { itemCount: 4 } },
    );
    el.scrollTop = 140;
    act(() => {
      result.current.onScroll(scrollEvent(el));
    });
    setHeight(2500);
    rerender({ itemCount: 5 });
    expect(result.current.hasNewContent).toBe(true);
    expect(el.scrollTop).toBe(140);
  });

  it("does not let pending stick frames yank back after the user scrolls up", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { el, setHeight } = mutableScroller(2000);
    const scrollerRef = { current: el };
    const { result, rerender } = renderHook(
      ({ contentKey }) => useConversationScroll({
        scrollerRef,
        identityKey: "thread",
        itemCount: 4,
        loadingOlder: false,
        contentKey,
      }),
      { initialProps: { contentKey: "10" } },
    );
    setHeight(2400);
    rerender({ contentKey: "40" });
    expect(el.scrollTop).toBe(2400);

    el.scrollTop = 120;
    act(() => {
      result.current.onScroll(scrollEvent(el));
    });
    expect(result.current.follow).toBe(false);

    act(() => {
      while (frames.length > 0) {
        const queued = frames.splice(0);
        for (const callback of queued) callback(0);
      }
    });
    expect(el.scrollTop).toBe(120);
    expect(result.current.follow).toBe(false);
  });

  it("resumes following when the user scrolls back to the bottom or jumps to latest", () => {
    const { el, setHeight } = mutableScroller(2000);
    const scrollerRef = { current: el };
    const { result, rerender } = renderHook(
      ({ contentKey }) => useConversationScroll({
        scrollerRef,
        identityKey: "thread",
        itemCount: 4,
        loadingOlder: false,
        contentKey,
      }),
      { initialProps: { contentKey: "10" } },
    );
    el.scrollTop = 80;
    act(() => {
      result.current.onScroll(scrollEvent(el));
    });
    setHeight(2800);
    rerender({ contentKey: "80" });
    expect(result.current.hasNewContent).toBe(true);

    el.scrollTop = 2400;
    act(() => {
      result.current.onScroll(scrollEvent(el));
    });
    expect(result.current.follow).toBe(true);
    expect(result.current.hasNewContent).toBe(false);

    el.scrollTop = 90;
    act(() => {
      result.current.onScroll(scrollEvent(el));
    });
    setHeight(3200);
    rerender({ contentKey: "120" });
    act(() => {
      result.current.jumpToLatest();
    });
    expect(result.current.follow).toBe(true);
    expect(result.current.hasNewContent).toBe(false);
    expect(el.scrollTop).toBe(3200);
  });

  it("stays pinned on viewport resize while following, and ignores resize after scroll-up", () => {
    const observers: ResizeObserverCallback[] = [];
    const previous = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    try {
      const { el, setHeight } = mutableScroller(2000);
      const scrollerRef = { current: el };
      const { result } = renderHook(() => useConversationScroll({
        scrollerRef,
        identityKey: "thread",
        itemCount: 4,
        loadingOlder: false,
        contentKey: "10",
      }));
      expect(observers.length).toBeGreaterThan(0);

      setHeight(2600);
      act(() => {
        for (const callback of observers) {
          callback([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
        }
      });
      expect(el.scrollTop).toBe(2600);

      el.scrollTop = 70;
      act(() => {
        result.current.onScroll(scrollEvent(el));
      });
      setHeight(3100);
      act(() => {
        for (const callback of observers) {
          callback([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
        }
      });
      expect(el.scrollTop).toBe(70);
      expect(result.current.follow).toBe(false);
    } finally {
      if (previous) globalThis.ResizeObserver = previous;
      else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    }
  });
});
