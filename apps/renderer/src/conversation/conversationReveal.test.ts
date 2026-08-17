import { afterEach, describe, expect, it, vi } from "vitest";
import { revealConversationTool } from "./conversationReveal";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("revealConversationTool", () => {
  it("scrolls to the matching bash card and flashes it", () => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { value: 800 });
    scroller.scrollTop = 0;
    const scrollTo = vi.fn((arg?: ScrollToOptions | number) => {
      if (typeof arg === "object" && arg.top !== undefined) scroller.scrollTop = arg.top;
    });
    scroller.scrollTo = scrollTo as HTMLElement["scrollTo"];
    const card = document.createElement("div");
    card.setAttribute("data-tool-call-id", "bash-1");
    card.getBoundingClientRect = () => ({ top: 400, height: 40, bottom: 440, left: 0, right: 0, width: 0, x: 0, y: 400, toJSON: () => ({}) });
    scroller.getBoundingClientRect = () => ({ top: 0, height: 200, bottom: 200, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });
    scroller.append(card);
    document.body.append(scroller);

    expect(revealConversationTool(scroller, { toolCallId: "bash-1", itemId: "msg-1" })).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: expect.any(Number) }));
    expect(card.classList.contains("mm-flash")).toBe(true);
  });

  it("falls back to the conversation item when the tool card is not mounted", () => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { value: 400 });
    const row = document.createElement("div");
    row.setAttribute("data-item-id", "msg-9");
    row.getBoundingClientRect = () => ({ top: 80, height: 20, bottom: 100, left: 0, right: 0, width: 0, x: 0, y: 80, toJSON: () => ({}) });
    scroller.getBoundingClientRect = () => ({ top: 0, height: 200, bottom: 200, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });
    scroller.append(row);
    document.body.append(scroller);

    expect(revealConversationTool(scroller, { toolCallId: "missing", itemId: "msg-9" })).toBe(true);
    expect(row.classList.contains("mm-flash")).toBe(true);
  });

  it("returns false when the conversation has no matching node", () => {
    const scroller = document.createElement("div");
    expect(revealConversationTool(scroller, { toolCallId: "none" })).toBe(false);
    expect(revealConversationTool(null, { toolCallId: "none" })).toBe(false);
  });
});
