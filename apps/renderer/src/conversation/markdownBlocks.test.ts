import { describe, expect, it } from "vitest";
import { scanStreamingMarkdown, splitStreamingMarkdown, type StreamingMarkdownScan } from "./markdownBlocks";

function visible(scan: StreamingMarkdownScan) {
  return {
    closed: [...scan.frozen, ...scan.pending],
    tail: scan.tail,
    openFence: scan.openFence,
  };
}

describe("splitStreamingMarkdown", () => {
  it("freezes complete top-level blocks and leaves only the mutable tail", () => {
    expect(splitStreamingMarkdown("intro\n\n## Next\npartial")).toEqual({ closed: ["intro\n\n"], tail: "## Next\npartial" });
  });
  it("freezes ordinary prose paragraphs so long streams do not reparse the full prefix", () => {
    const source = Array.from({ length: 200 }, (_, index) => `paragraph ${index}`).join("\n\n") + "\n\nstill typing";
    const parts = splitStreamingMarkdown(source);
    expect(parts.closed).toHaveLength(200);
    expect(parts.tail).toBe("still typing");
  });
  it("never splits inside fences, loose list continuations, or setext headings", () => {
    expect(splitStreamingMarkdown("```ts\nconst x = 1\n\n## not heading\n")).toEqual({
      closed: [],
      tail: "",
      openFence: { language: "ts", code: "const x = 1\n\n## not heading\n" },
    });
    expect(splitStreamingMarkdown("- item\n\n  continuation\n\n## Tail").closed).toEqual(["- item\n\n  continuation\n\n"]);
    expect(splitStreamingMarkdown("heading\n\nTitle\n---\nbody").closed).toEqual([]);
  });
  it("keeps reference-definition documents whole", () => {
    expect(splitStreamingMarkdown("[docs][id]\n\n## Tail\n[id]: https://example.com").closed).toEqual([]);
  });
  it("separates an open streaming fence from the markdown prefix", () => {
    expect(splitStreamingMarkdown("intro\n\n```tsx title=demo\nconst view = <Demo />\n")).toEqual({
      closed: ["intro\n\n"],
      tail: "",
      openFence: { language: "tsx", code: "const view = <Demo />\n" },
    });
    expect(splitStreamingMarkdown("```ts\nconst done = true\n```\n")).toEqual({
      closed: [],
      tail: "```ts\nconst done = true\n```\n",
    });
  });
});

/** 逐字符喂进去，续扫结果必须与一次性全量扫描逐帧相等。 */
function replay(source: string, step: number): void {
  let previous: StreamingMarkdownScan | undefined;
  for (let end = 1; end <= source.length; end += step) {
    const prefix = source.slice(0, Math.min(end, source.length));
    const incremental = scanStreamingMarkdown(prefix, previous);
    const oneShot = scanStreamingMarkdown(prefix);
    expect(visible(incremental)).toEqual(visible(oneShot));
    previous = incremental;
  }
}

describe("scanStreamingMarkdown 续扫", () => {
  it("与全量扫描等价：散文段落", () => {
    replay(Array.from({ length: 40 }, (_, index) => `第 ${index} 段正文，够长以便触发切分。`).join("\n\n"), 1);
  });
  it("与全量扫描等价：围栏、列表续行、setext 标题", () => {
    replay("intro\n\n```ts\nconst a = 1\n\n## not heading\n```\n\n- item\n\n  continuation\n\nTitle\n---\nbody\n\n尾巴", 1);
  });
  it("与全量扫描等价：引用定义中途出现", () => {
    replay("[docs][id]\n\n## Tail\n\nbody\n\n[id]: https://example.com\n\nmore", 1);
  });
  it("与全量扫描等价：CRLF", () => {
    replay("一段\r\n\r\n二段\r\n\r\n```ts\r\nconst x = 1\r\n", 1);
  });
  it("同一份文本重复扫描是幂等的（StrictMode 会把 useMemo 跑两遍）", () => {
    const source = "一段\n\n二段\n\n```ts\nconst x = 1\n";
    const once = scanStreamingMarkdown(source);
    const twice = scanStreamingMarkdown(source, once);
    expect(visible(twice)).toEqual(visible(once));
    expect(twice.checkpoint).toEqual(once.checkpoint);
  });
  it("续扫代价只跟新增文本有关：长围栏不会每帧重扫", () => {
    const head = "intro\n\n```ts\n";
    let source = head;
    let scan = scanStreamingMarkdown(source);
    for (let line = 0; line < 400; line += 1) {
      source += `const v${line} = ${line};\n`;
      scan = scanStreamingMarkdown(source, scan);
    }
    expect(scan.openFence?.language).toBe("ts");
    // 检查点已经推进到围栏深处，而不是停在文档开头。
    expect(scan.checkpoint.at).toBeGreaterThan(source.length - 200);
    expect(scan.checkpoint.fence).not.toBeNull();
  });
  it("普通 token 追加不会重建已冻结块数组", () => {
    let source = Array.from({ length: 200 }, (_, index) => `paragraph ${index}`).join("\n\n") + "\n\ntail";
    let scan = scanStreamingMarkdown(source);
    const frozen = scan.frozen;
    for (let index = 0; index < 100; index += 1) {
      source += "x";
      scan = scanStreamingMarkdown(source, scan);
      expect(scan.frozen).toBe(frozen);
      expect(scan.pending.length).toBeLessThanOrEqual(2);
    }
  });
  it("只检查上一帧的半行也能发现跨 chunk 补全的引用定义", () => {
    const first = scanStreamingMarkdown("intro\n\n[id]");
    expect(first.keepWhole).toBe(false);
    const second = scanStreamingMarkdown("intro\n\n[id]: https://example.com", first);
    expect(second.keepWhole).toBe(true);
    expect(visible(second).closed).toEqual([]);
  });
});
