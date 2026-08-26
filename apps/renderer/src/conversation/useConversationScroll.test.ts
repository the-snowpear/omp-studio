import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIEvent } from "react";
import {
  innerAbsorbsScroll,
  keyScrollDirection,
  useConversationScroll,
  type ScrollBoxLike,
} from "./useConversationScroll";

/**
 * jsdom has no layout: scrollHeight / clientHeight are always 0 and setting
 * scrollTop never fires a scroll event. Both are stubbed so the hook's
 * arithmetic and its pin/unpin decisions are what is under test; the scroll
 * event is delivered by hand the way the browser would.
 */
function mutableScroller(initialHeight: number): {
  el: HTMLElement;
  setHeight: (next: number) => void;
} {
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

/** A wheel notch upward, as Chromium delivers it: event first, scrollTop after. */
function wheelUp(el: HTMLElement, by = 120): void {
  el.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -by, bubbles: true }));
  el.scrollTop = Math.max(0, el.scrollTop - by);
}

type ScrollBoxPartial = Partial<ScrollBoxLike> & { scrollTop: number };

function box(partial: ScrollBoxPartial): ScrollBoxLike {
  return {
    scrollHeight: 1000,
    clientHeight: 200,
    containsOverscroll: false,
    ...partial,
  };
}

describe("scroll gesture classification", () => {
  it("maps only the content-up keys to an unpin intent", () => {
    expect(keyScrollDirection("ArrowUp")).toBe("up");
    expect(keyScrollDirection("PageUp")).toBe("up");
    expect(keyScrollDirection("Home")).toBe("up");
    expect(keyScrollDirection("ArrowDown")).toBe("down");
    expect(keyScrollDirection("End")).toBe("down");
    expect(keyScrollDirection("a")).toBeNull();
    expect(keyScrollDirection("Enter")).toBeNull();
  });

  it("treats a nested scroller with room left as absorbing the wheel", () => {
    expect(innerAbsorbsScroll([box({ scrollTop: 300 })], "up")).toBe(true);
    expect(innerAbsorbsScroll([box({ scrollTop: 0 })], "up")).toBe(false);
    expect(innerAbsorbsScroll([box({ scrollTop: 800 })], "down")).toBe(false);
  });

  it("treats overscroll-behavior: contain as absorbing even at its own edge", () => {
    expect(innerAbsorbsScroll([box({ scrollTop: 0, containsOverscroll: true })], "up")).toBe(true);
  });

  it("ignores nested boxes that cannot scroll at all", () => {
    expect(innerAbsorbsScroll([box({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 })], "up")).toBe(false);
  });
});
describe("useConversationScroll pin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a welcome surface at the top instead of sticking to the bottom", () => {
    const { el } = mutableScroller(2000);
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
    const { el } = mutableScroller(2000);
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

describe("useConversationScroll detach on gesture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function streamingHook(height: number) {
    const scroller = mutableScroller(height);
    const scrollerRef = { current: scroller.el };
    const hook = renderHook(
      ({ contentKey }) => useConversationScroll({
        scrollerRef,
        identityKey: "thread",
        itemCount: 4,
        loadingOlder: false,
        contentKey,
      }),
      { initialProps: { contentKey: "10" } },
    );
    return { ...scroller, ...hook };
  }

  /* The reported bug: one wheel notch, then the next stream chunk lands. */
  it("parks on the first wheel notch and survives the next stream chunk", () => {
    const { el, setHeight, result, rerender } = streamingHook(2000);
    expect(el.scrollTop).toBe(2000);

    act(() => {
      wheelUp(el, 120);
    });
    expect(result.current.follow).toBe(false);

    /* Chunk arrives before any scroll event was delivered — the old code re-pinned here. */
    setHeight(2600);
    rerender({ contentKey: "60" });
    expect(el.scrollTop).toBe(1880);
    expect(result.current.hasNewContent).toBe(true);

    /* And the scroll event, delivered late, must not undo the park either. */
    act(() => {
      result.current.onScroll(scrollEvent(el));
    });
    expect(result.current.follow).toBe(false);
    expect(el.scrollTop).toBe(1880);
  });

  it("parks on ArrowUp / PageUp from the scroller", () => {
    const { el, result } = streamingHook(2000);
    act(() => {
      el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    });
    expect(result.current.follow).toBe(false);
  });

  it("ignores ArrowUp typed inside a text field (composer caret movement)", () => {
    const { el, result } = streamingHook(2000);
    const input = document.createElement("textarea");
    el.append(input);
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(result.current.follow).toBe(true);
  });

  it("keeps following when the wheel is absorbed by an expanded tool card", () => {
    const { el, result } = streamingHook(2000);
    const card = document.createElement("div");
    card.style.overflowY = "auto";
    card.style.overscrollBehavior = "contain";
    Object.defineProperty(card, "scrollHeight", { configurable: true, get: () => 900 });
    Object.defineProperty(card, "clientHeight", { configurable: true, get: () => 300 });
    card.scrollTop = 600;
    el.append(card);

    act(() => {
      card.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    });
    expect(result.current.follow).toBe(true);
  });

  it("does not park when the scroller is already at the very top", () => {
    const { el, result } = streamingHook(2000);
    el.scrollTop = 0;
    act(() => {
      el.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    });
    /* Nothing to leave: follow state is whatever the scroll event says next. */
    expect(result.current.follow).toBe(true);
  });

  it("does not park on a downward wheel", () => {
    const { el, result } = streamingHook(2000);
    act(() => {
      el.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 120, bubbles: true }));
    });
    expect(result.current.follow).toBe(true);
  });
});

describe("useConversationScroll load-older ownership", () => {
  it("releases tail following but leaves prepend positioning to Virtuoso", () => {
    const { el, setHeight } = mutableScroller(2000);
    const scrollerRef = { current: el };
    const { result, rerender } = renderHook(
      ({ itemCount, loadingOlder }) => useConversationScroll({
        scrollerRef,
        identityKey: "thread",
        itemCount,
        loadingOlder,
        contentKey: "10",
      }),
      { initialProps: { itemCount: 6, loadingOlder: false } },
    );

    act(() => result.current.preparePrepend());
    expect(result.current.follow).toBe(false);
    const beforeTop = el.scrollTop;
    rerender({ itemCount: 6, loadingOlder: true });
    setHeight(3200);
    rerender({ itemCount: 56, loadingOlder: false });

    expect(el.scrollTop).toBe(beforeTop);
    expect(result.current.hasNewContent).toBe(false);
  });

  it("drops a stale anchor when the request finishes without prepending", () => {
    const { el, setHeight } = mutableScroller(2000);
    const scrollerRef = { current: el };
    const { result, rerender } = renderHook(
      ({ itemCount, loadingOlder }) => useConversationScroll({
        scrollerRef,
        identityKey: "thread",
        itemCount,
        loadingOlder,
        contentKey: "10",
      }),
      { initialProps: { itemCount: 4, loadingOlder: false } },
    );

    el.scrollTop = 120;
    act(() => {
      result.current.preparePrepend();
    });
    rerender({ itemCount: 4, loadingOlder: true });
    rerender({ itemCount: 4, loadingOlder: false });

    /* A later live row must be reported as new content, not swallowed by the request. */
    setHeight(2400);
    rerender({ itemCount: 5, loadingOlder: false });
    expect(result.current.hasNewContent).toBe(true);
    expect(el.scrollTop).toBe(120);
  });
});
