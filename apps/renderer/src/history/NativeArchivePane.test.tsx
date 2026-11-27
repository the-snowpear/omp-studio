import { ArchiveActivityPane } from "./ArchiveExplorer";
import { selectOption } from "../test/selectOption";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { NativeArchivePane } from "./NativeArchivePane";
import { previewArchiveDetail, previewArchiveSessions, previewArchiveTranscript } from "../preview/archivePreview";
import type { ClientBootstrap } from "@omp-studio/client-contract";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("preserves the preview search across hiding the pane without reading or opening real history", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = {
      command: vi.fn(),
      query: vi.fn(),
    } as unknown as StudioClient,
    open = vi.fn();
  const view = (active: boolean) => (
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <NativeArchivePane
          client={client}
          active={active}
          canOpen={() => true}
          onOpen={open}
        />
      </PreviewModeProvider>
    </I18nProvider>
  );
  const mounted = render(view(true));
  fireEvent.click(await screen.findByRole("button", { name: /完善消息队列/ }));
  fireEvent.click(await screen.findByRole("button", { name: "演示会话" }));
  expect(open).not.toHaveBeenCalled();
  selectOption(screen.getByRole("combobox", { name: "内容" }), "提示词");
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索提示词" }), {
    target: { value: "图片" },
  });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await screen.findByText("请检查消息队列恢复后是否保留图片。");
  expect(screen.queryByText("检查浏览器人工接管和租约释放。")).toBeNull();
  mounted.rerender(view(false));
  mounted.rerender(view(true));
  expect(
    (screen.getByRole("searchbox", { name: "搜索提示词" }) as HTMLInputElement)
      .value,
  ).toBe("图片");
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});
it("does not query unsupported or disconnected runtimes", () => {
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="en">
      <PreviewModeProvider switchEnabled>
        <NativeArchivePane
          client={client}
          context={{ sessionId: "s", available: true }}
          active
          canOpen={() => false}
          onOpen={() => {}}
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  expect(
    (screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(client.command).not.toHaveBeenCalled();
});

it("keeps transcript controls through parent detail reloads on zh → en → zh and refresh", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const commands: Record<string, unknown> = {};
  let sequence = 0, language: "zh" | "en" = "zh";
  const query = vi.fn(async () => previewArchiveTranscript("sess-7c2e91", language === "zh"));
  const client = { query, command: vi.fn(async (kind: string) => {
    const requestId = String(++sequence);
    const result = kind === "archive.sessions.list" ? { rows: previewArchiveSessions(language === "zh"), truncated: false } : previewArchiveDetail("sess-7c2e91", language === "zh");
    commands[requestId] = { status: "completed", result: { result } };
    return { requestId };
  }), getState: () => ({ commands }) } as unknown as StudioClient;
  const capabilities = { capabilities: ["archive.sessions.list", "archive.session.inspect", "archive.transcript.read"].map(id => ({ id, grade: "stable" })) } as ClientBootstrap["capabilityManifest"];
  const content = () => <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled><NativeArchivePane client={client} context={{ sessionId: "owner", available: true, capabilities }} active canOpen={() => false} onOpen={() => {}} /></PreviewModeProvider></I18nProvider>;
  const mounted = render(content());
  fireEvent.click(await screen.findByRole("button", { name: /完善消息队列/ }));
  selectOption(await screen.findByRole("combobox", { name: "详细程度" }), "完整");
  selectOption(screen.getByRole("combobox", { name: "字符预算" }), "64,000");
  selectOption(screen.getByRole("combobox", { name: "回合" }), "最后 5 轮");
  language = "en"; mounted.rerender(content());
  expect((await screen.findByRole("combobox", { name: "Detail" })).textContent).toContain("Full");
  expect(screen.getByRole("combobox", { name: "Character budget" }).textContent).toContain("64,000");
  expect(screen.getByRole("combobox", { name: "Turns" }).textContent).toContain("Last 5 turns");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Detail" }).textContent).toContain("Full"));
  language = "zh"; mounted.rerender(content());
  expect((await screen.findByRole("combobox", { name: "详细程度" })).textContent).toContain("完整");
  await waitFor(() => expect(query).toHaveBeenLastCalledWith("archive.transcript.read", { sessionId: "owner", targetSessionId: "sess-7c2e91", detail: "full", budget: 64000, turns: [-5, -1] }));
});


it("switching away from a pending statistics read leaves transcript search usable", async () => {
  let resolveStats!: (value: unknown) => void;
  const stats = new Promise(resolve => { resolveStats = resolve; });
  const query = vi.fn((kind: string) => kind === "archive.stats.read" ? stats : Promise.resolve({ rows: [], truncated: false }));
  const client = { query } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><ArchiveActivityPane client={client} sessionId="s" scope="workspace" active available /></PreviewModeProvider></I18nProvider>);
  expect(screen.getByRole("status").textContent).toContain("Loading");
  selectOption(screen.getByRole("combobox", { name: "View" }), "Transcript regex search");
  expect((screen.getByRole("button", { name: "Search" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "Regular expression" }), { target: { value: "failure" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await act(async () => { resolveStats({ rows: [{ key: "late", calls: 2, errors: 0 }], truncated: false }); });
  expect(query).toHaveBeenCalledWith("archive.messages.grep", { sessionId: "s", scope: "workspace", subagents: true, pattern: "failure" });
  expect(screen.queryByText("late")).toBeNull();
});
