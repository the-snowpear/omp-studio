import type { ContextType } from "react";
import { ConversationViewContext } from "../conversationWorkspace/Context";
import { registerFileOpener } from "../files/fileLinks";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { selectOption } from "../test/selectOption";
import { TodoBackendSettings } from "./TodoBackendSettings";
import { getPreviewTodoBackends } from "../preview/todoBackendPreview";

const unregister: Array<() => void> = [];
afterEach(() => { cleanup(); localStorage.clear(); unregister.splice(0).forEach(stop => stop()); vi.unstubAllGlobals(); });
it("keeps the selected preview backend through live language changes without Host writes", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn() } as unknown as StudioClient;
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled><TodoBackendSettings client={client} visible /></PreviewModeProvider></I18nProvider>;
  const mounted = render(view("zh"));
  selectOption(await screen.findByLabelText("Todo 后端"), "项目任务同步");
  expect(screen.getByText("已同步")).toBeTruthy();
  mounted.rerender(view("en"));
  expect(screen.getByLabelText("Todo backend").textContent).toContain("Project task tracker");
  expect(screen.getByText("Synced")).toBeTruthy();
  mounted.rerender(view("zh"));
  expect(screen.getByLabelText("Todo 后端").textContent).toContain("项目任务同步");
  expect(client.command).not.toHaveBeenCalled();
});
it("reads registered backends and saves the exact native backend id and scope", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const commands: Record<string, unknown> = {};
  let sequence = 0;
  const command = vi.fn(async (kind: string, input: { backend?: string }) => {
    const requestId = String(++sequence);
    const result = getPreviewTodoBackends(false);
    if (input.backend) { result.selected = input.backend; result.sync = { state: "queued" }; }
    commands[requestId] = { status: "completed", result: { result } };
    return { requestId };
  });
  const client = { command, getState: () => ({ commands }) } as unknown as StudioClient;
  const capabilities = { capabilities: ["todo.backends.get", "todo.backend.set", "todo.backend.sync"].map(id => ({ id, grade: "stable" })) } as ClientBootstrap["capabilityManifest"];
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><TodoBackendSettings client={client} context={{ available: true, sessionId: "owner", capabilities }} visible /></PreviewModeProvider></I18nProvider>);
  await waitFor(() => expect(screen.getByLabelText("Todo backend")).toHaveProperty("disabled", false));
  selectOption(screen.getByLabelText("Todo backend"), "Project task tracker");
  await waitFor(() => expect(command).toHaveBeenCalledWith("todo.backend.set", { sessionId: "owner", backend: "project-tracker", scope: "global" }));
  expect(await screen.findByText("Sync queued")).toBeTruthy();
});


it("opens preview extension source locally and retains the inspector through language changes", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const open = vi.fn(), command = vi.fn(), query = vi.fn();
  unregister.push(registerFileOpener("standalone", open));
  const client = { command, query } as unknown as StudioClient;
  const view = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled><TodoBackendSettings client={client} visible /></PreviewModeProvider></I18nProvider>;
  const mounted = render(view("zh"));
  selectOption(await screen.findByLabelText("Todo 后端"), "项目任务同步");
  fireEvent.click(screen.getByRole("button", { name: "查看扩展源码" }));
  const source = screen.getByRole("textbox", { name: "扩展源码" });
  expect(source).toHaveProperty("readOnly", true);
  const text = (source as HTMLTextAreaElement).value;
  mounted.rerender(view("en"));
  expect(screen.getByRole("dialog", { name: "Backend extension source" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Extension source" })).toHaveProperty("value", text);
  mounted.rerender(view("zh"));
  expect(screen.getByRole("dialog", { name: "后端扩展源码" })).toBeTruthy();
  expect(command).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});

it("routes a remote extension path to its conversation file viewer without invoking the local shell", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  const remotePath = "/home/agent/.omp/extensions/tracker.ts";
  const result = getPreviewTodoBackends(false);
  result.selected = "project-tracker"; result.backends[1]!.extensionPath = remotePath;
  const open = vi.fn(), systemFileOpen = vi.fn(), openFile = vi.fn();
  vi.stubGlobal("ompStudioChrome", { systemFileOpen, openFile });
  unregister.push(registerFileOpener("remote-document", open));
  const client = { command: vi.fn(async () => ({ requestId: "read" })), getState: () => ({ commands: { read: { status: "completed", result: { result } } } }) } as unknown as StudioClient;
  const capabilities = { capabilities: [{ id: "todo.backends.get", grade: "stable" }] } as ClientBootstrap["capabilityManifest"];
  const owner = { document: { id: "remote-document", ref: { workspaceId: "remote-workspace", targetId: "ssh-dev" } } } as NonNullable<ContextType<typeof ConversationViewContext>>;
  render(<ConversationViewContext.Provider value={owner}><I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><TodoBackendSettings client={client} context={{ available: true, sessionId: "remote-session", capabilities }} visible /></PreviewModeProvider></I18nProvider></ConversationViewContext.Provider>);
  fireEvent.click(await screen.findByRole("button", { name: "View extension source" }));
  expect(open).toHaveBeenCalledWith({ path: remotePath, targetId: "ssh-dev", source: "system", onOpened: expect.any(Function) });
  expect(systemFileOpen).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled();
});
