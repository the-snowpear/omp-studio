import { describe, expect, it } from "vitest";

import { reuseTimelineRows } from "./rowReuse";
import type { TimelineRow } from "./conversationViewModel";

function assistant(itemId: string, text: string, status: "streaming" | "completed" = "completed"): TimelineRow {
  return {
    type: "assistant",
    itemId,
    createdAt: "2026-08-25T00:00:00.000Z",
    segments: [{ type: "text", key: "text-0", text }],
    status,
  };
}

function user(itemId: string, text: string): TimelineRow {
  return { type: "user", itemId, createdAt: "2026-08-25T00:00:00.000Z", text };
}

describe("reuseTimelineRows", () => {
  it("keeps the previous array when every row is structurally unchanged", () => {
    const previous = [user("u1", "你好"), assistant("m1", "回答")];
    const next = [user("u1", "你好"), assistant("m1", "回答")];
    expect(reuseTimelineRows(previous, next)).toBe(previous);
  });

  it("reuses the settled rows and only replaces the row that changed", () => {
    const previous = [user("u1", "你好"), assistant("m1", "回答"), assistant("m2", "写作中", "streaming")];
    const next = [user("u1", "你好"), assistant("m1", "回答"), assistant("m2", "写作中…", "streaming")];
    const rows = reuseTimelineRows(previous, next);
    expect(rows).not.toBe(previous);
    expect(rows[0]).toBe(previous[0]);
    expect(rows[1]).toBe(previous[1]);
    expect(rows[2]).toBe(next[2]);
  });

  it("reuses a row that only moved, and reports the array as changed", () => {
    const previous = [assistant("m1", "甲"), assistant("m2", "乙")];
    const next = [assistant("m2", "乙"), assistant("m1", "甲")];
    const rows = reuseTimelineRows(previous, next);
    expect(rows).not.toBe(previous);
    expect(rows[0]).toBe(previous[1]);
    expect(rows[1]).toBe(previous[0]);
  });

  it("takes the new rows when a row appears", () => {
    const previous = [user("u1", "你好")];
    const next = [user("u1", "你好"), assistant("m1", "回答")];
    const rows = reuseTimelineRows(previous, next);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(previous[0]);
    expect(rows[1]).toBe(next[1]);
  });

  it("does not treat different tool payloads as the same row", () => {
    const withTool = (output: string): TimelineRow => ({
      type: "assistant",
      itemId: "m1",
      createdAt: "2026-08-25T00:00:00.000Z",
      status: "streaming",
      segments: [
        { type: "batch", key: "batch-0", tools: [{ toolCallId: "c1", toolName: "bash", status: "running", output }] },
      ],
    });
    const previous = [withTool("part")];
    const rows = reuseTimelineRows(previous, [withTool("part+more")]);
    expect(rows[0]).not.toBe(previous[0]);
  });

  it("passes the fresh rows through when there is nothing to reuse", () => {
    const next = [user("u1", "你好")];
    expect(reuseTimelineRows([], next)).toBe(next);
  });
});
