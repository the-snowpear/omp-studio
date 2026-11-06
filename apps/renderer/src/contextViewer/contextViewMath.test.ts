import { describe, expect, it } from "vitest";
import type { ContextCategorySummary, ContextEntrySummary, ContextViewIndex } from "@omp-studio/studio-protocol";
import {
  allocateTokens,
  allocateUsage,
  compactTokens,
  entryTokenLabel,
  formatShare,
  groupEntries,
  meterSegments,
} from "./contextViewMath";

const category = (id: ContextCategorySummary["id"], tokens: number, extra: Partial<ContextCategorySummary> = {}): ContextCategorySummary => ({ id, label: id, tokens, entries: 1, ...extra });

const index = (extra: Partial<ContextViewIndex> = {}): ContextViewIndex => ({
  sessionId: "s",
  snapshotId: "snap",
  capturedAt: "2026-11-01T10:00:00.000Z",
  contextWindow: 100,
  usedTokens: 60,
  freeTokens: 30,
  bufferTokens: 10,
  thresholdTokens: null,
  savedTokens: 0,
  truncated: false,
  categories: [category("system-prompt", 40), category("skills", 20)],
  ...extra,
});

const entry = (id: string, extra: Partial<ContextEntrySummary> = {}): ContextEntrySummary => ({ id, label: id, tokens: 100, bytes: 10, ...extra });

describe("contextViewMath", () => {
  it("splits a total by weight without losing or inventing tokens", () => {
    expect(allocateTokens([3, 1, 1], 10)).toEqual([6, 2, 2]);
    expect(allocateTokens([1, 1, 1], 10)).toEqual([4, 3, 3]);
    expect(allocateTokens([1, 1], 10)!.reduce((sum, value) => sum + value, 0)).toBe(10);
    expect(allocateTokens([0, 0], 10)).toBeUndefined();
  });

  it("attributes usage to categories and their tool groups", () => {
    const allocation = allocateUsage(
      [
        category("tool-output", 30, {
          children: [{ id: "tool-output", label: "bash", key: "tool-output/tool-0", tokens: 20, entries: 1 }],
        }),
        category("user-messages", 10),
      ],
      60,
    )!;
    expect(allocation.get("tool-output")).toBe(45);
    expect(allocation.get("tool-output/tool-0")).toBe(45);
    expect(allocation.get("user-messages")).toBe(15);
  });

  it("formats shares and small values", () => {
    expect(formatShare(220_400, 1_000_000)).toBe("22.0%");
    expect(formatShare(449, 1_000_000)).toBe("<0.1%");
    expect(formatShare(0, 1_000_000)).toBe("0.0%");
    expect(formatShare(1, 0)).toBe("—");
    expect(compactTokens(1_234_567)).toBe("1.23M");
    expect(compactTokens(12_345)).toBe("12.3k");
    expect(compactTokens(987)).toBe("987");
  });

  it("orders meter segments categories → buffer → free and keeps the window whole", () => {
    const segments = meterSegments(index(), undefined);
    expect(segments.map(segment => segment.key)).toEqual(["system-prompt", "skills", "buffer", "free"]);
    expect(segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(100);
    expect(segments.at(-2)?.striped).toBe(true);
  });

  it("never reports zero tokens for members of a thinking group", () => {
    const group = { id: "thinking-1", label: "Message 4", tokens: 15_000 };
    expect(entryTokenLabel(entry("a", { tokens: 0, thinkingGroup: group }), true)).toBe("—");
    expect(entryTokenLabel(entry("b", { interrupted: true }), true)).toBe("N/A · 已中断");
    expect(entryTokenLabel(entry("c", { tokens: 1 }), true)).toBe("1 token");
    expect(entryTokenLabel(entry("d", { tokens: 1_200 }), false)).toBe("1,200 tokens");
  });

  it("groups consecutive thinking entries and repeats the heading across page breaks", () => {
    const group = { id: "thinking-1", label: "Message 4", tokens: 15_000 };
    const groups = groupEntries([
      entry("a", { thinkingGroup: group }),
      entry("b", { thinkingGroup: group }),
      entry("c"),
      entry("d", { thinkingGroup: group }),
    ]);
    expect(groups.map(item => [item.group?.id ?? item.key, item.entries.length])).toEqual([
      ["thinking-1", 2],
      ["c", 1],
      ["thinking-1", 1],
    ]);
  });
});
