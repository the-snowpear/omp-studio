import { afterEach, describe, expect, it } from "vitest";
import type { TimelineRow } from "./conversationViewModel";
import { clearSessionRowsCache, forgetSessionRows, recallSessionRows, rememberSessionRows } from "./sessionRowsCache";
import {
  recallSessionConversation,
  rememberSessionViewport,
  sessionConversationCacheStats,
  timelineRowsSignature,
} from "./sessionConversationCache";

function rows(count: number): readonly TimelineRow[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "user" as const,
    itemId: `u${index}`,
    text: `line ${index}`,
    createdAt: "2026-08-25T00:00:00.000Z",
  })) as unknown as readonly TimelineRow[];
}

afterEach(() => {
  clearSessionRowsCache();
});

describe("session conversation cache", () => {
  it("returns the rows a session was last rendered with", () => {
    const stored = rows(3);
    rememberSessionRows("session-a", stored);
    expect(recallSessionRows("session-a")).toBe(stored);
    expect(recallSessionRows("session-b")).toBeUndefined();
    expect(recallSessionRows(undefined)).toBeUndefined();
  });

  it("keeps five sessions and evicts the least recently used one", () => {
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) rememberSessionRows(id, rows(1));
    // 回看 s1 让它变成最近使用，s2 成为下一个被淘汰的。
    expect(recallSessionRows("s1")).toBeDefined();
    rememberSessionRows("s6", rows(1));
    expect(recallSessionRows("s1")).toBeDefined();
    expect(recallSessionRows("s2")).toBeUndefined();
    expect(recallSessionRows("s6")).toBeDefined();
  });

  it("keeps a complete cached window instead of slicing through a turn", () => {
    rememberSessionRows("session-a", rows(120));
    const kept = recallSessionRows("session-a");
    expect(kept?.length).toBe(120);
    expect(kept?.at(-1)).toEqual(expect.objectContaining({ itemId: "u119" }));
  });

  it("stores semantic and Virtuoso scroll metadata with the same session entry", () => {
    const stored = rows(3);
    rememberSessionRows("session-a", stored);
    rememberSessionViewport("session-a", {
      atBottom: false,
      anchor: { itemId: "u1", offset: 7 },
      firstItemIndex: 999_998,
      rowSignature: timelineRowsSignature(stored),
      virtuosoState: { ranges: [{ startIndex: 0, endIndex: 2, size: 40 }], scrollTop: 88 },
    });
    expect(recallSessionConversation("session-a")?.viewport).toMatchObject({
      atBottom: false,
      anchor: { itemId: "u1", offset: 7 },
      firstItemIndex: 999_998,
      virtuosoState: { scrollTop: 88 },
    });
  });

  it("tracks a shared byte budget", () => {
    rememberSessionRows("session-a", rows(10));
    expect(sessionConversationCacheStats()).toMatchObject({ entries: 1 });
    expect(sessionConversationCacheStats().bytes).toBeGreaterThan(0);
  });

  it("drops a session on demand and ignores empty writes", () => {
    rememberSessionRows("session-a", rows(2));
    rememberSessionRows("session-b", []);
    forgetSessionRows("session-a");
    expect(recallSessionRows("session-a")).toBeUndefined();
    expect(recallSessionRows("session-b")).toBeUndefined();
  });
});
