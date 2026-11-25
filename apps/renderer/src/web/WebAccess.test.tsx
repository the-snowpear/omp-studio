import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import {
  __resetAppSettingsForTests,
  updateAppSettings,
} from "../settings/appSettings";
import { WebAccess } from "./WebAccess";
import { updateControlState } from "./controlState";
import type { WebAccessApi } from "../../../desktop/src/web/shared";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  __resetAppSettingsForTests(null);
  updateControlState(
    { version: "test", owner: { id: "test", name: "Test" } },
    "test",
  );
});

it("keeps device edits and the open panel while the mounted language changes", async () => {
  __resetAppSettingsForTests(JSON.stringify({ language: "zh" }));
  const rename = vi.fn(async () => {});
  const api: WebAccessApi = {
    status: async () => ({
      deviceId: "desktop",
      origin: "http://127.0.0.1:8560",
      addresses: [],
      devices: [{ id: "phone", name: "My phone", createdAt: 1, lastSeenAt: 1 }],
      control: { version: "1", owner: { id: "desktop", name: "Desktop" } },
    }),
    takeControl: async () => ({ version: "2" }),
    pair: async () => ({ url: "", qr: "", expiresAt: 0 }),
    revoke: async () => {},
    rename,
    listen: async () => api.status(),
    exportCertificate: async () => true,
    onControl: () => () => {},
  };
  vi.stubGlobal("ompStudioWebAccess", api);
  render(
    <PreviewModeProvider>
      <I18nProvider>
        <WebAccess />
      </I18nProvider>
    </PreviewModeProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Web 访问" }));
  const input = await screen.findByRole("textbox", { name: "设备名称" });
  fireEvent.change(input, { target: { value: "Renamed phone" } });
  act(() => updateAppSettings({ language: "en" }));
  expect(
    screen.getByRole("dialog", { name: "Connect your devices" }),
  ).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Device name" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("Renamed phone");
  act(() => updateAppSettings({ language: "zh" }));
  expect(screen.getByRole("dialog", { name: "连接你的设备" })).toBeTruthy();
  fireEvent.blur(input);
  expect(rename).toHaveBeenCalledWith("phone", "Renamed phone");
});

it("shows fixture devices without requiring a Host and keeps preview actions local", async () => {
  window.history.replaceState(null, "", "/?preview=1");
  __resetAppSettingsForTests(JSON.stringify({ language: "en" }));
  vi.stubGlobal("ompStudioWebAccess", undefined);
  render(
    <PreviewModeProvider switchEnabled>
      <I18nProvider>
        <WebAccess />
      </I18nProvider>
    </PreviewModeProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Web access" }));
  expect(screen.getByDisplayValue("My laptop")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
  expect(screen.queryByDisplayValue("My laptop")).toBeNull();
});
