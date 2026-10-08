import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { PredictionSettingsPane } from "./PredictionSettingsPane";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("requires selection and confirmation for the optional model and keeps preview imports local", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <PredictionSettingsPane client={client} visible />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "引擎" }), {
    target: { value: "smollm" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.getByRole("dialog", { name: "下载本地预测模型" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认并下载" }));
  await screen.findByText("演示设置已更新，不会下载模型。");
  fireEvent.click(screen.getByRole("button", { name: "选择历史文件…" }));
  await screen.findByText("演示：已识别 158 条提示词，未读取真实历史。");
  expect(client.command).not.toHaveBeenCalled();
});
it("does not query or configure an old Runtime without prediction capabilities", () => {
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <PredictionSettingsPane
          client={client}
          context={{ sessionId: "s", available: true }}
          visible
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  expect(
    (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(client.command).not.toHaveBeenCalled();
});
it("preserves the selected prediction engine when switching settings tabs", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const view = (visible: boolean) => (
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <PredictionSettingsPane visible={visible} />
      </PreviewModeProvider>
    </I18nProvider>
  );
  const mounted = render(view(true));
  fireEvent.change(screen.getByRole("combobox", { name: "引擎" }), {
    target: { value: "smollm" },
  });
  mounted.rerender(view(false));
  mounted.rerender(view(true));
  expect(
    (screen.getByRole("combobox", { name: "引擎" }) as HTMLSelectElement).value,
  ).toBe("smollm");
});
