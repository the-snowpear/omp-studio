import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useConversationScroll } from "./useConversationScroll";

function fakeScroller(scrollHeight: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 });
  el.scrollTop = 800;
  return el;
}

describe("useConversationScroll pin", () => {
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
});
