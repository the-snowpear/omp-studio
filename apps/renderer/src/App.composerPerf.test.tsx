import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudioClientImpl } from "@omp-studio/client";
import { contractFixtures } from "@omp-studio/testkit";
import type { ClientEvent, ClientTransport } from "@omp-studio/client-contract";
import { App } from "./App";
import { __resetAppSettingsForTests } from "./settings/appSettings";
import { setModelConfigDirty } from "./models/modelConfigState";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "./settings/startupNotice";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";

/**
 * P0-5 keystroke budget.
 *
 * One character used to cost two re-renders of AppShell (~7k lines, 58 states)
 * and two of WorkbenchCanvas, plus a forced layout read: `ChipComposer.emit()`
 * published a brand-new draft snapshot into `setDraft` (WorkbenchCanvas) and
 * `setComposerDraftsBySession` (AppShell), whose comparison could never report
 * "unchanged" because the snapshot object is new every keystroke.
 *
 * The two counters below are render probes: AppShell renders `RuntimeLossBanner`
 * unconditionally, WorkbenchCanvas renders `DictationControl` unconditionally, and
 * neither is memoized — so a counter tick == a shell/canvas render.
 */
const probe = vi.hoisted(() => ({ shell: 0, canvas: 0, rect: 0, style: 0 }));

vi.mock("./RuntimeLossBanner", () => ({
  RuntimeLossBanner: () => {
    probe.shell += 1;
    return null;
  },
}));
vi.mock("./composer/DictationControl", () => ({
  DictationControl: () => {
    probe.canvas += 1;
    return null;
  },
}));

const clients: StudioClientImpl[] = [];
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setModelConfigDirty(false);
  localStorage.clear();
  __resetAppSettingsForTests(null);
});
beforeEach(() => {
  probe.shell = 0;
  probe.canvas = 0;
  probe.rect = 0;
  probe.style = 0;
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    probe.rect += 1;
    return rect.call(this);
  });
  const measure = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
    probe.style += 1;
    return measure(element, pseudo ?? undefined);
  });
});

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
  const snapshot = initial.snapshot!;
  const transport = {
    bootstrap: async () => ({ ...initial, cursor: "0", residents: { ...initial.residents, activeSessionId: snapshot.sessionId, residents: [] } }),
    query: async (request: { queryName: string }) => structuredClone((contractFixtures.queryResponses as Record<string, unknown>)[request.queryName]),
    command: async (request: { commandName: string; requestId: string }) => ({ commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: new Date().toISOString() }),
    subscribe: (_scope: unknown, listener: (event: ClientEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    close: async () => {},
  } as unknown as ClientTransport;
  const client = new StudioClientImpl(transport);
  clients.push(client);
  render(<App client={client} />);
  await waitFor(() => expect(document.querySelector("#workbench")).not.toBeNull());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  return document.querySelector<HTMLElement>("#composerInput")!;
}

/** One character: DOM text changes, then React's input event. */
async function type(editor: HTMLElement, text: string) {
  editor.textContent = text;
  probe.shell = 0;
  probe.canvas = 0;
  probe.rect = 0;
  probe.style = 0;
  await act(async () => { fireEvent.input(editor); });
  return { ...probe };
}

/** Let the frame that follows a keystroke run (dock layers measure on it). */
async function nextFrame() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

it("keeps a character out of AppShell and out of the layout engine", async () => {
  const editor = await mount();
  // First character crosses the empty → "has text" boundary: the send button has
  // to flip now, so exactly one workbench render is expected and allowed.
  await type(editor, "a");
  await nextFrame();
  expect(probe.shell, "AppShell renders on the first character").toBe(0);
  expect(probe.canvas, "WorkbenchCanvas renders on the first character").toBe(1);

  for (const [index, text] of ["ab", "abc", "abcd"].entries()) {
    await type(editor, text);
    await nextFrame();
    expect(probe.shell, `AppShell renders on keystroke ${index + 2}`).toBe(0);
    expect(probe.canvas, `WorkbenchCanvas renders on keystroke ${index + 2}`).toBe(0);
    // No forced layout: neither the collision collapse nor a capsule re-measure
    // may run because a character landed.
    expect(probe.rect, `getBoundingClientRect calls on keystroke ${index + 2}`).toBe(0);
    expect(probe.style, `getComputedStyle calls on keystroke ${index + 2}`).toBe(0);
  }
});

it("publishes the deferred draft once the typing pauses", async () => {
  const editor = await mount();
  await type(editor, "a");
  const keystroke = await type(editor, "ab");
  expect(keystroke.canvas).toBe(0);
  // The render-visible draft (title preview, slash state, skills) still has to
  // catch up: it is coalesced, not dropped.
  probe.canvas = 0;
  probe.shell = 0;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
  expect(probe.canvas).toBe(1);
});

it("keeps the sent text intact while the draft publish is still pending", async () => {
  const editor = await mount();
  await type(editor, "a");
  await type(editor, "hello");
  // Enter reads the live editor snapshot, never the debounced view.
  fireEvent.keyDown(editor, { key: "Enter" });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(editor.textContent).toBe("");
});
