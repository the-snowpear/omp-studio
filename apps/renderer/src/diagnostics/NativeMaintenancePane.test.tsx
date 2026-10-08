import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { NativeMaintenancePane } from "./NativeMaintenancePane";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
function view(client: StudioClient) {
  return (
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <NativeMaintenancePane client={client} available active sessionId="s" />
      </PreviewModeProvider>
    </I18nProvider>
  );
}
it("previews cleanup, confirms it explicitly, and exports locally without any real writes", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = {
    command: vi.fn(),
    query: vi.fn(),
  } as unknown as StudioClient;
  render(view(client));
  expect(screen.queryByRole("button", { name: "确认清理…" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认清理…" }));
  expect(screen.getByRole("dialog", { name: "确认本地清理" })).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "执行清理" }));
  await screen.findByText("演示清理完成，未修改任何文件。");
  fireEvent.click(screen.getByRole("button", { name: "导出当前会话" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成导出文件" }));
  fireEvent.click(await screen.findByRole("button", { name: "另存副本…" }));
  await screen.findByText("演示产物不会写入本机。");
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});
it("keeps all native writes disabled when maintenance capabilities are absent", () => {
  const client = {
    command: vi.fn(),
    query: vi.fn(),
  } as unknown as StudioClient;
  render(view(client));
  for (const name of ["导出当前会话", "扫描并预览", "检查连接"]) {
    expect(
      (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
    ).toBe(true);
  }
  expect(client.command).not.toHaveBeenCalled();
});
