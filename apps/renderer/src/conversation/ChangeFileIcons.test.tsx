import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { ChangesPanel, type ChangesDiffFile } from "./ChangesPanel";
import { TurnDiffCard } from "./TurnDiffCard";
import { ActivityLine } from "./ActivityLine";
import { deriveActivityStatus } from "./activityStatus";
import { BatchChain, type ChainItem } from "./BatchChain";
import { emptyConversationState, type ToolView } from "./conversationViewModel";
import { ToolBody } from "./ToolBody";

afterEach(cleanup);

/**
 * 改动卡 / 改动侧栏的文件图标必须与 Explorer 同源：形由 iconNameFor() 决定，
 * 色由行上的 data-ftype 派生。这组用例锁的是「形接了、色没接」这一类回归——
 * 上一次落地就漏在这里：图标形状对了，但行上没有 data-ftype，全是同一个灰。
 */

function diffFile(file: string): ChangesDiffFile {
  return { file, add: 1, del: 0, hunks: [{ hunkLabel: "@@ -1 +1 @@", lines: [] }] };
}

function renderPanel(files: readonly string[]) {
  return render(
    <I18nProvider forcedLanguage="zh">
      <ChangesPanel
        turns={[{ id: "t1", label: "第 1 轮", add: files.length, del: 0 }]}
        turnId="t1"
        onTurnChange={() => {}}
        files={files.map(diffFile)}
        expanded={new Set()}
        onToggle={() => {}}
        split={false}
        onSplit={() => {}}
      />
    </I18nProvider>,
  );
}

it("puts the file type on change sidebar rows, not just on the icon", () => {
  const { container } = renderPanel(["src/App.tsx", "src/index.html", "src/base.css", "turbo.json"]);
  const rows = [...container.querySelectorAll(".ch-item")];
  expect(rows.map((row) => row.getAttribute("data-ftype"))).toEqual(["code", "markup", "style", "config"]);
});

it("classifies sidebar rows by basename so nested secret and pinned files still resolve", () => {
  const { container } = renderPanel(["config/.env", "docs/README.md", "notes.md"]);
  const rows = [...container.querySelectorAll(".ch-item")];
  // 传完整路径时 `config/.env` 会一路落空到 null，红色和钥匙形都不会出现。
  expect(rows[0]?.getAttribute("data-ftype")).toBe("secret");
  expect(rows[0]?.hasAttribute("data-secret")).toBe(true);
  expect(rows[1]?.getAttribute("data-ftype")).toBe("doc");
  // 同为 doc，README 走旗舰「书」形，普通 md 走文档形——形与色是两轴。
  expect(rows[1]?.querySelector(".ch-row-icon svg")?.innerHTML).not.toBe(rows[2]?.querySelector(".ch-row-icon svg")?.innerHTML);
});

it("marks turn diff card rows with the same type and sensitive flag as the tree", () => {
  const { container } = render(
    <I18nProvider forcedLanguage="zh">
      <TurnDiffCard
        files={[
          { path: "src/App.tsx", name: "App.tsx", dir: "src/", add: 2, del: 0 },
          { path: "config/.env", name: ".env", dir: "config/", add: 1, del: 1 },
        ]}
        defaultOpen
      />
    </I18nProvider>,
  );
  const rows = [...container.querySelectorAll(".turn-diff-row")];
  expect(rows[0]?.getAttribute("data-ftype")).toBe("code");
  expect(rows[0]?.hasAttribute("data-secret")).toBe(false);
  expect(rows[1]?.getAttribute("data-ftype")).toBe("secret");
  expect(rows[1]?.hasAttribute("data-secret")).toBe(true);
});

it("leaves unknown extensions untyped so the icon falls back instead of guessing", () => {
  const { container } = renderPanel(["assets/blob.unknownext"]);
  const row = container.querySelector(".ch-item");
  expect(row?.hasAttribute("data-ftype")).toBe(false);
  expect(row?.hasAttribute("data-secret")).toBe(false);
});

it("renders inline file-type icons on streaming edit and selector-suffixed read rows while preserving the left spinner", () => {
  const items: ChainItem[] = [
    {
      kind: "tool",
      tool: {
        toolCallId: "edit-env",
        toolName: "edit",
        status: "running",
        arguments: { input: "[config/.env#1A2B]\nPUT 1.=1:\n+KEY=1" },
      },
    },
    {
      kind: "tool",
      tool: {
        toolCallId: "read-pem",
        toolName: "read",
        status: "succeeded",
        arguments: { path: "certs/server.pem" },
      },
    },
    {
      kind: "tool",
      tool: {
        toolCallId: "read-readme",
        toolName: "read",
        status: "succeeded",
        arguments: { path: "docs/README.md:10-30:raw" },
      },
    },
    {
      kind: "tool",
      tool: {
        toolCallId: "read-notes",
        toolName: "read",
        status: "succeeded",
        arguments: { path: "docs/notes.md" },
      },
    },
  ];
  const { container } = render(
    <I18nProvider forcedLanguage="zh">
      <BatchChain items={items} batchKey="icons-chain" liveTail />
    </I18nProvider>,
  );
  const rows = [...container.querySelectorAll(".tl-row")];
  expect(rows[0]?.querySelector(".tl-icon .spinner")).not.toBeNull();
  expect(rows[0]?.getAttribute("data-ftype")).toBe("secret");
  expect(rows[0]?.hasAttribute("data-secret")).toBe(true);
  expect(rows[0]?.querySelector(".tl-detail")?.textContent).toBe("config/.env");
  const envIcon = rows[0]?.querySelector(".tl-file-icon svg")?.innerHTML;
  const pemIcon = rows[1]?.querySelector(".tl-file-icon svg")?.innerHTML;
  expect(envIcon).toBeTruthy();
  expect(envIcon).not.toBe(pemIcon);

  expect(rows[2]?.getAttribute("data-ftype")).toBe("doc");
  expect(rows[3]?.getAttribute("data-ftype")).toBe("doc");
  expect(rows[2]?.querySelector(".tl-file-icon svg")?.innerHTML).not.toBe(
    rows[3]?.querySelector(".tl-file-icon svg")?.innerHTML,
  );
});

it("omits file-type icons on non-file tool headers (prose prompts, globs, and web URLs)", () => {
  const items: ChainItem[] = [
    {
      kind: "tool",
      tool: {
        toolCallId: "gen-img",
        toolName: "GenerateImage",
        status: "succeeded",
        arguments: { target: "graft 演进链示意" },
      },
    },
    {
      kind: "tool",
      tool: {
        toolCallId: "glob-1",
        toolName: "glob",
        status: "succeeded",
        arguments: { path: "src/*.ts" },
      },
    },
    {
      kind: "tool",
      tool: {
        toolCallId: "read-url",
        toolName: "read",
        status: "succeeded",
        arguments: { path: "https://example.com/docs" },
      },
    },
  ];
  const { container } = render(
    <I18nProvider forcedLanguage="zh">
      <BatchChain items={items} batchKey="non-file-chain" />
    </I18nProvider>,
  );
  for (const row of container.querySelectorAll(".tl-row")) {
    expect(row.querySelector(".tl-file-icon")).toBeNull();
    expect(row.hasAttribute("data-ftype")).toBe(false);
  }
});

it("attaches file-type icons to Grep, Glob (including folder items), LSP, and Find body rows", () => {
  const globTool: ToolView = {
    toolCallId: "glob-body",
    toolName: "glob",
    status: "succeeded",
    arguments: { pattern: "src/*" },
    result: {
      type: "toolResult",
      toolCallId: "glob-body",
      isError: false,
      data: { files: ["src/components/", "src/App.tsx", "package.json"] },
    },
  };
  const globView = render(<ToolBody tool={globTool} />);
  const globRows = [...globView.container.querySelectorAll(".tt-file")];
  expect(globRows[0]?.hasAttribute("data-ftype")).toBe(false);
  expect(globRows[0]?.querySelector(".tt-file-icon svg")).not.toBeNull();
  expect(globRows[1]?.getAttribute("data-ftype")).toBe("code");
  expect(globRows[2]?.getAttribute("data-ftype")).toBe("package");
  globView.unmount();

  const grepView = render(
    <ToolBody
      tool={{
        toolCallId: "grep-body",
        toolName: "grep",
        status: "succeeded",
        result: {
          type: "toolResult",
          toolCallId: "grep-body",
          isError: false,
          data: { matches: [{ file: "src/styles.css", line: 10, text: ".btn { color: red; }" }] },
        },
      }}
    />,
  );
  expect(grepView.container.querySelector(".tt-file")?.getAttribute("data-ftype")).toBe("style");
  expect(grepView.container.querySelector(".tt-file .tt-file-icon svg")).not.toBeNull();
  grepView.unmount();

  const lspView = render(
    <ToolBody
      tool={{
        toolCallId: "lsp-body",
        toolName: "lsp",
        status: "succeeded",
        result: {
          type: "toolResult",
          toolCallId: "lsp-body",
          isError: false,
          data: { refs: [{ file: "src/App.tsx", line: 12, text: "export function App() {}" }] },
        },
      }}
    />,
  );
  expect(lspView.container.querySelector(".lsp-row")?.getAttribute("data-ftype")).toBe("code");
  expect(lspView.container.querySelector(".lsp-row .tt-file-icon svg")).not.toBeNull();
  lspView.unmount();

  const findView = render(
    <ToolBody
      tool={{
        toolCallId: "find-body",
        toolName: "find",
        status: "succeeded",
        result: {
          type: "toolResult",
          toolCallId: "find-body",
          isError: false,
          data: { hits: [{ rel: "docs/README.md", contentScore: 0.9, ranges: [{ start: 1, end: 2, snippet: "# Intro" }] }] },
        },
      }}
    />,
  );
  expect(findView.container.querySelector(".tc-find-sum")?.getAttribute("data-ftype")).toBe("doc");
  expect(findView.container.querySelector(".tc-find-sum .tt-file-icon svg")).not.toBeNull();
  findView.unmount();
});

it("projects the file-type icon into the streaming ActivityLine when editing a file", () => {
  const base = emptyConversationState(1);
  const state = {
    ...base,
    liveTools: {
      "call-edit": {
        toolCallId: "call-edit",
        toolName: "edit",
        status: "running" as const,
        messageId: "m1",
        turnId: "t1",
        arguments: { input: "[src/App.tsx#8F68]\nPUT 1.=1:\n+export const x = 1;" },
      },
    },
  };
  const status = deriveActivityStatus({ state, streaming: true, pendingMessages: 0, zh: true });
  expect(status).toMatchObject({ phase: "tool", detail: "App.tsx", filePath: "src/App.tsx" });
  const { container } = render(
    <I18nProvider forcedLanguage="zh">
      <ActivityLine status={status!} startedAt={Date.now() - 3000} />
    </I18nProvider>,
  );
  const detail = container.querySelector(".al-detail");
  expect(detail?.getAttribute("data-ftype")).toBe("code");
  expect(detail?.querySelector(".al-file-icon svg")).not.toBeNull();
  expect(detail?.querySelector(".al-detail-text")?.textContent).toBe("App.tsx");
});
