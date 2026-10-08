import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { NativePreferencesPane } from "./NativePreferencesPane";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("preview applies and clears a title override without writing Runtime configuration", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = {
    command: vi.fn(),
    query: vi.fn(),
  } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <NativePreferencesPane client={client} visible />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  const field = await screen.findByRole("combobox", { name: "标题图标" });
  const row = field.closest(".set-row")!;
  fireEvent.change(field, { target: { value: JSON.stringify("boring") } });
  fireEvent.click(
    within(row as HTMLElement).getByRole("button", { name: "应用" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() =>
    expect(
      within(row as HTMLElement).getByRole("button", { name: "清除临时覆盖" }),
    ).toBeTruthy(),
  );
  fireEvent.click(
    within(row as HTMLElement).getByRole("button", { name: "清除临时覆盖" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() =>
    expect((field as HTMLSelectElement).value).toBe(JSON.stringify("emoji")),
  );
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});
it("does not probe an old Runtime for unknown preferences", () => {
  const client = {
    command: vi.fn(),
    query: vi.fn(),
  } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <NativePreferencesPane
          client={client}
          visible
          context={{ sessionId: "s", available: true }}
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  expect(screen.getByText("此 Runtime 尚不支持这些运行偏好")).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled();
});
