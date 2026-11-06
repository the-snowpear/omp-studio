import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientEvent, StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { EvaluationPage } from "./EvaluationPage";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it("coalesces slow workspace and history reads and resumes them when the window returns", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const listeners = new Set<(event: ClientEvent) => void>();
  let release!: (value: { records: []; total: number }) => void;
  const pending = new Promise<{ records: []; total: number }>(resolve => { release = resolve; });
  const query = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ records: [], total: 0 });
  const client = {
    query,
    subscribe: (_scope: unknown, listener: (event: ClientEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as StudioClient;
  const changed = () => { for (const listener of listeners) listener({ kind: "evaluations.changed" } as ClientEvent); };
  const mounted = render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled>
    <EvaluationPage client={client} available />
  </PreviewModeProvider></I18nProvider>);
  for (let i = 0; i < 25; i++) await act(async () => changed());
  expect(query).toHaveBeenCalledTimes(1);
  await act(async () => { release({ records: [], total: 0 }); await vi.advanceTimersByTimeAsync(0); });
  expect(query).toHaveBeenCalledTimes(2);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^History/ })); });
  expect(query).toHaveBeenCalledTimes(3);
  await act(async () => {
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    changed();
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(query).toHaveBeenCalledTimes(3);
  await act(async () => {
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(query).toHaveBeenCalledTimes(5);
  await act(async () => { changed(); });
  expect(query).toHaveBeenCalledTimes(7);
  mounted.unmount();
  expect(listeners.size).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(query).toHaveBeenCalledTimes(7);
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
