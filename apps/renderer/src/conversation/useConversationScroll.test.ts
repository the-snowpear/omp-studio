import { act, renderHook } from "@testing-library/react";
import type { UIEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { bindTailGestures, captureAnchor, restoreAnchor, useConversationScroll } from "./useConversationScroll";

describe("conversation scroll primitives", () => {
  it("detaches synchronously on an upward wheel gesture when scrollable and disposes listeners", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 200 });
    const unpin = vi.fn();
    const dispose = bindTailGestures(el, () => true, unpin);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    expect(unpin).toHaveBeenCalledOnce();
    dispose();
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    expect(unpin).toHaveBeenCalledOnce();
  });

  it("does not detach on upward wheel gesture when content does not overflow (not scrollable)", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 200 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 200 });
    const unpin = vi.fn();
    const dispose = bindTailGestures(el, () => true, unpin);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    expect(unpin).not.toHaveBeenCalled();
    dispose();
  });

  it("does not show jump-to-latest button when content is less than one screen", () => {
    const scroller = document.createElement("div");
    const metrics = { scrollHeight: 200, clientHeight: 200 };
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    const scrollerRef = { current: scroller };
    const hook = renderHook(
      ({ contentKey }) => useConversationScroll({
        scrollerRef,
        identityKey: "session-1",
        itemCount: 1,
        loadingOlder: false,
        contentKey,
      }),
      { initialProps: { contentKey: "first" } },
    );

    expect(hook.result.current.follow).toBe(true);
    expect(hook.result.current.hasNewContent).toBe(false);

    // 即使被外部调用了 detachFromLatest，未满一屏时 hasNewContent 也必须为 false
    act(() => hook.result.current.detachFromLatest());
    expect(hook.result.current.hasNewContent).toBe(false);

    // 新内容到来但依然未满一屏时，按钮依然不显示
    metrics.scrollHeight = 210;
    hook.rerender({ contentKey: "second" });
    expect(hook.result.current.hasNewContent).toBe(false);
  });

  it("restores a prepended-page anchor by identity", () => {
    const scroller = document.createElement("div"); const row = document.createElement("div"); row.dataset.itemId = "visible"; scroller.append(row);
    Object.defineProperty(scroller, "scrollTop", { writable: true, value: 10 });
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 300 } as DOMRect);
    row.getBoundingClientRect = () => ({ top: 140, bottom: 180 } as DOMRect);
    const anchor = captureAnchor(scroller); expect(anchor).toMatchObject({ itemId: "visible", offset: 40, scrollTop: 10 });
    row.getBoundingClientRect = () => ({ top: 190, bottom: 230 } as DOMRect);
    restoreAnchor(scroller, anchor!); expect(scroller.scrollTop).toBe(60);
  });
  it("compensates by the grown content height when the anchored row is unmounted", () => {
    const scroller = document.createElement("div"); const row = document.createElement("div"); row.dataset.itemId = "visible"; scroller.append(row);
    Object.defineProperty(scroller, "scrollTop", { writable: true, value: 10 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 300 } as DOMRect);
    row.getBoundingClientRect = () => ({ top: 140, bottom: 180 } as DOMRect);
    const anchor = captureAnchor(scroller);
    /* Virtualization unmounts the anchored row while a prepended page grows the
       content above it; the reader must not be left where the browser put them. */
    row.remove();
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1600 });
    restoreAnchor(scroller, anchor!); expect(scroller.scrollTop).toBe(610);
  });
  it("keeps an anchor when nothing is mounted so the caller can still compensate", () => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollTop", { writable: true, value: 42 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 500 });
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 200 } as DOMRect);
    expect(captureAnchor(scroller)).toEqual({ itemId: "", offset: 0, scrollTop: 42, scrollHeight: 500 });
  });

  it("detaches minimap navigation from latest before the next content update", () => {
    const scroller = document.createElement("div");
    const metrics = { scrollHeight: 1000, clientHeight: 200 };
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    scroller.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      const top = typeof options === "number" ? options : options?.top;
      if (typeof top === "number") scroller.scrollTop = top;
    }) as HTMLElement["scrollTo"];
    const scrollerRef = { current: scroller };
    const hook = renderHook(
      ({ itemCount, contentKey }) => useConversationScroll({
        scrollerRef,
        identityKey: "session-1",
        itemCount,
        loadingOlder: false,
        contentKey,
      }),
      { initialProps: { itemCount: 1, contentKey: "first" } },
    );

    expect(hook.result.current.follow).toBe(true);
    act(() => hook.result.current.detachFromLatest());
    expect(hook.result.current.follow).toBe(false);
    scroller.scrollTop = 300;
    metrics.scrollHeight = 1200;
    hook.rerender({ itemCount: 2, contentKey: "second" });
    expect(scroller.scrollTop).toBe(300);
    expect(hook.result.current.hasNewContent).toBe(true);
  });

  it("does not re-pin while the reader scrolls up, even within the follow threshold", () => {
    const scroller = document.createElement("div");
    const metrics = { scrollHeight: 1000, clientHeight: 200 };
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    const scrollerRef = { current: scroller };
    const hook = renderHook(() => useConversationScroll({ scrollerRef, identityKey: "s", itemCount: 1, loadingOlder: false }));
    // jsdom 无 ResizeObserver：布局副作用走直写回退，初始贴底把 scrollTop 写到 scrollHeight。
    expect(hook.result.current.follow).toBe(true);
    act(() => hook.result.current.detachFromLatest());
    expect(hook.result.current.follow).toBe(false);
    // 向上滚一格：平滑滚动的中间位置离底部只有 60px（旧阈值 72px 以内）。
    scroller.scrollTop = 740;
    act(() => hook.result.current.onScroll({ currentTarget: scroller } as unknown as UIEvent<HTMLElement>));
    expect(hook.result.current.follow).toBe(false);
    // 继续向上（更远离底部）同样不回钉。
    scroller.scrollTop = 600;
    act(() => hook.result.current.onScroll({ currentTarget: scroller } as unknown as UIEvent<HTMLElement>));
    expect(hook.result.current.follow).toBe(false);
  });

  it("resumes following on a deliberate downward scroll into the threshold after the gesture settles", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const scroller = document.createElement("div");
      const metrics = { scrollHeight: 1200, clientHeight: 200 };
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
      Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
      Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
      const scrollerRef = { current: scroller };
      const hook = renderHook(() => useConversationScroll({ scrollerRef, identityKey: "s", itemCount: 1, loadingOlder: false }));
      act(() => hook.result.current.detachFromLatest());
      // 底部 scrollTop 上限 = 1200 - 200 = 1000。脱离后向上滚到 900（离底 100px）。
      scroller.scrollTop = 900;
      act(() => hook.result.current.onScroll({ currentTarget: scroller } as unknown as UIEvent<HTMLElement>));
      expect(hook.result.current.follow).toBe(false);
      // 手势冷却窗口内向下滚进阈值（离底 50px）：还不回钉。
      scroller.scrollTop = 950;
      act(() => hook.result.current.onScroll({ currentTarget: scroller } as unknown as UIEvent<HTMLElement>));
      expect(hook.result.current.follow).toBe(false);
      vi.advanceTimersByTime(600);
      // 冷却结束后继续向下（离底 30px）：回钉恢复跟随。
      scroller.scrollTop = 970;
      act(() => hook.result.current.onScroll({ currentTarget: scroller } as unknown as UIEvent<HTMLElement>));
      expect(hook.result.current.follow).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches when the native scrollbar or minimap drags up past the follow range", () => {
    const scroller = document.createElement("div");
    const metrics = { scrollHeight: 1000, clientHeight: 200 };
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    const scrollerRef = { current: scroller };
    const hook = renderHook(() => useConversationScroll({ scrollerRef, identityKey: "s", itemCount: 1, loadingOlder: false }));
    expect(hook.result.current.follow).toBe(true);
    // 贴底位置 800；向上拖到 650：距离 150px 超出跟随阈值 → 脱离。
    scroller.scrollTop = 650;
    act(() => hook.result.current.onScroll({ currentTarget: scroller } as unknown as UIEvent<HTMLElement>));
    expect(hook.result.current.follow).toBe(false);
    // 内容增长那一拍（scrollTop 未动，只有 scrollHeight 变大）不视为拖动。
    metrics.scrollHeight = 1400;
    scroller.scrollTop = 650;
    const pinnedHook = renderHook(() => useConversationScroll({ scrollerRef: { current: scroller }, identityKey: "s2", itemCount: 1, loadingOlder: false }));
    expect(pinnedHook.result.current.follow).toBe(true);
    act(() => pinnedHook.result.current.onScroll({ currentTarget: scroller } as unknown as UIEvent<HTMLElement>));
    expect(pinnedHook.result.current.follow).toBe(true);
  });

  it("re-pins unconditionally when distance reaches the exact bottom (<= AT_TAIL_PX)", () => {
    const scroller = document.createElement("div");
    const metrics = { scrollHeight: 1200, clientHeight: 200 };
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    const scrollerRef = { current: scroller };
    const hook = renderHook(() => useConversationScroll({ scrollerRef, identityKey: "s", itemCount: 1, loadingOlder: false }));
    act(() => hook.result.current.detachFromLatest());
    expect(hook.result.current.follow).toBe(false);

    // 滚到底部（scrollTop = 1000，distance = 0）
    scroller.scrollTop = 1000;
    act(() => hook.result.current.onScroll({ currentTarget: scroller } as unknown as UIEvent<HTMLElement>));
    expect(hook.result.current.follow).toBe(true);
    expect(hook.result.current.hasNewContent).toBe(false);
  });
});
