import { useRef } from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
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

it("preserves an advisor batch choice when offscreen navigation unmounts and remounts its virtual row", async () => {
  const rows: TimelineRow[] = Array.from({ length: 149 }, (_, i) => ({ type: "user", itemId: `item-${i}`, createdAt: "", text: `message ${i}` }));
  rows.push({ type: "advisor", itemId: "review", createdAt: "2026-11-21T05:40:00Z", notes: [
    { type: "text", severity: "concern", text: "First review note." },
    { type: "text", severity: "nit", text: "Second review note." },
  ] });
  let scroller: HTMLElement;
  function Surface() {
    const ref = useRef<HTMLElement | null>(null);
    return <section ref={node => { ref.current = node; if (node) scroller = node; }}><ConvoTranscript rows={rows} stateScopeKey="session" scrollerRef={ref} /></section>;
  }
  if (!HTMLElement.prototype.scrollTo) HTMLElement.prototype.scrollTo = () => {};
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (this: HTMLElement, options: ScrollToOptions | number) {
    if (typeof options === "object") this.scrollTop = options.top ?? 0;
    queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
  });
  const view = render(<Surface />);
  const original = view.container.querySelector('[data-item-id="review"]')!;
  fireEvent.click(within(original as HTMLElement).getByRole("button", { expanded: false }));
  expect(view.getByText("First review note.")).toBeTruthy();

  let found = false;
  await act(async () => {
    const promise = revealConversationTarget(scroller!, { itemId: "item-10" });
    await new Promise(resolve => setTimeout(resolve, 40));
    void promise.then(result => { found = result; });
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(found).toBe(true);
  const remounted = view.container.querySelector('[data-item-id="review"]')!;
  expect(remounted).not.toBe(original);
  expect(within(remounted as HTMLElement).getByRole("button", { expanded: true })).toBeTruthy();
  expect(view.getByText("First review note.")).toBeTruthy();
  await expect(revealConversationTarget(scroller!, { itemId: "review" })).resolves.toBe(true);
});
