import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { ServicesPane } from "./ServicesPane";

const initialChrome = window.ompStudioChrome;
afterEach(() => { cleanup(); window.localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY); window.ompStudioChrome = initialChrome; });
function mount(preview: boolean) {
  window.localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, preview ? "1" : "0");
  const client = { command: vi.fn(), subscribe: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ServicesPane client={client} workspaceId="workspace" sessionId="session" available={false} capabilities={{ capabilities: [] } as unknown as ClientBootstrap["capabilityManifest"]} /></PreviewModeProvider></I18nProvider>);
  const details = screen.getByText("服务").closest("details")!;
  details.open = true; fireEvent(details, new Event("toggle"));
  return client;
}
it("preview creates and controls demo services without calling Host or desktop storage", async () => {
  const save = vi.fn();
  window.ompStudioChrome = { saveServiceDefinition: save } as unknown as NonNullable<typeof window.ompStudioChrome>;
  const client = mount(true);
  await screen.findAllByText("web-dev");
  fireEvent.click(screen.getByRole("button", { name: "新建服务" }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "demo-task" } });
  fireEvent.change(screen.getByLabelText("命令"), { target: { value: "npm run dev" } });
  expect((screen.getByLabelText("生命周期") as HTMLSelectElement).value).toBe("session");
  fireEvent.click(screen.getByRole("button", { name: "仅保存配置" }));
  await screen.findByText("demo-task");
  expect(client.command).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});
it("saving a real configuration never starts a process and defaults to session lifetime", async () => {
  const saved = vi.fn(async () => ({ ok: true, definitions: [] }));
  window.ompStudioChrome = { listServiceDefinitions: vi.fn(async () => ({ ok: true, definitions: [] })), saveServiceDefinition: saved } as unknown as NonNullable<typeof window.ompStudioChrome>;
  const client = mount(false);
  fireEvent.click(await screen.findByRole("button", { name: "新建服务" }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "server" } });
  fireEvent.change(screen.getByLabelText("命令"), { target: { value: "npm start" } });
  fireEvent.click(screen.getByRole("button", { name: "仅保存配置" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(saved.mock.calls[0]).toEqual([{ workspaceId: "workspace", spec: { name: "server", command: "npm start", cwd: ".", pty: true, mode: "session", restart: "no", env: undefined } }]);
  expect(client.command).not.toHaveBeenCalled();
  expect((screen.queryByRole("button", { name: "启动服务" }) as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
});
