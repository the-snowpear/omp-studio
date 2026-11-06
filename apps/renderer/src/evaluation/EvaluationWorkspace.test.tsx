import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { EvaluationPage } from "./EvaluationPage";
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
it("four evaluation surfaces remain local in preview, including rerun review and Ratchet approval", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <EvaluationPage client={client} available={false} />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  await screen.findByText("模型性能对比");
  fireEvent.click(screen.getByRole("button", { name: "按此配置复跑" }));
  fireEvent.click(screen.getByRole("button", { name: "检查并准备开始" }));
  const dialog = await screen.findByRole("dialog", { name: "确认评测配置" });
  expect(dialog.textContent).toContain("24");
  fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));
  await screen.findByRole("button", { name: "按此配置复跑" });
  fireEvent.click(screen.getByRole("tab", { name: "指令遵循" }));
  await screen.findByText("连续指令测试");
  fireEvent.click(screen.getByRole("tab", { name: "模型评判" }));
  await screen.findByText("支持工单分类");
  fireEvent.click(screen.getByRole("tab", { name: "Ratchet" }));
  await screen.findByText("支持工单路由优化");
  fireEvent.click(screen.getAllByRole("button", { name: "审查" })[2]!);
  await screen.findByRole("button", { name: "启动／继续迭代" });
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});
