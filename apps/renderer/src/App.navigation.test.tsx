import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StudioClientImpl } from "@omp-studio/client";
import { contractFixtures } from "@omp-studio/testkit";
import type { ClientEvent, ClientTransport } from "@omp-studio/client-contract";
import { App } from "./App";
import { __resetAppSettingsForTests } from "./settings/appSettings";
import { setModelConfigDirty } from "./models/modelConfigState";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "./settings/startupNotice";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";

vi.mock("./MediaPage", () => ({ MediaPage: ({ onInsert }: { onInsert: (text: string) => void }) => <button onClick={() => onInsert("prepared result")}>Insert prepared result</button> }));
vi.mock("./ModelConfigPage", () => ({ ModelConfigPage: () => <><h2>Model editor</h2><input aria-label="Model draft" defaultValue="unsaved provider" /><button onClick={() => setModelConfigDirty(true)}>Mark model dirty</button></> }));
vi.mock("./HomePage", async () => { const original = await vi.importActual<typeof import("./HomePage")>("./HomePage"); return { ...original, HomePage: () => <h2>Home content</h2> }; });
vi.mock("./TerminalPane", () => ({ TerminalPane: () => null }));

const clients: StudioClientImpl[] = [];
afterEach(async () => { cleanup(); for (const client of clients.splice(0)) await client.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setModelConfigDirty(false); localStorage.clear(); __resetAppSettingsForTests(null); });

async function mount() {
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  __resetAppSettingsForTests(JSON.stringify({ language: "en", startupPage: "workbench", rememberLayout: false, restoreLastSession: false }));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const initial = structuredClone(contractFixtures.bootstrap);
  const listeners = new Set<(event: ClientEvent) => void>();
  let cursor = 0;
  let snapshot = initial.snapshot!;
  const query = vi.fn(async (request: { queryName: string }) => structuredClone((contractFixtures.queryResponses as Record<string, unknown>)[request.queryName]));
  const transport = {
    bootstrap: async () => ({ ...initial, cursor: "0", residents: { ...initial.residents, activeSessionId: snapshot.sessionId, residents: [] } }),
    query,
    command: async (request: { commandName: string; requestId: string }) => ({ commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: new Date().toISOString() }),
    subscribe: (_scope: unknown, listener: (event: ClientEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    close: async () => {},
  } as unknown as ClientTransport;
  const client = new StudioClientImpl(transport);
  clients.push(client);
  render(<App client={client} />);
  await waitFor(() => expect(document.querySelector("#workbench")).not.toBeNull());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  return {
    query,
    title() { snapshot = { ...snapshot, stateVersion: (Number(snapshot.stateVersion) + 1) as never, sessionTitle: "Named session", sessionTitleSource: "user" }; for (const listener of listeners) listener({ kind: "snapshot", authorityEpoch: initial.authority.authorityEpoch, runtimeEpoch: snapshot.runtimeEpoch, stateVersion: snapshot.stateVersion, cursor: String(++cursor), occurredAt: new Date().toISOString(), snapshot } as ClientEvent); },
  };
}
async function open(route: string) {
  fireEvent.click(screen.getByRole("button", { name: "File" }));
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent?.trim() === route);
  expect(button).toBeTruthy();
  fireEvent.click(button!);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
}

it("a named session refreshes history once instead of looping after the result commits", async () => {
  const f = await mount();
  const before = f.query.mock.calls.filter(([request]) => request.queryName === "history.list").length;
  act(() => f.title());
  await waitFor(() => expect(f.query.mock.calls.filter(([request]) => request.queryName === "history.list").length).toBeGreaterThan(before));
  const after = f.query.mock.calls.filter(([request]) => request.queryName === "history.list").length;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  expect(f.query.mock.calls.filter(([request]) => request.queryName === "history.list")).toHaveLength(after);
  expect(after - before).toBeLessThanOrEqual(3);
});

it("blocks secondary navigation and forward when model configuration is dirty", async () => {
  await mount();
  await open("Project Home");
  await open("Model Configuration");
  await screen.findByRole("heading", { name: "Model editor" });
  fireEvent.click(screen.getByRole("button", { name: "Mark model dirty" }));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(document.querySelector('a[data-nav="settings"]')!);
  expect(document.querySelector("#pageBody")?.getAttribute("data-route")).toBe("model-config");
  expect((screen.getByLabelText("Model draft") as HTMLInputElement).value).toBe("unsaved provider");
  expect(confirm).toHaveBeenCalledOnce();
  await open("Settings");
  expect(document.querySelector("#pageBody")?.getAttribute("data-route")).toBe("model-config");
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("heading", { name: "Home content" });
  setModelConfigDirty(true);
  confirm.mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  expect(document.querySelector("#pageBody")?.getAttribute("data-route")).toBe("home");
});

it("inserts prepared text after returning from media without losing the current draft", async () => {
  await mount();
  const editor = document.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!;
  editor.textContent = "existing draft";
  fireEvent.input(editor);
  await open("Media");
  await screen.findByRole("button", { name: "Insert prepared result" });
  expect(document.querySelector("#workbench")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Insert prepared result" }));
  await waitFor(() => expect(document.querySelector('[role="textbox"]')?.textContent).toContain("prepared result"));
  expect(document.querySelector('[role="textbox"]')?.textContent).toContain("existing draft");
});
