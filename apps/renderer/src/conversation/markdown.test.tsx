import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IncrementalMarkdownBlocks, type MarkdownBlocks } from "./incrementalMarkdown";
import { MarkdownInline, MarkdownText } from "./markdown";

afterEach(cleanup);

describe("MarkdownInline", () => {
  it("drops javascript and other unsafe hrefs that Ask cards would otherwise render", () => {
    const { container } = render(
      <MarkdownInline text={'click [here](javascript:alert(1)) and [docs](https://example.com/a)'} />,
    );
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a");
    expect(container.querySelector("a")?.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("renders http images only", () => {
    const { container } = render(
      <MarkdownInline text={'![ok](https://example.com/a.png) ![bad](file:///C:/secret.png)'} />,
    );
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("https://example.com/a.png");
  });
});

const STREAM_DOC = [
  "## 标题",
  "",
  "第一段，带 `代码片段` 与 **加粗**。",
  "",
  "- 列表甲",
  "- 列表乙",
  "",
  "```ts",
  "const answer: number = 42;",
  "export function id<T>(value: T): T {",
  "  return value;",
  "}",
  "```",
  "",
  "| 列 | 值 |",
  "| --- | --- |",
  "| a | 1 |",
  "",
  "最后一段。",
].join("\n");

function chunks(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(0, index + size));
  if (parts[parts.length - 1] !== text) parts.push(text);
  return parts;
}

describe("IncrementalMarkdownBlocks", () => {
  it("freezes finished top-level blocks and only leaves the tail unparsed", () => {
    const blocks = new IncrementalMarkdownBlocks();
    const first = blocks.update("# 标题\n\n段落一\n\n段落二\n\n段落三");
    expect(first.frozen.map((block) => block.source)).toEqual(["# 标题", "段落一"]);
    expect(first.tail).toBe("\n\n段落二\n\n段落三");
  });

  it("keeps frozen sources and keys stable while the text grows", () => {
    const blocks = new IncrementalMarkdownBlocks();
    let previous: MarkdownBlocks | undefined;
    for (const text of chunks(STREAM_DOC, 24)) {
      const current = blocks.update(text);
      if (previous !== undefined) {
        // 已冻结的块只增不改：这正是每段源码在整条流里只被解析一次的凭据。
        expect(current.frozen.slice(0, previous.frozen.length)).toEqual(previous.frozen);
      }
      expect(text.endsWith(current.tail)).toBe(true);
      previous = current;
    }
    const last = blocks.update(STREAM_DOC);
    expect(last.frozen.length).toBeGreaterThan(2);
    expect(last.frozen.every((block) => STREAM_DOC.slice(block.key).startsWith(block.source))).toBe(true);
  });

  it("rebuilds from scratch when the text is no longer an append", () => {
    const blocks = new IncrementalMarkdownBlocks();
    blocks.update("段落一\n\n段落二\n\n段落三");
    const replaced = blocks.update("别的正文\n\n第二段\n\n第三段");
    expect(replaced.frozen.map((block) => block.source)).toEqual(["别的正文"]);
    expect(replaced.tail).toBe("\n\n第二段\n\n第三段");
  });

  it("returns the cached result for a repeated text", () => {
    const blocks = new IncrementalMarkdownBlocks();
    const first = blocks.update(STREAM_DOC);
    expect(blocks.update(STREAM_DOC)).toBe(first);
  });
});

describe("MarkdownText streaming", () => {
  it("renders chunk-by-chunk into the same DOM as one settled parse", () => {
    const streamed = render(<MarkdownText text="" streaming />);
    for (const text of chunks(STREAM_DOC, 17)) streamed.rerender(<MarkdownText text={text} streaming />);
    const settled = render(<MarkdownText text={STREAM_DOC} />);
    expect(streamed.container.innerHTML).toBe(settled.container.innerHTML);
  });

  it("keeps highlighting frozen code blocks while streaming", () => {
    const { container, rerender } = render(<MarkdownText text="" streaming />);
    rerender(<MarkdownText text={STREAM_DOC} streaming />);
    expect(container.querySelector(".md-code-lang")?.textContent).toBe("ts");
    expect(container.querySelectorAll("pre.codeblock code .hljs-keyword").length).toBeGreaterThan(0);
  });

  it("defers highlighting for the unstable code tail until streaming completes", () => {
    const tail = ["```ts", "const answer: number = 42;", "```"].join("\n");
    const { container, rerender } = render(<MarkdownText text={tail} streaming />);
    expect(container.querySelector("pre.codeblock code")?.textContent).toContain("const answer");
    expect(container.querySelector("pre.codeblock code .hljs-keyword")).toBeNull();

    rerender(<MarkdownText text={tail} />);
    expect(container.querySelector("pre.codeblock code .hljs-keyword")).not.toBeNull();
  });

  it("switches to the settled render when streaming ends", () => {
    const { container, rerender } = render(<MarkdownText text={STREAM_DOC} streaming />);
    const streamingHtml = container.innerHTML;
    rerender(<MarkdownText text={STREAM_DOC} />);
    expect(container.innerHTML).toBe(streamingHtml);
  });
});

const REFERENCE_DOC = [
  "正文引用脚注[^1]，还有一个[链接][ref]。",
  "",
  "第二段占位，让前面的块进入冻结区。",
  "",
  "第三段占位。",
  "",
  "[^1]: 脚注正文。",
  "",
  "[ref]: https://example.com/a",
].join("\n");

describe("MarkdownText cross-block references", () => {
  it("marks footnote and link-reference documents as whole-document renders", () => {
    const blocks = new IncrementalMarkdownBlocks();
    expect(blocks.update(REFERENCE_DOC).crossBlockReference).toBe(true);
  });

  it("stays incremental for a footnote-style citation that has no definition", () => {
    const blocks = new IncrementalMarkdownBlocks();
    const doc = ["引用了来源[^1]，但没有定义。", "", "第二段。", "", "第三段。"].join("\n");
    const result = blocks.update(doc);
    expect(result.crossBlockReference).toBe(false);
    expect(result.frozen.length).toBeGreaterThan(0);
    const streamed = render(<MarkdownText text={doc} streaming />);
    const settled = render(<MarkdownText text={doc} />);
    expect(streamed.container.innerHTML).toBe(settled.container.innerHTML);
  });

  it("does not fall back for bracket patterns inside code fences", () => {
    const blocks = new IncrementalMarkdownBlocks();
    const doc = ["段落一", "", "```ts", "const re = /[^0-9]+/g;", "```", "", "段落二", "", "段落三"].join("\n");
    expect(blocks.update(doc).crossBlockReference).toBe(false);
  });

  it("streams a footnote document into the same DOM as the settled render", () => {
    const streamed = render(<MarkdownText text="" streaming />);
    for (const text of chunks(REFERENCE_DOC, 13)) streamed.rerender(<MarkdownText text={text} streaming />);
    const settled = render(<MarkdownText text={REFERENCE_DOC} />);
    expect(streamed.container.innerHTML).toBe(settled.container.innerHTML);
    expect(streamed.container.querySelectorAll(".footnotes").length).toBe(1);
    expect(streamed.container.querySelector('a[href="https://example.com/a"]')).not.toBeNull();
  });
});
