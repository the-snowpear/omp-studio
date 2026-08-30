import { describe, expect, it } from "vitest";
import type { VirtualItem } from "@tanstack/react-virtual";
import { capVirtualItems, MAX_MOUNTED_CONVERSATION_ROWS } from "./ConversationVirtualList";

function items(count: number): readonly VirtualItem[] {
  return Array.from({ length: count }, (_, index) => ({ index })) as unknown as readonly VirtualItem[];
}

describe("conversation virtual window", () => {
  it("enforces a hard mounted-row ceiling", () => {
    expect(capVirtualItems(items(500))).toHaveLength(MAX_MOUNTED_CONVERSATION_ROWS);
  });

  it("keeps the tail of the range, because the transcript is anchored at the bottom", () => {
    const capped = capVirtualItems(items(500));
    expect(capped[0]!.index).toBe(500 - MAX_MOUNTED_CONVERSATION_ROWS);
    expect(capped[capped.length - 1]!.index).toBe(499);
  });

  it("passes a range that already fits through untouched", () => {
    const range = items(12);
    expect(capVirtualItems(range)).toBe(range);
  });

  it("honours an explicit ceiling", () => {
    const capped = capVirtualItems(items(10), 3);
    expect(capped.map((item) => item.index)).toEqual([7, 8, 9]);
  });
});
