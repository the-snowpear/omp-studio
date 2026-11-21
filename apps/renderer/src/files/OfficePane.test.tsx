import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OfficeComponentState } from "../../../desktop/src/file-viewer-shared";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { OfficePane } from "./OfficePane";
import { OfficeComponentSettings } from "./FileViewerSettings";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPane() {
  const onSettings = vi.fn(), onPage = vi.fn();
  render(<I18nProvider forcedLanguage="zh"><OfficePane resource={null} preview={false} onSettings={onSettings} onPage={onPage} /></I18nProvider>);
  return { onSettings, onPage };
}

it("shows a retry when reading the installed Office component state fails", async () => {
  const officeState = vi.fn().mockRejectedValueOnce(new Error("Bridge unavailable")).mockResolvedValue({ id: "office-preview", status: "not-installed" });
  const api = {
    officeState,
    onOfficeState: () => () => {},
    officePreview: vi.fn(),
  } as unknown as NonNullable<typeof globalThis.ompStudioChrome>["files"];
  vi.stubGlobal("ompStudioChrome", { files: api });
  renderPane();

  expect(await screen.findByText("无法读取 Office 组件状态")).toBeTruthy();
  expect(screen.getByText("Bridge unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(officeState).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("安装 Office 文档预览组件")).toBeTruthy();
});

it("explains when Office preview is unsupported on the current platform", async () => {
  const unsupported: OfficeComponentState = { id: "office-preview", status: "unsupported", message: "not available" };
  vi.stubGlobal("ompStudioChrome", { files: {
    officeState: vi.fn().mockResolvedValue(unsupported),
    onOfficeState: () => () => {},
    officePreview: vi.fn(),
  } });
  renderPane();

  expect(await screen.findByText("当前平台暂不支持 Office 预览")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "前往安装" })).toBeNull();
});

it("directs web sessions to the desktop app", async () => {
  vi.stubGlobal("ompStudioChrome", {});
  renderPane();

  expect(await screen.findByText("Office 预览仅在桌面端提供")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "前往安装" })).toBeNull();
});

it("disables Office installation controls on unsupported desktop platforms", async () => {
  vi.stubGlobal("ompStudioChrome", { files: {
    officeState: vi.fn().mockResolvedValue({ id: "office-preview", status: "unsupported", message: "not available" }),
    onOfficeState: () => () => {},
  } });
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><OfficeComponentSettings /></PreviewModeProvider></I18nProvider>);

  expect(await screen.findByText("Office 文档预览目前支持 Windows x64、Windows ARM64 和 macOS Apple Silicon。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "安装组件" })).toBeNull();
  expect(screen.queryByRole("button", { name: "检查组件版本" })).toBeNull();
});
