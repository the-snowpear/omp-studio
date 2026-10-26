import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { DEFAULT_APP_SETTINGS } from "../settings/appSettings";
import type { SettingsCtl } from "../settings/tabs";
import { selectOption } from "../test/selectOption";
import { BackgroundProvider } from "./BackgroundProvider";
import { BackgroundSettingsPane } from "../settings/BackgroundSettingsPane";
import {
  BACKGROUND_STORAGE_KEY,
  DEFAULT_BACKGROUND_SETTINGS,
  __resetBackgroundSettingsForTests,
} from "./backgroundSettings";
import { createMemoryBackgroundLibrary } from "./backgroundLibrary";

const ctl: SettingsCtl = {
  preview: false,
  app: DEFAULT_APP_SETTINGS,
  updateApp: vi.fn(),
  resetApp: vi.fn(),
  approvalMode: undefined,
  setApprovalMode: vi.fn(),
};

function stored(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(BACKGROUND_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
}

function renderPane() {
  return render(
    <I18nProvider forcedLanguage="zh">
      <BackgroundProvider
        preview={false}
        theme="light"
        initialSettings={{ ...DEFAULT_BACKGROUND_SETTINGS }}
        library={createMemoryBackgroundLibrary()}
      >
        <BackgroundSettingsPane ctl={ctl} visible />
      </BackgroundProvider>
    </I18nProvider>,
  );
}

beforeAll(() => {
  window.matchMedia = (query: string) =>
    ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList;
});

afterEach(() => {
  cleanup();
  __resetBackgroundSettingsForTests(null);
});

describe("BackgroundSettingsPane", () => {
  it("does not persist while dragging and writes once on release", () => {
    renderPane();
    const slider = screen.getByRole("slider", { name: "背景不透明度" });
    fireEvent.change(slider, { target: { value: "80" } });
    expect(window.localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBeNull();
    fireEvent.pointerUp(slider);
    expect(stored().opacity).toBe(80);
  });

  it("switches scope and presets immediately", () => {
    renderPane();
    selectOption(screen.getByRole("combobox", { name: "作用范围" }), "仅工作台");
    expect(stored().scope).toBe("workbench");
    selectOption(screen.getByRole("combobox", { name: "作用范围" }), "整个应用");
    expect(stored().scope).toBe("app");

    fireEvent.click(screen.getByRole("button", { name: "极光" }));
    expect(stored().enabled).toBe(true);
    expect(stored().activeId).toBe("preset:aurora");
  });

  it("resets display parameters but keeps the active asset", () => {
    renderPane();
    const slider = screen.getByRole("slider", { name: "界面透出强度" });
    fireEvent.change(slider, { target: { value: "75" } });
    fireEvent.pointerUp(slider);
    expect(stored().strength).toBe(75);

    fireEvent.click(screen.getByRole("button", { name: "恢复默认值" }));
    expect(stored().strength).toBe(DEFAULT_BACKGROUND_SETTINGS.strength);
    expect(stored().activeId).toBe(DEFAULT_BACKGROUND_SETTINGS.activeId);
  });
});
