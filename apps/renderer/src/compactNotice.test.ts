import { describe, expect, it } from "vitest";
import { compactNoticeFromOutput, formatCompactFailure } from "./compactNotice";

describe("compactNoticeFromOutput", () => {
  it("maps session-too-small to the keep-recent contract, not the model window", () => {
    const notice = compactNoticeFromOutput([
      "Compaction failed: Nothing to compact (session too small)",
    ]);
    expect(notice.ok).toBe(false);
    expect(notice.text).toContain("2 万");
    expect(notice.text).toContain("没有更早");
    expect(notice.text).not.toMatch(/session too small/i);
  });

  it("maps already-compacted without inventing a new summary", () => {
    const notice = compactNoticeFromOutput(["Compaction failed: Already compacted"]);
    expect(notice.ok).toBe(false);
    expect(notice.text).toContain("已经压过了");
  });

  it("keeps an unknown compaction failure as a failure, not a success toast", () => {
    const notice = compactNoticeFromOutput(["Compaction failed: No model selected"]);
    expect(notice.ok).toBe(false);
    expect(notice.text).toBe("压缩失败：No model selected");
  });

  it("uses the success fallback when Runtime did not emit a failure line", () => {
    const notice = compactNoticeFromOutput(["ok"], { successText: "已压缩上下文" });
    expect(notice).toEqual({ ok: true, text: "已压缩上下文" });
  });
});

describe("formatCompactFailure", () => {
  it("treats no-messages the same as too-small", () => {
    expect(formatCompactFailure("Compaction failed: Nothing to compact (no messages yet)")).toContain("没有更早");
  });
});
