import { describe, expect, it } from "vitest";
import type {
  ConversationItem,
  ConversationMessageItem,
  ConversationTranscriptReadPage,
  OpaqueCursor,
  SessionId,
} from "@omp-studio/client-contract";
import {
  CONVERSATION_WINDOW_ITEM_LIMIT,
  ConversationWindowError,
  readConversationWindow,
  startsAtConversationBoundary,
} from "./conversationWindow";

const sessionId = "session-a" as SessionId;

function message(itemId: string, role: ConversationMessageItem["role"], text = itemId): ConversationItem {
  return {
    kind: "message",
    itemId,
    parentId: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    role,
    content: [{ type: "text", text }],
  };
}

function page(
  items: readonly ConversationItem[],
  options: { older?: string; hasMore?: boolean; revision?: string; head?: string } = {},
): ConversationTranscriptReadPage {
  return {
    sessionId,
    transcriptRevision: options.revision ?? "revision-a",
    branchLeafId: "leaf-a",
    items,
    ...(options.older === undefined ? {} : { olderCursor: options.older as OpaqueCursor }),
    headCursor: (options.head ?? "head-a") as OpaqueCursor,
    hasMoreBefore: options.hasMore ?? options.older !== undefined,
  };
}

describe("conversation logical windows", () => {
  it("keeps reading while a physical page starts inside an assistant/tool run and commits oldest-first once", async () => {
    const newest = page([message("a-2", "assistant"), message("a-3", "assistant")], { older: "c-2" });
    const middle = page([message("a-1", "assistant")], { older: "c-1" });
    const oldest = page([message("u-1", "user")]);
    const reads: string[] = [];
    const window = await readConversationWindow(newest, async (cursor) => {
      reads.push(cursor);
      return cursor === "c-2" ? middle : oldest;
    });

    expect(reads).toEqual(["c-2", "c-1"]);
    expect(window.items.map((item) => item.itemId)).toEqual(["u-1", "a-1", "a-2", "a-3"]);
    expect(window.hasMoreBefore).toBe(false);
  });

  it("treats user, system, compaction, reset and the real head as safe boundaries", () => {
    expect(startsAtConversationBoundary(page([message("u", "user")], { older: "c" }))).toBe(true);
    expect(startsAtConversationBoundary(page([message("s", "system")], { older: "c" }))).toBe(true);
    expect(startsAtConversationBoundary(page([], { hasMore: false }))).toBe(true);
    expect(startsAtConversationBoundary(page([message("a", "assistant")], { older: "c" }))).toBe(false);
  });

  it("deduplicates overlapping cursors and rejects a changed revision before publishing", async () => {
    const newest = page([message("a", "assistant")], { older: "c" });
    await expect(readConversationWindow(newest, async () => page([message("u", "user")], { revision: "revision-b" })))
      .rejects.toMatchObject({ clientError: { code: "CURSOR_STALE" } });
  });

  it("fails explicitly instead of returning a half turn above the logical item cap", async () => {
    const newest = page(
      Array.from({ length: 100 }, (_, index) => message(`a-${index}`, "assistant")),
      { older: "c-1" },
    );
    let offset = 100;
    await expect(readConversationWindow(newest, async () => {
      const items = Array.from({ length: 100 }, (_, index) => message(`a-${offset + index}`, "assistant"));
      offset += 100;
      return page(items, { older: `c-${offset}` });
    })).rejects.toBeInstanceOf(ConversationWindowError);
    expect(offset).toBeGreaterThan(CONVERSATION_WINDOW_ITEM_LIMIT);
  });

  it("honours the remaining client-window budget before a prepend is published", async () => {
    await expect(readConversationWindow(
      page([message("a-1", "assistant")], { older: "c-1" }),
      async () => page([message("u-1", "user")]),
      { maxItems: 1 },
    )).rejects.toMatchObject({ clientError: { code: "INVALID_ARGUMENT" } });
  });
});
