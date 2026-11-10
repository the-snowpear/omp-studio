import { describe, expect, it } from "vitest";
import { buildChangesDockMeter } from "./ChangesDockMeter";

const base = { preview: false, marks: false, zh: true } as const;

describe("folded Changes card summary", () => {
  it("shows the latest turn as file count plus line delta", () => {
    const meter = buildChangesDockMeter({ ...base, files: [
      { path: "components/MermaidBlock.tsx", add: 6, del: 3 },
      { path: "docs/UPSTREAM-SYNC.md", add: 214, del: 0 },
    ] });
    expect(meter.counts.map(item => [item.id, item.prefix, item.count])).toEqual([["add", "+", 220], ["del", "−", 3]]);
    expect(meter.note).toBe("2 个文件");
    expect(meter.label).toBe("2 个文件 · +220 −3");
    expect(meter.badge).toBe(2);
  });

  it("keeps empty turns and line-less edits apart", () => {
    const empty = buildChangesDockMeter({ ...base, files: [] });
    expect(empty.counts).toEqual([]);
    expect(empty.emptyLabel).toBe("本轮无改动");
    expect(empty.badge).toBe(0);
    const binary = buildChangesDockMeter({ ...base, files: [{ path: "logo.png", add: 0, del: 0 }] });
    expect(binary.counts.map(item => [item.id, item.label])).toEqual([["files", "个文件"]]);
    expect(binary.total).toBe(1);
    expect(binary.label).toBe("1 个文件");
  });
});
