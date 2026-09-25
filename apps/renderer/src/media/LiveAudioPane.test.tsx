import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { LiveAudioPane } from "./LiveAudioPane";
afterEach(() => { cleanup(); localStorage.clear(); });
it("demo Live reviews before activation and mute/stop never use the microphone or Host", () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><LiveAudioPane client={client} available={false} /></PreviewModeProvider></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "准备开始 Live" }));
  expect(screen.getByLabelText("确认 Live 调用")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认打开麦克风并连接" }));
  fireEvent.click(screen.getByRole("button", { name: "静音" })); expect(screen.getByRole("button", { name: "取消静音" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "停止 Live" })); expect(screen.getByText("off")).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
});
it("shared Web does not claim microphone capability from Runtime availability", () => {
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled={false}><LiveAudioPane client={client} available sessionId="s" /></PreviewModeProvider></I18nProvider>);
  expect(screen.getByRole("button", { name: "准备开始 Live" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/Web 客户端暂不可用/)).toBeTruthy(); expect(client.command).not.toHaveBeenCalled();
});
