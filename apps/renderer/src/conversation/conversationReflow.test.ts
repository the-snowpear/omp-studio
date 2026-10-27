import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_LAYOUT_BEFORE_CHANGE,
  CONVERSATION_LAYOUT_CHANGE,
  isConversationReflowing,
  observeConversationReflow,
  registerConversationScroll,
} from "./conversationReflow";

/** jsdom has no layout, so the two reflow anchors are stubbed geometrically. */
const rect = (top: number, height: number, width = 900) => (
  { top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON: () => ({}) }
) as DOMRect;

function mountConversation() {
  const scroller = document.createElement("div");
  const host = document.createElement("div");
  const row = document.createElement("div");
  row.dataset.rowKey = "row-1";
  host.append(row);
  scroller.append(host);
  document.body.append(scroller);
  scroller.getBoundingClientRect = () => rect(0, 600);
  host.getBoundingClientRect = () => rect(0, 600);
  // Straddles the viewport top: the reader is parked inside this message.
  row.getBoundingClientRect = () => rect(-120, 400);
  const pinRow = vi.fn();
  const disposeScroll = registerConversationScroll(scroller, "thread-1", () => false);
  const observer = observeConversationReflow({
    scroller,
    host,
    beforeEvent: "test-before",
    changeEvent: "test-change",
    measureMargin: vi.fn(),
    measure: vi.fn(),
    pinRow,
  });
  return { scroller, host, pinRow, observer, dispose: () => { observer.dispose(); disposeScroll(); scroller.remove(); } };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("conversation reflow transaction", () => {
  it("releases a speculative resize start that never changes geometry", () => {
    vi.useFakeTimers();
    const conversation = mountConversation();
    try {
      // What a resizer pointerdown does: announce a layout change before knowing
      // whether the drag moves anything.
      window.dispatchEvent(new Event(CONVERSATION_LAYOUT_BEFORE_CHANGE));
      expect(isConversationReflowing(conversation.scroller)).toBe(true);
      expect(conversation.pinRow).toHaveBeenLastCalledWith("row-1");

      vi.advanceTimersByTime(32);

      // A stuck transaction would swallow every scroll event for the rest of the
      // session; the reader must be able to scroll again after a bare click.
      expect(isConversationReflowing(conversation.scroller)).toBe(false);
      expect(conversation.pinRow).toHaveBeenLastCalledWith(null);
    } finally {
      conversation.dispose();
    }
  });

  it("keeps anchoring the visible message while a real layout change settles", () => {
    vi.useFakeTimers();
    const conversation = mountConversation();
    try {
      window.dispatchEvent(new Event(CONVERSATION_LAYOUT_BEFORE_CHANGE));
      window.dispatchEvent(new Event(CONVERSATION_LAYOUT_CHANGE));
      expect(isConversationReflowing(conversation.scroller)).toBe(true);

      vi.advanceTimersByTime(32);
      // Virtualizer row measurements land one frame late, so the anchor must
      // survive that commit instead of being released with the first frame.
      expect(isConversationReflowing(conversation.scroller)).toBe(true);

      vi.advanceTimersByTime(64);
      expect(isConversationReflowing(conversation.scroller)).toBe(false);
      expect(conversation.pinRow).toHaveBeenLastCalledWith(null);
    } finally {
      conversation.dispose();
    }
  });
});
