import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolBody } from "./ToolBody";

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
    expect(cites[0].getAttribute("href")).toBe("https://api-docs.deepseek.com/zh-cn/updates/");
    expect(cites[0].getAttribute("title")).toBe("更新日志 · https://api-docs.deepseek.com/zh-cn/updates/");
    expect(cites[0].querySelector(".tc-cite-title")?.textContent).toBe("更新日志");
    expect(cites[0].querySelector(".tc-cite-url")?.textContent).toContain("https://api-docs.deepseek.com/zh-cn/updates/");

    // Item 2: Long title and long encoded URL
    expect(cites[1].getAttribute("href")).toContain("tw.stock.yahoo.com");
    expect(cites[1].getAttribute("title")).toContain("DeepSeek V4 Pro 突襲上線");
    expect(cites[1].getAttribute("title")).toContain("tw.stock.yahoo.com");
    expect(cites[1].querySelector(".tc-cite-text")).not.toBeNull();

    // Item 3: String entry (raw URL)
    expect(cites[2].getAttribute("href")).toBe("https://example.com/raw-url");
    expect(cites[2].getAttribute("title")).toBe("https://example.com/raw-url");
    expect(cites[2].querySelector(".tc-cite-title")?.textContent).toBe("https://example.com/raw-url");
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
