import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChunkedText, CHUNK_LINES, chunkText } from "./textChunks";

afterEach(cleanup);

describe("chunkText", () => {
  it("短文本不切块：单块返回，行数如实", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("one line")).toEqual([{ text: "one line", lines: 1 }]);
    expect(chunkText("a\nb\nc")).toEqual([{ text: "a\nb\nc", lines: 3 }]);
  });

  it("按固定行数切块，块内用换行连接、块间由布局换行", () => {
    const lines = Array.from({ length: CHUNK_LINES + 1 }, (_, index) => `line-${index}`);
    const chunks = chunkText(lines.join("\n"));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.lines).toBe(CHUNK_LINES);
    expect(chunks[0]!.text.split("\n")).toEqual(lines.slice(0, CHUNK_LINES));
    expect(chunks[1]!.lines).toBe(1);
    expect(chunks[1]!.text).toBe(`line-${CHUNK_LINES}`);
  });

  it("块内容与原文逐字等价（pre / pre-wrap 下渲染相同）", () => {
    const lines = Array.from({ length: CHUNK_LINES * 3 + 7 }, (_, index) => `row ${index}`);
    const chunks = chunkText(lines.join("\n"));
    expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(lines.join("\n"));
  });
});

describe("ChunkedText", () => {
  it("短文本保持单文本节点路径，不引入 cv 块", () => {
    const { container } = render(<ChunkedText text={"a\nb\nc"} />);
    expect(container.querySelector(".cv-chunk")).toBeNull();
    expect(container.textContent).toBe("a\nb\nc");
  });

  it("长文本渲染 cv 块，--cv-lines 记录块内行数", () => {
    const lines = Array.from({ length: CHUNK_LINES * 2 + 5 }, (_, index) => `line ${index}`);
    const { container } = render(<ChunkedText text={lines.join("\n")} />);
    const chunks = container.querySelectorAll<HTMLElement>(".cv-chunk");
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.style.getPropertyValue("--cv-lines")).toBe(String(CHUNK_LINES));
    expect(chunks[2]!.style.getPropertyValue("--cv-lines")).toBe("5");
    expect([...chunks].map((chunk) => chunk.textContent).join("\n")).toBe(lines.join("\n"));
  });
});
