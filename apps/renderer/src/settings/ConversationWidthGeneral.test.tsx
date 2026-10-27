import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { BackgroundProvider } from "../background/BackgroundProvider";
import { PreviewModeProvider, usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { PREVIEW_APP_SETTINGS } from "../preview/settingsPreview";
import { SettingsPage } from "../SettingsPage";
import { selectOption } from "../test/selectOption";
import { __resetAppSettingsForTests, getAppSettings, updateAppSettings } from "./appSettings";
import { ConversationWidthProvider } from "./ConversationWidthContext";
import { ConversationWidthMenu } from "./ConversationWidthSettings";

function TestSettingsPage() {
  const { preview } = usePreviewMode();
  return <BackgroundProvider preview={preview} theme="light"><SettingsPage onSetApprovalMode={() => {}} /></BackgroundProvider>;
}

function SharedSettings() {
  const { preview, setPreview } = usePreviewMode();
  const [visible, setVisible] = useState(true);
  return <>
    <button type="button" onClick={() => setPreview(!preview)}>Toggle preview</button>
    <button type="button" onClick={() => setVisible(value => !value)}>Toggle Settings</button>
    {visible ? <TestSettingsPage /> : null}
    <div role="menu"><ConversationWidthMenu /></div>
  </>;
}

beforeEach(() => {
  __resetAppSettingsForTests(null);
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  sessionStorage.removeItem("omp.settingsIntent");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  window.matchMedia = query => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetAppSettingsForTests(null);
  localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
});

describe("General conversation width integration", () => {
  it("supports standalone SettingsPage without a global provider and resets real width preferences", () => {
    updateAppSettings({ theme: "dark", conversationWidthMode: "custom", conversationCustomWidth: 1376 });
    render(<PreviewModeProvider switchEnabled><I18nProvider forcedLanguage="zh"><TestSettingsPage /></I18nProvider></PreviewModeProvider>);
    expect((screen.getByRole("slider", { name: "自定义宽度" }) as HTMLInputElement).value).toBe("1376");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认值" }));
    expect(getAppSettings()).toMatchObject({ theme: "light", conversationWidthMode: "standard", conversationCustomWidth: 1024 });
    expect(screen.getByRole("combobox", { name: "对话宽度" }).textContent).toBe("标准 · 768 px");
    expect(screen.queryByRole("slider", { name: "自定义宽度" })).toBeNull();
  });

  it("keeps standalone preview edits in memory and General reset restores the demo defaults", () => {
    localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
    render(<PreviewModeProvider switchEnabled><I18nProvider forcedLanguage="zh"><TestSettingsPage /></I18nProvider></PreviewModeProvider>);
    const write = vi.spyOn(Storage.prototype, "setItem");
    selectOption(screen.getByRole("combobox", { name: "对话宽度" }), "自定义");
    fireEvent.change(screen.getByRole("slider", { name: "自定义宽度" }), { target: { value: "1312" } });
    fireEvent.pointerUp(screen.getByRole("slider", { name: "自定义宽度" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复默认值" }));
    expect(screen.getByRole("combobox", { name: "对话宽度" }).textContent).toBe("标准 · 768 px");
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem("omp.appSettings")).toBeNull();
    expect(getAppSettings()).toMatchObject({ conversationWidthMode: "standard", conversationCustomWidth: 1024 });
  });

  it("shares the demo draft with a sibling menu across SettingsPage remounts and General resets", () => {
    __resetAppSettingsForTests('{"conversationWidthMode":"full","conversationCustomWidth":1184}');
    localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
    render(<PreviewModeProvider switchEnabled><ConversationWidthProvider><I18nProvider forcedLanguage="zh"><SharedSettings /></I18nProvider></ConversationWidthProvider></PreviewModeProvider>);
    const stored = localStorage.getItem("omp.appSettings");
    const write = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "自定义 · 1024 px" }));
    expect(screen.getByRole("combobox", { name: "对话宽度" }).textContent).toBe("自定义");
    fireEvent.change(screen.getByRole("slider", { name: "自定义宽度" }), { target: { value: "1408" } });
    fireEvent.pointerUp(screen.getByRole("slider", { name: "自定义宽度" }));
    expect(screen.getByRole("menuitemradio", { name: "自定义 · 1408 px" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Toggle Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle Settings" }));
    expect((screen.getByRole("slider", { name: "自定义宽度" }) as HTMLInputElement).value).toBe("1408");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认值" }));
    expect(screen.getByRole("menuitemradio", { name: "标准 · 768 px" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: `自定义 · ${PREVIEW_APP_SETTINGS.conversationCustomWidth} px` })).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem("omp.appSettings")).toBe(stored);
    fireEvent.click(screen.getByRole("button", { name: "Toggle preview" }));
    expect(screen.getByRole("combobox", { name: "对话宽度" }).textContent).toBe("铺满 · 可用宽度");
    expect(screen.getByRole("menuitemradio", { name: "自定义 · 1184 px" })).toBeTruthy();
    act(() => updateAppSettings({ conversationWidthMode: "wide" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复默认值" }));
    expect(screen.getByRole("menuitemradio", { name: "标准 · 768 px" }).getAttribute("aria-checked")).toBe("true");
    expect(getAppSettings().conversationCustomWidth).toBe(1024);
  });
});
