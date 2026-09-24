import { afterEach, expect, it, vi } from "vitest";
import type { SessionId } from "@omp-studio/client-contract";
import { ConversationStore } from "./conversationStore";

const stores: ConversationStore[] = [];
const sessionId = "s" as SessionId;
function store(enabled = true) {
  const scheduler = { request: vi.fn(() => 1), cancel: vi.fn(), now: Date.now };
  const result = new ConversationStore({ target: { sessionId }, identity: { sessionId }, generation: 1,
    backgroundPublishing: enabled, scheduler });
  stores.push(result); return { store: result, scheduler };
}
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.useRealTimers(); });
it("hidden output publishes every 250ms without RAF; control events flush immediately and resume catches up", () => {
  vi.useFakeTimers(); const { store: s, scheduler } = store();
  s.setBackground(true);
  s.applyEvent({ kind: "conversation.message.started", sessionId, turnId: "t", messageId: "m", role: "assistant", createdAt: "now" }, 1);
  const listener = vi.fn(); s.subscribe(listener);
  const add = (seq: number) => s.applyEvent({ kind: "conversation.message.delta", sessionId, turnId: "t", messageId: "m", blockId: "b", blockType: "text", delta: "字" }, seq);
  for (let i = 2; i <= 101; i++) add(i);
  vi.advanceTimersByTime(249); expect(listener).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(listener).toHaveBeenCalledTimes(1);
  expect(s.getSnapshot().state.liveMessages.m?.blocks[0]?.text).toBe("字".repeat(100));
  expect(scheduler.request).not.toHaveBeenCalled();
  add(102); s.applyEvent({ kind: "conversation.notice", sessionId, level: "error", message: "visible now" }, 103);
  expect(listener).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  for (let i = 0; i < 50; i++) {
    s.setBackground(true); add(104 + i); s.setBackground(false);
    expect(s.getSnapshot().state.lastEventSeq).toBe(104 + i);
  }
  s.setBackground(true); add(200); s.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it("the rollback mode retains the existing RAF publisher", () => {
  const { store: s, scheduler } = store(false);
  s.setBackground(true);
  s.applyEvent({ kind: "conversation.notice", sessionId, level: "warning", message: "raf" });
  expect(scheduler.request).toHaveBeenCalledTimes(1);
});
