import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { SkillsharePane } from "./SkillsharePane";
afterEach(() => { cleanup(); localStorage.clear(); });
it("demo install requires script review and never performs Host or registry mutations", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1"); const client = { query: vi.fn(), command: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><SkillsharePane client={client} available={false} /></PreviewModeProvider></I18nProvider>);
  fireEvent.change(screen.getByLabelText("安装包（空格分隔，留空恢复 manifest / lock）"), { target: { value: "@studio/service-review" } });
  fireEvent.click(screen.getByRole("button", { name: "检查安装请求" })); await screen.findByLabelText("Skillshare 确认单");
  expect(screen.getByRole("button", { name: "确认执行此请求" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByLabelText("已检查并接受这些包含脚本的文件")); fireEvent.click(screen.getByRole("button", { name: "确认执行此请求" }));
  await screen.findByText("演示操作已完成；没有写入本机或注册表。"); expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
});
it("token creation and revocation are reviewed in preview without exposing fabricated secrets", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1"); const client = { query: vi.fn(), command: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><SkillsharePane client={client} available={false} /></PreviewModeProvider></I18nProvider>);
  fireEvent.click(screen.getByRole("tab", { name: "发布令牌" })); fireEvent.change(screen.getByLabelText("令牌名称"), { target: { value: "preview-token" } });
  fireEvent.click(screen.getByRole("button", { name: "检查新建令牌请求" })); await screen.findByLabelText("Skillshare 确认单");
  fireEvent.click(screen.getByRole("button", { name: "确认执行此请求" })); await screen.findByText("演示操作已完成；没有写入本机或注册表。");
  expect(screen.queryByLabelText("新建令牌明文")).toBeNull(); expect(client.command).not.toHaveBeenCalled();
});
