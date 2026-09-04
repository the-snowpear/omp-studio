import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolBody, TOOL_ROWS_MAX } from "./ToolBody";
import { CHUNK_LINES } from "./textChunks";

describe("ToolBody: WebSearchBody", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders structured citations with links, tooltips, and truncated text structure", () => {
    const web = {
      toolCallId: "web-search-1",
      toolName: "web_search",
      status: "succeeded" as const,
      arguments: { query: "DeepSeek最新动态" },
      output: "[1] 更新日志 https://api-docs.deepseek.com/zh-cn/updates/\n[2] DeepSeek V4 Pro",
      result: {
        type: "toolResult" as const,
        toolCallId: "web-search-1",
        toolName: "web_search",
        isError: false,
        data: {
          provider: "firecrawl",
          response: {
            provider: "firecrawl",
            sources: [
              {
                title: "更新日志",
                url: "https://api-docs.deepseek.com/zh-cn/updates/",
              },
              {
                title: "DeepSeek V4 Pro 突襲上線Agent能力大躍進、性能逼近",
                url: "https://tw.stock.yahoo.com/news/deepseek-v4-pro%E7%AA%81%E5%85%B2%E4%B8%8A%E7%B7%9A-agent%E8%83%BD%E5%8A%9B%E5%A4%A7%E8%BA%8D%E9%80%B2%E3%80%81%E6%80%A7%E8%83%BD%E9%80%BC%E8%BF%91-002714137.html",
              },
              "https://example.com/raw-url",
            ],
          },
        },
      },
    };

    const { container } = render(<ToolBody tool={web} />);
    expect(container.textContent).toContain("provider");
    expect(container.textContent).toContain("firecrawl");
    expect(container.textContent).toContain("sources");
    expect(container.textContent).toContain("3");

    const cites = container.querySelectorAll<HTMLAnchorElement>(".tc-cite");
    expect(cites.length).toBe(3);

    // Item 1: Normal short citation
    expect(cites[0]!.getAttribute("href")).toBe("https://api-docs.deepseek.com/zh-cn/updates/");
    expect(cites[0]!.getAttribute("title")).toBe("更新日志 · https://api-docs.deepseek.com/zh-cn/updates/");
    expect(cites[0]!.querySelector(".tc-cite-title")?.textContent).toBe("更新日志");
    expect(cites[0]!.querySelector(".tc-cite-url")?.textContent).toContain("https://api-docs.deepseek.com/zh-cn/updates/");

    // Item 2: Long title and long encoded URL
    expect(cites[1]!.getAttribute("href")).toContain("tw.stock.yahoo.com");
    expect(cites[1]!.getAttribute("title")).toContain("DeepSeek V4 Pro 突襲上線");
    expect(cites[1]!.getAttribute("title")).toContain("tw.stock.yahoo.com");
    expect(cites[1]!.querySelector(".tc-cite-text")).not.toBeNull();

    // Item 3: String entry (raw URL)
    expect(cites[2]!.getAttribute("href")).toBe("https://example.com/raw-url");
    expect(cites[2]!.getAttribute("title")).toBe("https://example.com/raw-url");
    expect(cites[2]!.querySelector(".tc-cite-title")?.textContent).toBe("https://example.com/raw-url");
  });

  it("handles clicking on citation link via ompStudioChrome.openUrl or window.open", () => {
    const openUrlMock = vi.fn();
    (globalThis as unknown as { ompStudioChrome?: { openUrl: typeof openUrlMock } }).ompStudioChrome = {
      openUrl: openUrlMock,
    };

    const web = {
      toolCallId: "web-search-2",
      toolName: "web_search",
      status: "succeeded" as const,
      arguments: { query: "OMP Studio" },
      result: {
        type: "toolResult" as const,
        toolCallId: "web-search-2",
        toolName: "web_search",
        isError: false,
        data: {
          response: {
            sources: [{ title: "GitHub", url: "github.com/d3" }],
          },
        },
      },
    };

    const { container } = render(<ToolBody tool={web} />);
    const cite = container.querySelector<HTMLAnchorElement>(".tc-cite");
    expect(cite).not.toBeNull();
    
    fireEvent.click(cite!);
    expect(openUrlMock).toHaveBeenCalledWith({ url: "https://github.com/d3" });

    delete (globalThis as unknown as { ompStudioChrome?: unknown }).ompStudioChrome;
  });

  it("renders empty citations gracefully when no sources are available", () => {
    const web = {
      toolCallId: "web-search-3",
      toolName: "web_search",
      status: "succeeded" as const,
      arguments: { query: "nothing" },
      result: {
        type: "toolResult" as const,
        toolCallId: "web-search-3",
        toolName: "web_search",
        isError: false,
        data: {
          answer: "No results found.",
          response: { sources: [] },
        },
      },
    };

    const { container } = render(<ToolBody tool={web} />);
    expect(container.querySelector(".tc-answer")?.textContent).toBe("No results found.");
    expect(container.querySelector(".tc-cites")).toBeNull();
  });
});

/**
 * 按行渲染的工具卡不得随载荷长度无界铺 DOM。虚拟列表只限制挂载**行数**（120），
 * 不限制单行内的节点数，所以一次 Read 两万行的文件曾经在一张 220px 高的卡里
 * 挂出六万个元素。
 */
describe("ToolBody: 按行渲染的 DOM 上限", () => {
  afterEach(cleanup);

  function readTool(lineCount: number) {
    return {
      toolCallId: "read-1",
      toolName: "read",
      status: "succeeded" as const,
      arguments: { path: "big.txt" },
      result: {
        type: "toolResult" as const,
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        data: { preview: Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`) },
      },
    };
  }

  it("Read 预览超过上限时只铺 TOOL_ROWS_MAX 行，并说明省略了多少", () => {
    const { container } = render(<ToolBody tool={readTool(TOOL_ROWS_MAX + 500)} />);
    expect(container.querySelectorAll(".tc-code .cl").length).toBe(TOOL_ROWS_MAX);
    expect(container.querySelector(".tc-code .tc-note")?.textContent).toContain("500");
  });

  it("超过一块的行列表包进 cv 块，块数按 CHUNK_LINES 走", () => {
    const { container } = render(<ToolBody tool={readTool(CHUNK_LINES * 3)} />);
    const chunks = container.querySelectorAll(".tc-code .cv-chunk-rows");
    expect(chunks.length).toBe(3);
    // 占位高度要按块内真实行数声明，否则视口外的块会用错的高度占位。
    expect((chunks[0] as HTMLElement).style.getPropertyValue("--cv-lines")).toBe(String(CHUNK_LINES));
    expect(container.querySelectorAll(".tc-code .cl").length).toBe(CHUNK_LINES * 3);
  });

  it("不超过一块时不加包裹层，常见的小输出不多一层 DOM", () => {
    const { container } = render(<ToolBody tool={readTool(8)} />);
    expect(container.querySelectorAll(".tc-code .cv-chunk-rows").length).toBe(0);
    expect(container.querySelectorAll(".tc-code .cl").length).toBe(8);
    expect(container.querySelector(".tc-code .tc-note")).toBeNull();
  });

  it("行号仍然从 offset 起算", () => {
    const tool = { ...readTool(3), result: { ...readTool(3).result, data: { preview: ["a", "b", "c"], offset: 41 } } };
    const { container } = render(<ToolBody tool={tool} />);
    const numbers = [...container.querySelectorAll(".tc-code .ln")].map((node) => node.textContent);
    expect(numbers).toEqual(["41", "42", "43"]);
  });
});
