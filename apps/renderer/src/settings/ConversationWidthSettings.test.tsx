import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { PREVIEW_APP_SETTINGS } from "../preview/settingsPreview";
import { selectOption } from "../test/selectOption";
import { __resetAppSettingsForTests, getAppSettings, updateAppSettings } from "./appSettings";
import { ConversationWidthProvider, useConversationWidth } from "./ConversationWidthContext";
import { ConversationWidthMenu, ConversationWidthSettings } from "./ConversationWidthSettings";

function Controls() {
  const width = useConversationWidth();
  const { preview, setPreview } = usePreviewMode();
  return <>
    <button type="button" onClick={() => setPreview(!preview)}>Toggle preview</button>
    <button type="button" onClick={width.reset}>Reset width</button>
    <output data-testid="width">{width.mode}/{width.customWidth}/{String(width.preview)}</output>
  </>;
}

function Harness({ language = "zh" }: { language?: "zh" | "en" }) {
  return <PreviewModeProvider switchEnabled>
    <ConversationWidthProvider>
      <I18nProvider forcedLanguage={language}>
        <Controls />
        <ConversationWidthSettings />
        <div role="menu"><ConversationWidthMenu /></div>
      </I18nProvider>
    </ConversationWidthProvider>
  </PreviewModeProvider>;
}

beforeEach(() => {
  __resetAppSettingsForTests(null);
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetAppSettingsForTests(null);
  localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY);
});

describe("conversation width preferences", () => {
  it("opens defaults and old saved preferences with the standard column and a retained custom initial value", () => {
    expect(getAppSettings()).toMatchObject({ conversationWidthMode: "standard", conversationCustomWidth: 1024 });
    __resetAppSettingsForTests('{"theme":"dark","density":"compact"}');
    render(<Harness />);
    expect(screen.getByRole("combobox", { name: "对话宽度" }).textContent).toBe("标准 · 768 px");
    expect(screen.getByTestId("width").textContent).toBe("standard/1024/false");
    expect(screen.queryByRole("slider")).toBeNull();
    expect(getAppSettings().theme).toBe("dark");
  });

  it("restores a saved custom width, retains it through every preset and saves the selected mode", () => {
    __resetAppSettingsForTests('{"conversationWidthMode":"custom","conversationCustomWidth":1184}');
    render(<Harness />);
    expect((screen.getByRole("slider", { name: "自定义宽度" }) as HTMLInputElement).value).toBe("1184");
    for (const option of ["标准 · 768 px", "宽屏 · 1024 px", "铺满 · 可用宽度", "自定义 · 1184 px"]) {
      fireEvent.click(screen.getByRole("menuitemradio", { name: option }));
      expect(screen.getByRole("menuitemradio", { name: option }).getAttribute("aria-checked")).toBe("true");
      expect(getAppSettings().conversationCustomWidth).toBe(1184);
    }
    const stored = localStorage.getItem("omp.appSettings");
    act(() => __resetAppSettingsForTests(stored));
    expect(getAppSettings()).toMatchObject({ conversationWidthMode: "custom", conversationCustomWidth: 1184 });
  });

  it("keeps slider changes local and commits once on release, keyboard adjustment or blur", () => {
    render(<Harness />);
    selectOption(screen.getByRole("combobox", { name: "对话宽度" }), "自定义");
    const slider = screen.getByRole("slider", { name: "自定义宽度" }) as HTMLInputElement;
    expect([slider.min, slider.max, slider.step]).toEqual(["640", "1440", "32"]);
    const write = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.change(slider, { target: { value: "1184" } });
    fireEvent.change(slider, { target: { value: "1216" } });
    expect(slider.value).toBe("1216");
    expect(screen.getByTestId("width").textContent).toBe("custom/1024/false");
    expect(write).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(getAppSettings().conversationCustomWidth).toBe(1216);
    expect(write).toHaveBeenCalledTimes(1);
    fireEvent.blur(slider);
    expect(write).toHaveBeenCalledTimes(1);
    fireEvent.change(slider, { target: { value: "1248" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(getAppSettings().conversationCustomWidth).toBe(1248);
    expect(write).toHaveBeenCalledTimes(2);
    fireEvent.change(slider, { target: { value: "1280" } });
    fireEvent.blur(slider);
    expect(getAppSettings().conversationCustomWidth).toBe(1280);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("subscribes to real preference changes and resets only width fields", () => {
    render(<Harness />);
    act(() => updateAppSettings({ theme: "dark", conversationWidthMode: "custom", conversationCustomWidth: 1312 }));
    expect(screen.getByTestId("width").textContent).toBe("custom/1312/false");
    fireEvent.click(screen.getByRole("button", { name: "Reset width" }));
    expect(screen.getByTestId("width").textContent).toBe("standard/1024/false");
    expect(getAppSettings().theme).toBe("dark");
  });

  it("shares preview edits across components without writing real settings and restores truth on exit", () => {
    __resetAppSettingsForTests('{"conversationWidthMode":"wide","conversationCustomWidth":1184}');
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle preview" }));
    const stored = localStorage.getItem("omp.appSettings");
    const write = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "自定义 · 1024 px" }));
    const slider = screen.getByRole("slider", { name: "自定义宽度" });
    fireEvent.change(slider, { target: { value: "1408" } });
    fireEvent.pointerUp(slider);
    expect(screen.getByRole("menuitemradio", { name: "自定义 · 1408 px" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("width").textContent).toBe("custom/1408/true");
    expect(getAppSettings()).toMatchObject({ conversationWidthMode: "wide", conversationCustomWidth: 1184 });
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem("omp.appSettings")).toBe(stored);
    fireEvent.click(screen.getByRole("button", { name: "Toggle preview" }));
    expect(screen.getByTestId("width").textContent).toBe("wide/1184/false");
    fireEvent.click(screen.getByRole("button", { name: "Toggle preview" }));
    expect(screen.getByTestId("width").textContent).toBe("custom/1408/true");
    write.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Reset width" }));
    expect(screen.getByTestId("width").textContent).toBe(`${PREVIEW_APP_SETTINGS.conversationWidthMode}/${PREVIEW_APP_SETTINGS.conversationCustomWidth}/true`);
    expect(write).not.toHaveBeenCalled();
  });

  it("has English labels, checked menu choices, menu close and optional Settings callbacks", () => {
    const onSelect = vi.fn();
    const onOpenSettings = vi.fn();
    render(<PreviewModeProvider switchEnabled><ConversationWidthProvider><I18nProvider forcedLanguage="en">
      <ConversationWidthSettings />
      <div role="menu"><ConversationWidthMenu onSelect={onSelect} onOpenSettings={onOpenSettings} /></div>
    </I18nProvider></ConversationWidthProvider></PreviewModeProvider>);
    expect(screen.getByRole("combobox", { name: "Conversation Width" }).textContent).toBe("Standard · 768 px");
    const standard = screen.getByRole("menuitemradio", { name: "Standard · 768 px" });
    expect(standard.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("group").getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Wide · 1024 px" }));
    expect(getAppSettings().conversationWidthMode).toBe("wide");
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Adjust width in Settings" }));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
