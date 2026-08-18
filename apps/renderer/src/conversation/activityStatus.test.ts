import { describe, expect, it } from "vitest";
import {
  deriveActivityStatus,
  formatElapsed,
  formatRetry,
  formatTokens,
  isAbortEligible,
  isRetryActivityNotice,
  parseRetryNotice,
  reduceActivityRetry,
  reduceAwaitingTurn,
  shortenDetail,
  syncRunWindow,
  WORKING_LABEL,
} from "./activityStatus";
import { emptyConversationState, type ConversationState, type LiveMessage, type LiveTool } from "./conversationViewModel";

function stateWith(parts: {
  readonly tools?: readonly LiveTool[];
  readonly messages?: readonly LiveMessage[];
}): ConversationState {
  const liveTools: { [toolCallId: string]: LiveTool } = {};
  for (const tool of parts.tools ?? []) liveTools[tool.toolCallId] = tool;
  const liveMessages: { [messageId: string]: LiveMessage } = {};
  for (const message of parts.messages ?? []) liveMessages[message.messageId] = message;
  return {
    ...emptyConversationState(),
    liveTools,
    liveMessages,
    liveOrder: (parts.messages ?? []).map((message) => message.messageId),
  };
}

function tool(parts: Partial<LiveTool> & Pick<LiveTool, "toolCallId" | "toolName" | "status">): LiveTool {
  return { messageId: "m1", turnId: "t1", ...parts };
}

function message(messageId: string, blockType: "text" | "thinking", text: string): LiveMessage {
  return {
    messageId,
    turnId: "t1",
    role: "assistant",
    createdAt: "2026-08-17T06:00:00.000Z",
    blocks: [{ blockId: `${messageId}-b1`, blockType, text }],
    aborted: false,
  };
}

describe("deriveActivityStatus", () => {
  it("reports nothing for an idle session with no queued messages", () => {
    expect(deriveActivityStatus({ state: emptyConversationState(), streaming: false, pendingMessages: 0 })).toBeNull();
  });

  it("reports only working after send, before any assistant response", () => {
    expect(deriveActivityStatus({
      state: emptyConversationState(),
      streaming: false,
      pendingMessages: 0,
      awaiting: true,
    })).toEqual({ phase: "waiting", label: WORKING_LABEL });
    expect(deriveActivityStatus({
      state: emptyConversationState(),
      streaming: true,
      pendingMessages: 0,
    })).toEqual({ phase: "waiting", label: WORKING_LABEL });
  });

  it("reports the queue when the run stopped but messages are still pending", () => {
    const status = deriveActivityStatus({ state: emptyConversationState(), streaming: false, pendingMessages: 2 });
    expect(status).toEqual({ phase: "queued", label: "已排队 2 条消息" });
  });

  it("keeps waiting while awaiting even if follow-up messages are queued", () => {
    expect(deriveActivityStatus({
      state: emptyConversationState(),
      streaming: false,
      pendingMessages: 2,
      awaiting: true,
    })?.phase).toBe("waiting");
  });

  it("prefers the running tool over the streaming text that precedes it, keeping one command line", () => {
    const state = stateWith({
      messages: [message("m1", "text", "先读一下这个文件")],
      tools: [
        tool({ toolCallId: "c1", toolName: "read", status: "succeeded", arguments: { path: "a/b/old.ts" } }),
        tool({ toolCallId: "c2", toolName: "bash", status: "running", arguments: { command: "npm run check\nnpm run lint" } }),
      ],
    });
    expect(deriveActivityStatus({ state, streaming: true, pendingMessages: 0 })).toEqual({
      phase: "tool",
      label: "正在运行",
      detail: "npm run check",
    });
  });

  it("shows the file name rather than the full path for path-shaped tools", () => {
    const state = stateWith({
      tools: [tool({ toolCallId: "c1", toolName: "read", status: "running", arguments: { path: "apps/renderer/src/App.tsx" } })],
    });
    expect(deriveActivityStatus({ state, streaming: true, pendingMessages: 0 })).toEqual({
      phase: "tool",
      label: "正在读取",
      detail: "App.tsx",
    });
  });

  it("falls back to a generic verb with the tool label for unmapped tools", () => {
    const state = stateWith({ tools: [tool({ toolCallId: "c1", toolName: "checkpoint", status: "running" })] });
    expect(deriveActivityStatus({ state, streaming: true, pendingMessages: 0 })).toEqual({
      phase: "tool",
      label: "正在执行 Checkpoint",
    });
  });

  it("distinguishes thinking from replying by the latest live block", () => {
    const thinking = stateWith({ messages: [message("m1", "thinking", "在权衡两种方案")] });
    expect(deriveActivityStatus({ state: thinking, streaming: true, pendingMessages: 0 })?.phase).toBe("thinking");
    const replying = stateWith({ messages: [message("m1", "text", "我先改 App.tsx")] });
    expect(deriveActivityStatus({ state: replying, streaming: true, pendingMessages: 0 })?.phase).toBe("responding");
  });

  it("shows Retry N/M only while waiting, not after a live operation starts", () => {
    const retry = { attempt: 5, maxAttempts: 10 };
    expect(deriveActivityStatus({
      state: emptyConversationState(),
      streaming: false,
      pendingMessages: 0,
      retry,
    })).toEqual({ phase: "waiting", label: WORKING_LABEL, retry });
    const state = stateWith({
      tools: [tool({ toolCallId: "c1", toolName: "read", status: "running", arguments: { path: "App.tsx" } })],
    });
    expect(deriveActivityStatus({ state, streaming: true, pendingMessages: 0, retry })).toEqual({
      phase: "tool",
      label: "正在读取",
      detail: "App.tsx",
    });
  });
});

describe("reduceAwaitingTurn", () => {
  const idle = { latched: false, wasStreaming: false };

  it("latches on send and keeps the latch after the optimistic user row is reconciled", () => {
    const sending = reduceAwaitingTurn(idle, { sending: true, pending: false, streaming: false, failed: false });
    expect(sending.latched).toBe(true);
    const pending = reduceAwaitingTurn(sending, { sending: false, pending: true, streaming: false, failed: false });
    expect(pending.latched).toBe(true);
    const reconciled = reduceAwaitingTurn(pending, { sending: false, pending: false, streaming: false, failed: false });
    expect(reconciled.latched).toBe(true);
  });

  it("clears when streaming ends, or when the prompt fails before a run starts", () => {
    const streaming = reduceAwaitingTurn(
      { latched: true, wasStreaming: false },
      { sending: false, pending: false, streaming: true, failed: false },
    );
    expect(reduceAwaitingTurn(streaming, { sending: false, pending: false, streaming: false, failed: false }).latched).toBe(false);
    expect(reduceAwaitingTurn(
      { latched: true, wasStreaming: false },
      { sending: false, pending: false, streaming: false, failed: true },
    ).latched).toBe(false);
  });
});

describe("isAbortEligible", () => {
  const idle = { executionMatches: true, streaming: false, pendingMessages: 0, awaiting: false };

  it("allows abort while awaiting the first stream, before snapshot.isStreaming flips", () => {
    expect(isAbortEligible({ ...idle, awaiting: true })).toBe(true);
    expect(isAbortEligible(idle)).toBe(false);
  });

  it("allows abort while streaming or while Runtime follow-ups are queued", () => {
    expect(isAbortEligible({ ...idle, streaming: true })).toBe(true);
    expect(isAbortEligible({ ...idle, pendingMessages: 1 })).toBe(true);
    expect(isAbortEligible({ ...idle, retrying: true })).toBe(true);
  });

  it("refuses abort when the viewed session is not the live Runtime session", () => {
    expect(isAbortEligible({ executionMatches: false, streaming: true, pendingMessages: 1, awaiting: true })).toBe(false);
  });
});

describe("syncRunWindow", () => {
  it("keeps the original start across remounts of the same active session", () => {
    const store = new Map<string, number>();
    expect(syncRunWindow("s1", true, 1_000, store)).toBe(1_000);
    expect(syncRunWindow("s1", true, 8_000, store)).toBe(1_000);
  });

  it("starts a new clock after the run ends, and does not reset a sibling session", () => {
    const store = new Map<string, number>();
    expect(syncRunWindow("s1", true, 1_000, store)).toBe(1_000);
    expect(syncRunWindow("s2", true, 2_000, store)).toBe(2_000);
    expect(syncRunWindow("s1", false, 3_000, store)).toBeNull();
    expect(syncRunWindow("s2", true, 4_000, store)).toBe(2_000);
    expect(syncRunWindow("s1", true, 5_000, store)).toBe(5_000);
  });

  it("migrates a pending window onto the session identity when it arrives", () => {
    const store = new Map<string, number>();
    expect(syncRunWindow("", true, 1_000, store)).toBe(1_000);
    expect(syncRunWindow("s1", true, 2_000, store)).toBe(1_000);
    expect(syncRunWindow("s1", true, 3_000, store)).toBe(1_000);
  });
});

describe("activity retry notices", () => {
  const idle = {
    identityKey: "s1",
    noticeCount: 0,
    seenStream: false,
    wasStreaming: false,
  };
  const retryNotice = { message: "Retry 5/10", source: "retry" as const };

  it("parses Runtime Retry N/M notices and ignores other sources", () => {
    expect(parseRetryNotice("Retry 5/10", "retry")).toEqual({ attempt: 5, maxAttempts: 10 });
    expect(formatRetry({ attempt: 5, maxAttempts: 10 })).toBe("Retry 5/10");
    expect(isRetryActivityNotice("Retry 5/10", "retry")).toBe(true);
    expect(parseRetryNotice("Retry 5/10", "priority")).toBeUndefined();
    expect(parseRetryNotice("正在同步压缩摘要", "retry")).toBeUndefined();
  });

  it("holds Retry N/M through backoff and clears after the retried stream ends", () => {
    const started = reduceActivityRetry(idle, {
      identityKey: "s1",
      notices: [retryNotice],
      streaming: false,
      failed: false,
    });
    expect(started.retry).toEqual({ attempt: 5, maxAttempts: 10 });
    const backoff = reduceActivityRetry(started, {
      identityKey: "s1",
      notices: [retryNotice],
      streaming: false,
      failed: false,
    });
    expect(backoff.retry).toEqual({ attempt: 5, maxAttempts: 10 });
    const streaming = reduceActivityRetry(backoff, {
      identityKey: "s1",
      notices: [retryNotice],
      streaming: true,
      failed: false,
    });
    expect(streaming.retry).toEqual({ attempt: 5, maxAttempts: 10 });
    expect(reduceActivityRetry(streaming, {
      identityKey: "s1",
      notices: [retryNotice],
      streaming: false,
      failed: false,
    }).retry).toBeUndefined();
  });

  it("refreshes the counter when another retry notice arrives on the falling edge", () => {
    const first = reduceActivityRetry(idle, {
      identityKey: "s1",
      notices: [retryNotice],
      streaming: false,
      failed: false,
    });
    const streaming = reduceActivityRetry(first, {
      identityKey: "s1",
      notices: [retryNotice],
      streaming: true,
      failed: false,
    });
    const next = reduceActivityRetry(streaming, {
      identityKey: "s1",
      notices: [retryNotice, { message: "Retry 6/10", source: "retry" }],
      streaming: false,
      failed: false,
    });
    expect(next.retry).toEqual({ attempt: 6, maxAttempts: 10 });
  });

  it("clears Retry N/M when the user aborts during backoff, before a stream starts", () => {
    const started = reduceActivityRetry(idle, {
      identityKey: "s1",
      notices: [retryNotice],
      streaming: false,
      failed: false,
    });
    expect(started.retry).toEqual({ attempt: 5, maxAttempts: 10 });
    expect(reduceActivityRetry(started, {
      identityKey: "s1",
      notices: [retryNotice],
      streaming: false,
      failed: false,
      cancelGeneration: 1,
    }).retry).toBeUndefined();
  });

  it("clears Retry N/M when Runtime emits auto_retry_end", () => {
    const started = reduceActivityRetry(idle, {
      identityKey: "s1",
      notices: [retryNotice],
      streaming: false,
      failed: false,
    });
    expect(reduceActivityRetry(started, {
      identityKey: "s1",
      notices: [retryNotice, { message: "Retry cancelled", source: "retry-end" }],
      streaming: false,
      failed: false,
    }).retry).toBeUndefined();
  });
});

describe("activity formatting", () => {
  it("caps the detail at one collapsed line", () => {
    expect(shortenDetail("  git   log \n --oneline ")).toBe("git log");
    expect(shortenDetail("abcdefghij", 5)).toBe("abcd…");
  });

  it("formats elapsed time in seconds, minutes, then hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(8_400)).toBe("8s");
    expect(formatElapsed(72_000)).toBe("1m 12s");
    expect(formatElapsed(3_723_000)).toBe("1h 02m");
  });

  it("abbreviates token counts above a thousand", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_400)).toBe("1.4k");
    expect(formatTokens(18_400)).toBe("18k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});
