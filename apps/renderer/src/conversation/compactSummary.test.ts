import { describe, expect, it } from "vitest";
import {
  compactMinimapPreview,
  compactRuleLabel,
  compactSummaryFoldable,
  isSnapcompactArchive,
} from "./compactSummary";

const SNAPCOMPACT_SUMMARY = [
  "You are resuming a prior conversation. Its earlier turns were archived to reclaim context and are reproduced under HISTORY below, oldest to newest.",
  "",
  "The archived transcript uses compact scopes:",
  "- `¶user:`, `¶think:`, `¶ai:`, and `¶call:` open user, assistant reasoning, assistant reply, and tool-call scopes.",
  "",
  "FILES",
  "===================",
  "package.json (Read)",
  "",
  "HISTORY",
  "===================",
].join("\n");

describe("compactRuleLabel", () => {
  it("keeps snapcompact HISTORY out of the compact-bar label", () => {
    const item = { summary: SNAPCOMPACT_SUMMARY };
    const label = compactRuleLabel(item);
    expect(isSnapcompactArchive(item.summary)).toBe(true);
    expect(label.includes("You are resuming")).toBe(false);
    expect(label.includes("HISTORY")).toBe(false);
    expect(label.length).toBeLessThan(40);
    expect(compactSummaryFoldable(item)).toBe(true);
  });

  it("prefers a shortSummary that is not itself the archive dump", () => {
    const item = { summary: SNAPCOMPACT_SUMMARY, shortSummary: "Compacted from 114,276 tokens" };
    expect(compactRuleLabel(item)).toBe("Compacted from 114,276 tokens");
    expect(compactMinimapPreview(item)).toBe("Compacted from 114,276 tokens");
  });

  it("does not fold a one-line summary that is already the label", () => {
    const item = { summary: "早期对话压缩" };
    expect(compactRuleLabel(item)).toBe("早期对话压缩");
    expect(compactSummaryFoldable(item)).toBe(false);
  });

  it("folds when the body is longer than the short label", () => {
    const item = { summary: "Earlier turns were summarized.", shortSummary: "Summarized history" };
    expect(compactRuleLabel(item)).toBe("Summarized history");
    expect(compactSummaryFoldable(item)).toBe(true);
  });

  it("caps oversized shortSummary (> 80 chars) to 已压缩 and makes it foldable", () => {
    const longShort = "I added a quick tool-availability check to satisfy the user's request to run a few harmless tools and wait about a minute for verification. The run confirmed that tools executed.";
    const item = { summary: longShort, shortSummary: longShort };
    expect(compactRuleLabel(item)).toBe("已压缩");
    expect(compactSummaryFoldable(item)).toBe(true);
  });

  it("handles empty summary with long shortSummary properly", () => {
    const longShort = "I added a quick tool-availability check to satisfy the user's request to run a few harmless tools and wait about a minute for verification.";
    const item = { summary: "", shortSummary: longShort };
    expect(compactRuleLabel(item)).toBe("已压缩");
    expect(compactSummaryFoldable(item)).toBe(true);
  });
});
