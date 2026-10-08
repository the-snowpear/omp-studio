import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { SessionModelRecovery } from "./SessionModelRecovery";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("requires an explicit replacement and confirmation; preview never changes the real session", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <SessionModelRecovery
          client={client}
          available={false}
          demo
          onOpenModels={() => {}}
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  expect(
    (
      (await screen.findByRole("button", {
        name: "使用所选模型恢复",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "替代模型" }), {
    target: { value: "demo/current-model" },
  });
  fireEvent.click(screen.getByRole("button", { name: "使用所选模型恢复" }));
  expect(client.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认并恢复" }));
  await screen.findByRole("status");
  expect(client.command).not.toHaveBeenCalled();
});
it("does not send restore inspection commands to older runtimes", () => {
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <SessionModelRecovery
          client={client}
          currentSessionId="active"
          targetSessionId="saved"
          available
          onOpenModels={() => {}}
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  expect(screen.queryByRole("region")).toBeNull();
  expect(client.command).not.toHaveBeenCalled();
});
