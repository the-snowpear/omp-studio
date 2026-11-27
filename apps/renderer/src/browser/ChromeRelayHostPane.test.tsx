import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { ChromeRelayHostStatus } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { getPreviewChromeRelay } from "../preview/chromeRelayPreview";
import { ChromeRelayHostPane } from "./ChromeRelayHostPane";

afterEach(() => { cleanup(); localStorage.clear(); });

it("preview actions stay local and retain selected profile and restart choice through zh → en → zh", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const query = vi.fn(), command = vi.fn();
  const client = { query, command } as unknown as StudioClient;
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled><ChromeRelayHostPane client={client} sessionId="chat" visible onBack={() => {}} /></PreviewModeProvider></I18nProvider>;
  const { rerender } = render(view("zh"));
  fireEvent.click(await screen.findByRole("combobox", { name: "Profile" }));
  fireEvent.click(screen.getByRole("option", { name: "测试账号 · Profile 1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /同时注册到所选/ }));
  rerender(view("en"));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" }).textContent).toContain("QA account"));
  expect(screen.getByRole("checkbox", { name: /Also register/ })).toHaveProperty("checked", true);
  fireEvent.click(screen.getByRole("button", { name: "Uninstall native host" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm uninstall" }));
  await screen.findByRole("button", { name: "Install" });
  rerender(view("zh"));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Profile" }).textContent).toContain("测试账号"));
  expect(screen.getByRole("checkbox", { name: /同时注册到所选/ })).toHaveProperty("checked", true);
  expect(screen.getByRole("button", { name: "安装" })).toBeTruthy();
  expect(query).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled();
});

it("real reads show policy refusals and install sends the selected profile with its explicit restart choice", async () => {
  const status = getPreviewChromeRelay(false, false);
  status.policy.denials = [{ browser: "Google Chrome", policy: "NativeMessagingUserLevelHosts", scope: "machine", source: "HKLM\\policy", value: 0, reason: "Managed policy denies user-level hosts" }];
  status.policy.blocked = true;
  const command = vi.fn(async () => ({ requestId: "install" }));
  const query = vi.fn(async () => status);
  const client = { query, command, getState: () => ({ commands: { install: { status: "completed", result: { result: { status, warnings: [] } } } } }) } as unknown as StudioClient;
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><ChromeRelayHostPane client={client} sessionId="active-chat" visible onBack={() => {}} /></I18nProvider>;
  const { rerender } = render(view("zh"));
  await screen.findByText("Managed policy denies user-level hosts");
  fireEvent.click(screen.getByRole("combobox", { name: "Profile" }));
  fireEvent.click(screen.getByRole("option", { name: "QA account · Profile 1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /同时注册到所选/ }));
  rerender(view("en"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Install" })).toHaveProperty("disabled", false));
  expect(screen.getByRole("combobox", { name: "Profile" }).textContent).toContain("Profile 1");
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("browser.relayHost.install", { sessionId: "active-chat", browser: "Google Chrome", profile: "Profile 1", registerChrome: true }));
  await screen.findByText(/Operation complete/);
  rerender(view("zh"));
  await screen.findByText("被策略阻止");
  expect(screen.getByRole("checkbox", { name: /同时注册到所选/ })).toHaveProperty("checked", true);
  expect(query).toHaveBeenCalledWith("browser.relayHost.status", { sessionId: "active-chat" });
});

it("a late old-language read cannot replace the current policy diagnostics", async () => {
  const waiting: Array<(status: ChromeRelayHostStatus) => void> = [];
  const query = vi.fn(() => new Promise<ChromeRelayHostStatus>(resolve => waiting.push(resolve)));
  const client = { query } as unknown as StudioClient;
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><ChromeRelayHostPane client={client} sessionId="s" visible onBack={() => {}} /></I18nProvider>;
  const { rerender } = render(view("zh"));
  rerender(view("en"));
  await act(async () => waiting[1]!(getPreviewChromeRelay(false)));
  await act(async () => waiting[0]!(getPreviewChromeRelay(true)));
  expect(screen.getByRole("combobox", { name: "Profile" }).textContent).toContain("Personal");
  expect(screen.queryByText("个人")).toBeNull();
});
