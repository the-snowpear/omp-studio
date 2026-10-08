import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { NativeArchivePane } from "./NativeArchivePane";
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
  fireEvent.change(screen.getByRole("combobox", { name: "内容" }), {
    target: { value: "prompts" },
  });
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
