import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { ModelSystemTemplateFile, ModelSystemTemplateInspection, ModelSystemTemplatesList } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { ModelSystemTemplateInspector, ModelSystemTemplates } from "./ModelSystemTemplates";

const originalUrl = window.location.href;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState(null, "", originalUrl); });
const capabilities = { capabilities: ["models.systemTemplates.list", "models.systemTemplates.inspect", "models.systemTemplates.file.read", "models.systemTemplates.binding.set", "models.systemTemplates.file.write"].map(id => ({ id, grade: "stable" })) } as ClientBootstrap["capabilityManifest"];
const list: ModelSystemTemplatesList = { sessionId: "owner", version: "config-v1", bindings: [{ pattern: "gpt", file: "~/prompts/gpt.md", source: "global", editable: true, effective: true }] };
const inspection: ModelSystemTemplateInspection = { selector: "p/model", selection: { source: "discovered-text", path: "/workspace/SYSTEM.md", matchedTemplate: { pattern: "model", path: "/templates/model.md" } }, preview: "native {{literal}} preview", live: { selection: { source: "discovered-text", path: "/workspace/SYSTEM.md", matchedTemplate: { pattern: "model", path: "/templates/model.md" } }, content: "actual native {{literal}} prompt", matchesPreview: false }, truncated: false };

it("shows the native applied source and content instead of expanding Handlebars or calling slash templates", async () => {
  const client = { query: vi.fn(async () => inspection), command: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><ModelSystemTemplateInspector context={{ client, sessionId: "owner", available: true, capabilities }} selector="p/model" visible /></PreviewModeProvider></I18nProvider>);
  await screen.findByText("/workspace/SYSTEM.md");
  fireEvent.click(screen.getByText("View applied content", { selector: "summary" }));
  expect(screen.getByText("actual native {{literal}} prompt", { selector: "pre" })).toBeTruthy();
  expect(client.query).toHaveBeenCalledWith("models.systemTemplates.inspect", { sessionId: "owner", selector: "p/model" });
  expect(client.command).not.toHaveBeenCalled();
});

it("saves one config.yml association with its native version rather than a models.yml override", async () => {
  const commands: Record<string, unknown> = {};
  const query = vi.fn(async () => list);
  const command = vi.fn(async (kind: string, input: { pattern: string; file: string }) => {
    commands.write = { status: "completed", result: { ...list, version: "config-v2", bindings: [{ ...list.bindings[0], pattern: input.pattern, file: input.file }] } };
    return { requestId: "write" };
  });
  const client = { query, command, getState: () => ({ commands }) } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><ModelSystemTemplates context={{ client, sessionId: "owner", available: true, capabilities }} visible /></PreviewModeProvider></I18nProvider>);
  fireEvent.click(await screen.findByRole("listitem"));
  fireEvent.change(screen.getByLabelText("Model substring"), { target: { value: "openai/gpt" } });
  fireEvent.change(screen.getByLabelText("Template file"), { target: { value: "~/prompts/new.md" } });
  fireEvent.click(screen.getByRole("button", { name: "Save association" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("models.systemTemplates.binding.set", { sessionId: "owner", version: "config-v1", previousPattern: "gpt", pattern: "openai/gpt", file: "~/prompts/new.md" }));
  expect(command).toHaveBeenCalledTimes(1);
});

it("does not load while hidden and discards a late native preview after hiding", async () => {
  let resolve!: (result: ModelSystemTemplateInspection) => void;
  const query = vi.fn(() => new Promise<ModelSystemTemplateInspection>(done => { resolve = done; }));
  const client = { query } as unknown as StudioClient;
  const context = { client, sessionId: "owner", available: true, capabilities };
  const view = render(<I18nProvider forcedLanguage="en"><ModelSystemTemplateInspector context={context} selector="p/model" visible={false} /></I18nProvider>);
  expect(query).not.toHaveBeenCalled();
  view.rerender(<I18nProvider forcedLanguage="en"><ModelSystemTemplateInspector context={context} selector="p/model" visible /></I18nProvider>);
  await waitFor(() => expect(query).toHaveBeenCalledOnce());
  view.rerender(<I18nProvider forcedLanguage="en"><ModelSystemTemplateInspector context={context} selector="p/model" visible={false} /></I18nProvider>);
  resolve(inspection);
  await waitFor(() => expect(screen.queryByText("/workspace/SYSTEM.md")).toBeNull());
});

it("reopens an editable template after hiding an in-flight file read and ignores its late body", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const delayed = Promise.withResolvers<ModelSystemTemplateFile>();
  const current: ModelSystemTemplateFile = { pattern: "gpt", file: "/templates/gpt.md", content: "Current native template", version: "file-v2", exists: true, editable: true };
  let fileReads = 0;
  const query = vi.fn((kind: string) => kind === "models.systemTemplates.file.read" ? ++fileReads === 1 ? delayed.promise : Promise.resolve(current) : Promise.resolve(list));
  const client = { query, command: vi.fn() } as unknown as StudioClient;
  const context = { client, sessionId: "owner", available: true, capabilities };
  const surface = (visible: boolean) => <I18nProvider forcedLanguage="en"><ModelSystemTemplates context={context} visible={visible} /></I18nProvider>;
  const view = render(surface(true));
  fireEvent.click(await screen.findByRole("listitem"));
  fireEvent.click(screen.getByRole("button", { name: "Edit file content" }));
  await waitFor(() => expect(fileReads).toBe(1));
  view.rerender(surface(false));
  await act(async () => { delayed.resolve({ ...current, content: "Late hidden body", version: "file-v1" }); await delayed.promise; });
  view.rerender(surface(true));
  const reopen = screen.getByRole("button", { name: "Edit file content" }) as HTMLButtonElement;
  await waitFor(() => expect(reopen.disabled).toBe(false));
  fireEvent.click(reopen);
  await screen.findByText("Current native template");
  expect(screen.queryByText("Late hidden body")).toBeNull();
  expect(fileReads).toBe(2);
  expect(client.command).not.toHaveBeenCalled();
});

it("preview/marks-off uses local template fixtures without a Host read or a demo marker", async () => {
  window.history.replaceState(null, "", "?preview=1&marks=off");
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { query: vi.fn(), command: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="en"><PreviewModeProvider switchEnabled><ModelSystemTemplates context={{ client }} visible /></PreviewModeProvider></I18nProvider>);
  await screen.findByText("~/studio-prompts/claude.md");
  expect(screen.queryByText(/Demo|演示/)).toBeNull();
  expect(client.query).not.toHaveBeenCalled(); expect(client.command).not.toHaveBeenCalled();
});
