import { describe, expect, it } from "vitest";
import { DEFAULT_ROW_ESTIMATE, rememberRowHeight, resetRowHeightCache, rowHeightEstimate } from "./rowHeightCache";

describe("rowHeightCache", () => {
  it("未记忆的键回退默认估高", () => {
    resetRowHeightCache();
    expect(rowHeightEstimate(undefined)).toBe(DEFAULT_ROW_ESTIMATE);
    expect(rowHeightEstimate("missing")).toBe(DEFAULT_ROW_ESTIMATE);
  });

  it("记忆行高后按行键取回，零与负值忽略", () => {
    resetRowHeightCache();
    rememberRowHeight("row-a", 218.5);
    expect(rowHeightEstimate("row-a")).toBe(218.5);
    rememberRowHeight("row-a", 0);
    rememberRowHeight("row-b", -3);
    expect(rowHeightEstimate("row-a")).toBe(218.5);
    expect(rowHeightEstimate("row-b")).toBe(DEFAULT_ROW_ESTIMATE);
  });

  it("超上限整体清空，内存有界", () => {
    resetRowHeightCache();
    rememberRowHeight("keep", 100);
    for (let index = 0; index < 8192; index += 1) rememberRowHeight(`row-${index}`, 50);
    expect(rowHeightEstimate("keep")).toBe(DEFAULT_ROW_ESTIMATE);
    expect(rowHeightEstimate("row-0")).toBe(DEFAULT_ROW_ESTIMATE);
    rememberRowHeight("fresh", 80);
    expect(rowHeightEstimate("fresh")).toBe(80);
  });
});
