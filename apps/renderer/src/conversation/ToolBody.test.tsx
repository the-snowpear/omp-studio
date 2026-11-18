import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { preloadSyncHighlight } from "../highlight/toolCodeHighlight";
import { ToolBody, TOOL_ROWS_MAX } from "./ToolBody";
import { CHUNK_LINES } from "./textChunks";

it("shows native Eval restart status and structured fallback attempts", async () => {
  const output = '{"attempts":[{"model":"primary","outcome":"failed"},{"model":"fallback","outcome":"succeeded"}]}';
  const view = render(<ToolBody tool={{ toolCallId: "eval-restart", toolName: "eval", status: "succeeded", result: {
    type: "toolResult", toolCallId: "eval-restart", isError: false, data: { cells: [{ code: "print(await handle.attempts())", output,
      statusEvents: [{ op: "kernel_restart", runtime: "JS", stateLost: true }],
      views: [{ text: output, view: { kind: "json", value: { attempts: [{ model: "primary", outcome: "failed" }, { model: "fallback", outcome: "succeeded" }] } } }],
    }] },
  } }} />);
  expect(view.getByRole("status").textContent).toMatch(/内核已重启|kernel restarted/);
  expect(view.container.querySelector(".tc-json details")).not.toBeNull();
  expect(view.container.textContent).toContain("attempts");
  fireEvent.click(view.getByText("attempts: [2]"));
  fireEvent.click(await view.findByText("1: {2}"));
  await waitFor(() => expect(view.container.textContent).toContain("fallback"));
  view.unmount();
});

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

describe("ToolBody: 代码视图语法高亮", () => {
  beforeAll(async () => {
    await preloadSyncHighlight();
  });
  afterEach(cleanup);

  it("在 Read 源码视图中跨行保留块注释词法状态并保持行号对齐", () => {
    const { container } = render(
      <ToolBody
        tool={{
          toolCallId: "read-ts",
          toolName: "read",
          status: "succeeded",
          arguments: { path: "src/App.tsx:1-5" },
          result: {
            type: "toolResult",
            toolCallId: "read-ts",
            isError: false,
            data: {
              offset: 1,
              preview: ["/* line 1", " * line 2 */", "export const answer = 42;"],
            },
          },
        }}
      />,
    );
    const lines = [...container.querySelectorAll(".tc-code .cl")];
    expect(lines.map((row) => row.querySelector(".ln")?.textContent)).toEqual(["1", "2", "3"]);
    expect(lines[0]?.querySelector(".lx .hljs-comment")?.textContent).toBe("/* line 1");
    expect(lines[1]?.querySelector(".lx .hljs-comment")?.textContent).toBe(" * line 2 */");
    expect(lines[2]?.querySelector(".lx .hljs-keyword")).not.toBeNull();
    expect(lines[2]?.querySelector(".lx .hljs-number")?.textContent).toBe("42");
  });

  it("在 Edit diff 视图中分别高亮删除与新增代码行并保留增删类名", () => {
    const { container } = render(
      <ToolBody
        tool={{
          toolCallId: "edit-ts",
          toolName: "edit",
          status: "succeeded",
          arguments: { path: "src/App.tsx" },
          result: {
            type: "toolResult",
            toolCallId: "edit-ts",
            isError: false,
            data: {
              path: "src/App.tsx",
              diff: [
                ["-", "10", "", "const oldVal = 1;"],
                ["+", "", "10", "const newVal = \"ok\";"],
              ],
            },
          },
        }}
      />,
    );
    const delRow = container.querySelector(".tc-diff .dl.del .lc");
    const addRow = container.querySelector(".tc-diff .dl.add .lc");
    expect(delRow?.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(delRow?.querySelector(".hljs-number")?.textContent).toBe("1");
    expect(addRow?.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(addRow?.querySelector(".hljs-string")?.textContent).toBe("\"ok\"");
  });

  it("在 Bash 命令头与 Eval 代码格中产出语法着色节点", () => {
    const bashView = render(
      <ToolBody
        tool={{
          toolCallId: "bash-hl",
          toolName: "bash",
          status: "succeeded",
          arguments: { command: "npm run check -- --only renderer" },
          output: "ok",
        }}
      />,
    );
    const cmd = bashView.container.querySelector(".c-cmd");
    expect(cmd?.textContent).toBe("$ npm run check -- --only renderer");
    expect(cmd?.querySelector("[class*='hljs-']")).not.toBeNull();
    bashView.unmount();

    const evalView = render(
      <ToolBody
        tool={{
          toolCallId: "eval-hl",
          toolName: "eval",
          status: "succeeded",
          arguments: { lang: "py" },
          result: {
            type: "toolResult",
            toolCallId: "eval-hl",
            isError: false,
            data: {
              cells: [{ code: "def run():\n    return True", status: "ok" }],
            },
          },
        }}
      />,
    );
    expect(evalView.container.querySelector(".ev-cell .tc-code .hljs-keyword")?.textContent).toBe("def");
    expect(evalView.container.querySelector(".ev-cell .tc-code .hljs-literal")?.textContent).toBe("True");
    evalView.unmount();
  });

  it("隔离 Grep 独立命中行的词法状态，未闭合块注释不会串染后续命中，且保留 Write 可执行提示", () => {
    const grepView = render(
      <ToolBody
        tool={{
          toolCallId: "grep-isolated",
          toolName: "grep",
          status: "succeeded",
          result: {
            type: "toolResult",
            toolCallId: "grep-isolated",
            isError: false,
            data: {
              matches: [
                { file: "src/a.ts", line: 10, text: "/* unclosed comment" },
                { file: "src/b.ts", line: 20, text: "export const clean = 7;" },
              ],
            },
          },
        }}
      />,
    );
    const hits = [...grepView.container.querySelectorAll(".tt-hit .m-text")];
    expect(hits).toHaveLength(2);
    expect(hits[1]?.querySelector(".hljs-keyword")?.textContent).toBe("export");
    expect(hits[1]?.querySelector(".hljs-number")?.textContent).toBe("7");
    expect(hits[1]?.querySelector(".hljs-comment")).toBeNull();
    grepView.unmount();

    const writeView = render(
      <ToolBody
        tool={{
          toolCallId: "write-exec",
          toolName: "write",
          status: "succeeded",
          arguments: { path: "scripts/run.sh" },
          result: {
            type: "toolResult",
            toolCallId: "write-exec",
            isError: false,
            data: { executable: true, preview: ["#!/usr/bin/env bash", "echo ok"] },
          },
        }}
      />,
    );
    expect(writeView.container.querySelector(".tc-note")?.textContent).toMatch(/已设为可执行|Marked executable/);
    writeView.unmount();
  });
});
