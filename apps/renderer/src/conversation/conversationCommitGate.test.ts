import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_COMMIT_INTERVAL_MS,
  createConversationCommitGate,
} from "./conversationCommitGate";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("conversation commit gate", () => {
  it("coalesces a normal burst to one leading and one trailing commit per window", () => {
    const flush = vi.fn();
    const gate = createConversationCommitGate(flush);

    for (let index = 0; index < 100; index += 1) gate.notify();
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CONVERSATION_COMMIT_INTERVAL_MS - 1);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("flushes a pending terminal state immediately without a later duplicate", () => {
    const flush = vi.fn();
    const gate = createConversationCommitGate(flush);

    gate.notify();
    gate.notify();
    gate.notify("terminal");
    expect(flush).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CONVERSATION_COMMIT_INTERVAL_MS);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("bounds aggregate main and subagent commits independently during simultaneous bursts", () => {
    const main = vi.fn();
    const subagent = vi.fn();
    const mainGate = createConversationCommitGate(main);
    const subagentGate = createConversationCommitGate(subagent);

    for (let index = 0; index < 250; index += 1) {
      mainGate.notify();
      subagentGate.notify();
    }
    expect(main).toHaveBeenCalledTimes(1);
    expect(subagent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CONVERSATION_COMMIT_INTERVAL_MS);
    expect(main).toHaveBeenCalledTimes(2);
    expect(subagent).toHaveBeenCalledTimes(2);
  });
});
