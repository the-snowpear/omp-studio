import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { AccountStatusPane } from "./AccountStatusPane";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("preview sign-out requires confirmation and never removes a native credential", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = {
    command: vi.fn(),
    query: vi.fn(),
  } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <AccountStatusPane client={client} standalone />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
  expect(
    screen.getByText("demo@example.com", { selector: "span" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  fireEvent.click(screen.getByRole("button", { name: "确认退出" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull(),
  );
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});
it("old runtimes are not sent account commands", async () => {
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <AccountStatusPane client={client} sessionId="s" standalone />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled();
});
