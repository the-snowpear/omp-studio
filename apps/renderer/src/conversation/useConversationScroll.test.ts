import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { bindTailGestures, captureAnchor, restoreAnchor, useConversationScroll } from "./useConversationScroll";

describe("conversation scroll primitives", () => {
  it("detaches synchronously on an upward wheel gesture and disposes listeners", () => {
    const el = document.createElement("div"); const unpin = vi.fn();
    const dispose = bindTailGestures(el, () => true, unpin);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); expect(unpin).toHaveBeenCalledOnce();
    dispose(); el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); expect(unpin).toHaveBeenCalledOnce();
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
});
