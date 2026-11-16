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
  fireEvent.click((await screen.findAllByRole("button", { name: "退出登录" }))[0]!);
  expect(
    screen.getByText("mira@studio.dev", { selector: "span" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "退出登录" })[0]!);
  fireEvent.click(screen.getByRole("button", { name: "确认退出" }));
  await waitFor(() =>
    expect(screen.queryByText("mira@studio.dev", { selector: ".account-status-toolbar > span" })).toBeNull(),
  );
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});
it("USD key/user budgets do not become token quotas and unknown budget amounts are not displayed as zero", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><AccountStatusPane client={client} standalone /></PreviewModeProvider></I18nProvider>);
  const table = await screen.findByRole("table");
  const userRow = within(table).getByRole("rowheader", { name: "User budget" }).closest("tr")!;
  expect(within(userRow).getAllByText("Unknown")).toHaveLength(2);
  expect(within(userRow).queryByText(/\$0(?:\.00)?/)).toBeNull();
  expect(within(table).getByText(/25\.00/)).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled();
});

it("automatic reset consent is confirmed for exactly one native window and preview never writes it to Runtime", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn(), query: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><AccountStatusPane client={client} standalone /></PreviewModeProvider></I18nProvider>);
  const picker = await screen.findByRole("combobox", { name: "anthropic 5 小时 重置策略" });
  fireEvent.click(picker);
  fireEvent.click(await screen.findByRole("option", { name: "允许自动使用" }));
  const confirm = screen.getByRole("dialog", { name: "确认自动使用重置券" });
  expect(confirm.textContent).toContain("claudeResets.autoRedeem5h");
  fireEvent.click(within(confirm).getByRole("button", { name: "允许此窗口" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(picker.textContent).toContain("允许自动使用");
  expect(screen.getByRole("combobox", { name: "anthropic Fable 重置策略" }).textContent).toContain("使用前询问");
  expect(client.command).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
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
