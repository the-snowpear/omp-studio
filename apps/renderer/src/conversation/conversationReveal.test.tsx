import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConvoTranscript } from "./ConvoTranscript";
import { revealConversationTarget } from "./conversationReveal";
import type { TimelineRow } from "./conversationViewModel";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("mounts an offscreen virtual row before revealing the delegation and reports unloaded sources", async () => {
  const rows: TimelineRow[] = Array.from({ length: 150 }, (_, i) => ({ type: "user", itemId: `item-${i}`, createdAt: "2026-11-01T00:00:00Z", text: `message ${i}` }));
  let scroller: HTMLElement;
  function Surface() {
    const ref = useRef<HTMLElement | null>(null);
    return <section ref={node => { ref.current = node; if (node) scroller = node; }}><ConvoTranscript rows={rows} scrollerRef={ref} /></section>;
  }
  if (!HTMLElement.prototype.scrollTo) HTMLElement.prototype.scrollTo = () => {};
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (this: HTMLElement, options: ScrollToOptions | number) {
    if (typeof options === "object") this.scrollTop = options.top ?? 0;
    queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
  });
  render(<Surface />);
  expect(document.querySelector('[data-item-id="item-100"]')).toBeNull();
  let found = false;
  await act(async () => {
    const promise = revealConversationTarget(scroller!, { itemId: "item-100" });
    // Allow the range update to commit before the reveal's animation frame.
    await new Promise(resolve => setTimeout(resolve, 40));
    void promise.then(result => { found = result; });
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(found).toBe(true);
  await expect(revealConversationTarget(scroller!, { toolCallId: "not-loaded" })).resolves.toBe(false);
});
