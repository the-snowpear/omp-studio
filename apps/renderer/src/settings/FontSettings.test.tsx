import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PREVIEW_APP_SETTINGS } from "../preview/settingsPreview";
import { selectOption } from "../test/selectOption";
import { __resetAppSettingsForTests, getAppSettings, useAppSettings } from "./appSettings";
import { FontSettings } from "./FontSettings";
import { applyTypography } from "./typography";

function Harness({ preview = false }: { preview?: boolean }) {
  const real = useAppSettings();
  const [demo, setDemo] = useState(PREVIEW_APP_SETTINGS);
  useLayoutEffect(() => { applyTypography(real.settings); }, [real.settings]);
  return <I18nProvider forcedLanguage="zh"><FontSettings ctl={{
    preview, app: preview ? demo : real.settings,
    updateApp: preview ? patch => setDemo(app => ({ ...app, ...patch })) : real.update,
    resetApp: real.reset, approvalMode: undefined, setApprovalMode: () => {},
  }} /></I18nProvider>;
}

beforeEach(() => {
  __resetAppSettingsForTests(null);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); __resetAppSettingsForTests(null); });

describe("font preferences", () => {
  it("saves a custom Chinese font and independent sizes, restores them, and resets one group", () => {
    render(<Harness />);
    selectOption(screen.getByRole("combobox", { name: "界面 · 字体" }), "自定义名称…");
    const custom = screen.getByRole("textbox", { name: "界面 · 自定义字体名称" });
    fireEvent.change(custom, { target: { value: "微软雅黑" } });
    expect(getAppSettings().uiFontFamily).toBe("");
    fireEvent.keyDown(custom, { key: "Enter" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "界面 · 字号 (px)" }), { target: { value: "18" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "终端 · 字号 (px)" }), { target: { value: "24" } });
    expect(getAppSettings()).toMatchObject({ uiFontFamily: "微软雅黑", uiFontSize: 18, terminalFontSize: 24, outputFontSize: 14 });
    const stored = localStorage.getItem("omp.appSettings");
    act(() => __resetAppSettingsForTests(stored));
    expect(getAppSettings().uiFontFamily).toBe("微软雅黑");
    expect(document.documentElement.style.getPropertyValue("--terminal-font-size")).toBe("24px");
    expect(document.documentElement.style.getPropertyValue("--font-output")).toBe("var(--font-ui-default)");
    fireEvent.click(screen.getByRole("button", { name: "恢复终端字体默认值" }));
    expect(getAppSettings()).toMatchObject({ uiFontSize: 18, terminalFontSize: 12, outputFontSize: 14 });
  });

  it("loads real families only on request, supports search and retains a missing family", async () => {
    const query = vi.fn().mockResolvedValue([{ family: "微软雅黑" }, { family: "Consolas" }, { family: "Consolas" }, ...Array.from({ length: 12 }, (_, i) => ({ family: `Font ${i}` }))]);
    vi.stubGlobal("queryLocalFonts", query);
    render(<Harness />);
    expect(query).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /系统字体/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新系统字体" })).toBeTruthy());
    fireEvent.click(screen.getByRole("combobox", { name: "输出 · 字体" }));
    fireEvent.change(screen.getByRole("searchbox", { name: /搜索|Search/ }), { target: { value: "微软雅黑" } });
    fireEvent.click(screen.getByRole("option", { name: "微软雅黑" }));
    expect(getAppSettings().outputFontFamily).toBe("微软雅黑");
    selectOption(screen.getByRole("combobox", { name: "输出 · 字体" }), "自定义名称…");
    const custom = screen.getByRole("textbox", { name: "输出 · 自定义字体名称" });
    fireEvent.change(custom, { target: { value: 'Missing "Font"' } });
    fireEvent.blur(custom);
    expect(getAppSettings().outputFontFamily).toBe('Missing "Font"');
    expect(document.documentElement.style.getPropertyValue("--font-output-code")).toContain('Missing \\"Font\\"');
  });

  it("keeps manual entry available when enumeration fails or is unsupported", async () => {
    vi.stubGlobal("queryLocalFonts", vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")));
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /系统字体/ }));
    await screen.findByText("未能读取系统字体。可重试或手填字体名称。");
    selectOption(screen.getByRole("combobox", { name: "终端 · 字体" }), "自定义名称…");
    const input = screen.getByRole("textbox", { name: "终端 · 自定义字体名称" });
    fireEvent.change(input, { target: { value: "Consolas" } });
    fireEvent.blur(input);
    expect(getAppSettings().terminalFontFamily).toBe("Consolas");
    view.unmount();
    vi.stubGlobal("queryLocalFonts", undefined);
    render(<Harness />);
    expect(screen.getByText("当前浏览器无法读取系统字体，请手填字体名称。")).toBeTruthy();
  });

  it("keeps preview edits and font enumeration separate from the real preferences", () => {
    const query = vi.fn();
    vi.stubGlobal("queryLocalFonts", query);
    render(<Harness preview />);
    fireEvent.click(screen.getByRole("button", { name: "刷新系统字体" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "终端 · 字号 (px)" }), { target: { value: "30" } });
    selectOption(screen.getByRole("combobox", { name: "输出 · 字体" }), "Consolas");
    expect(query).not.toHaveBeenCalled();
    expect(getAppSettings()).toMatchObject({ terminalFontSize: 12, outputFontFamily: "" });
    expect(localStorage.getItem("omp.appSettings")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--terminal-font-size")).toBe("12px");
    expect((screen.getByLabelText("终端字体示例").closest(".font-groups") as HTMLElement).style.getPropertyValue("--terminal-font-size")).toBe("30px");
  });

  it("opens old saved settings with the existing fonts and sizes", () => {
    __resetAppSettingsForTests('{"theme":"dark","density":"compact"}');
    expect(getAppSettings()).toMatchObject({ theme: "dark", density: "compact", uiFontSize: 14, terminalFontSize: 12, outputFontSize: 14, uiFontFamily: "", outputFontFamily: "" });
  });
});
