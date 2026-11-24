import { selectOption } from "../test/selectOption";
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
  selectOption(field, "仅标题");
  await waitFor(() =>
    expect(
      within(row as HTMLElement).getByRole("button", { name: "清除临时覆盖" }),
    ).toBeTruthy(),
  );
  fireEvent.click(
    within(row as HTMLElement).getByRole("button", { name: "清除临时覆盖" }),
  );
  await waitFor(() =>
    expect((field as HTMLButtonElement).textContent).toBe("Emoji"),
  );
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});
it("re-generates the current session title when the title language changes", async () => {
  const titleRow = {
    key: "title.language",
    group: "titles",
    label: "Title language",
    description: "Language for generated session titles",
    value: "auto",
    effective: "auto",
    source: "default",
    type: "enum",
    choices: ["auto", "zh", "en"],
    restartRequired: false,
  } as const;
  let sequence = 0;
  const receipts: Record<string, unknown> = {};
  const client = {
    command: vi.fn(async (name: string) => {
      const requestId = `req-${sequence++}`;
      receipts[requestId] = {
        status: "completed",
        result:
          name === "preferences.native.get"
            ? { result: { preferences: [titleRow] } }
            : { result: { ...titleRow, value: "zh", effective: "zh", source: "runtime" } },
      };
      return { requestId };
    }),
    getState: () => ({ commands: receipts }),
    subscribe: vi.fn(() => () => {}),
    query: vi.fn(),
  } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <NativePreferencesPane
          client={client}
          visible
          context={{
            sessionId: "s",
            available: true,
            capabilities: {
              profile: "full-parity-v1",
              generatedAt: "2026-01-01T00:00:00Z",
              hash: "test",
              capabilities: [
                { id: "preferences.native.get", grade: "stable", version: 1, evidence: "test" },
                { id: "preferences.native.set", grade: "stable", version: 1, evidence: "test" },
                { id: "preferences.native.clearOverride", grade: "stable", version: 1, evidence: "test" },
              ],
            },
          }}
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  const field = await screen.findByRole("combobox", { name: "会话标题语言" });
  selectOption(field, "中文");
  await waitFor(() =>
    expect(client.command).toHaveBeenCalledWith("session.retitle", {}),
  );
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
