import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeSettingsReadModel } from "@omp-studio/client-contract";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { MemoryCredentialPane } from "./MemoryCredentialPane";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

it("stores a token for the selected SSH target without reading it back", async () => {
  const api = {
    memoryCredentialStatus: vi.fn(async () => ({ ok: true as const, configured: false, syncSupported: true })),
    setMemoryCredential: vi.fn(async () => ({ ok: true as const, configured: true, syncSupported: true })),
    removeMemoryCredential: vi.fn(async () => ({ ok: true as const, configured: false, syncSupported: true })),
  };
  vi.stubGlobal("ompStudioChrome", api);
  const snapshot = { "memory.backend": "hindsight", "hindsight.apiUrl": "https://memory.example" } as RuntimeSettingsReadModel;
  render(<PreviewModeProvider><I18nProvider forcedLanguage="zh"><MemoryCredentialPane targetId="server-a" runtime={{ preview: false, snapshot }} /></I18nProvider></PreviewModeProvider>);
  await waitFor(() => expect(api.memoryCredentialStatus).toHaveBeenCalledWith({ targetId: "server-a", url: "https://memory.example" }));
  fireEvent.change(screen.getByLabelText("Hindsight 令牌"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "保存令牌" }));
  await waitFor(() => expect(api.setMemoryCredential).toHaveBeenCalledWith({ targetId: "server-a", url: "https://memory.example", token: "secret" }));
  expect((screen.getByLabelText("Hindsight 令牌") as HTMLInputElement).value).toBe("");
  expect(screen.getByText("已保存令牌")).toBeTruthy();
});

it("keeps preview credential changes local and hides demo notices when marks are off", () => {
  window.history.replaceState(null, "", "/?preview=1&marks=off");
  const save = vi.fn();
  vi.stubGlobal("ompStudioChrome", { setMemoryCredential: save });
  render(<PreviewModeProvider><I18nProvider forcedLanguage="zh"><MemoryCredentialPane targetId={null} runtime={{ preview: true, previewValues: { "memory.backend": "hindsight" } }} /></I18nProvider></PreviewModeProvider>);
  fireEvent.change(screen.getByLabelText("Hindsight 令牌"), { target: { value: "example" } });
  fireEvent.click(screen.getByRole("button", { name: "保存令牌" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText("已保存令牌")).toBeTruthy();
  expect(screen.queryByText(/演示/)).toBeNull();
});

it("reports service authentication failures without exposing a credential", async () => {
  const command = vi.fn(async () => ({ requestId: "check-1" }));
  const client = { command, getState: () => ({ commands: { "check-1": { status: "completed", result: { values: {}, hindsightStatus: "authentication-failed" } } } }) } as unknown as StudioClient;
  const snapshot = { "memory.backend": "hindsight", "hindsight.apiUrl": "https://memory.example" } as RuntimeSettingsReadModel;
  render(<PreviewModeProvider><I18nProvider forcedLanguage="zh"><MemoryCredentialPane targetId={null} runtime={{ preview: false, snapshot }} client={client} /></I18nProvider></PreviewModeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "检查服务" }));
  expect(await screen.findByText("服务拒绝认证，请检查令牌。")).toBeTruthy();
  expect(command).toHaveBeenCalledWith("runtime.settings.get", { keys: ["hindsight.apiUrl"], checkHindsight: true });
});
