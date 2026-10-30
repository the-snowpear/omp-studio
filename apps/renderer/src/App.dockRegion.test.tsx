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

/**
 * P2-2: a narrow window shows a side panel only when the layout solver has a
 * focus priority for it. The View menu (dock-engine) used to flip
 * `dock.layout.right.visible` alone, so the panel stayed clipped; both the menu
 * and the topbar buttons now go through the same priority contract.
 */

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

function stubWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  // jsdom has no layout: the workbench root is the only box the solver measures.
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    return this.matches(".app-body") ? width : 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.matches(".app-body") ? new DOMRect(0, 0, width, 900) : new DOMRect(0, 0, 0, 0);
  });
}

async function mount(width: number) {
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "0");
  __resetAppSettingsForTests(JSON.stringify({ language: "en", startupPage: "workbench", rememberLayout: false, restoreLastSession: false }));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  stubWindowWidth(width);
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
}

function overlay(): string | null {
  return document.querySelector(".app-body")?.getAttribute("data-layout-overlay") ?? null;
}
function sideShown(): boolean {
  return document.querySelector("#sidePanel")?.classList.contains("open") ?? false;
}
/** The titlebar toggle mirrors `layout.sidebarShown` (presented, not preference). */
function sidebarPresented(): boolean {
  return document.querySelector<HTMLElement>('[aria-controls="sidebar"]')?.getAttribute("aria-expanded") === "true";
}

/** Open the titlebar View menu and click one region toggle. */
async function toggleRegion(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
    .find((node) => node.textContent?.trim().startsWith(label));
  expect(item, `View menu item "${label}"`).toBeTruthy();
  fireEvent.click(item!);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

function regionChecked(label: string): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
    .find((node) => node.textContent?.trim().startsWith(label))?.getAttribute("aria-checked") === "true";
}

async function checkRegionState(label: string): Promise<boolean> {
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const checked = regionChecked(label);
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return checked;
}

it("shows the right sidebar from the View menu in a 640px window", async () => {
  await mount(640);
  expect(sideShown()).toBe(false);
  expect(overlay()).toBeNull();

  await toggleRegion("Right sidebar");

  expect(sideShown()).toBe(true);
  expect(overlay()).toBe("side");
  expect(document.querySelector(".layout-overlay-backdrop")).not.toBeNull();
  expect(await checkRegionState("Right sidebar")).toBe(true);
});

it("re-presents a region whose preference is already on but the narrow window clipped", async () => {
  await mount(640);
  // Left sidebar: preference on by default, but 640px cannot dock it. The menu
  // must describe the screen, not the preference — this is the case where it used
  // to show "checked" while nothing appeared, and a click turned the region off.
  expect(await checkRegionState("Left sidebar")).toBe(false);
  expect(overlay()).toBeNull();
  expect(sidebarPresented()).toBe(false);

  await toggleRegion("Left sidebar");

  expect(overlay()).toBe("sidebar");
  expect(sidebarPresented()).toBe(true);
  expect(await checkRegionState("Left sidebar")).toBe(true);
});

it("keeps the narrow window's one visible drawer in sync with the menu", async () => {
  await mount(640);
  await toggleRegion("Right sidebar");
  expect(overlay()).toBe("side");
  expect(await checkRegionState("Right sidebar")).toBe(true);
  expect(await checkRegionState("Left sidebar")).toBe(false);

  // Both regions compete for the same narrow window: opening one displaces the other.
  await toggleRegion("Left sidebar");
  expect(overlay()).toBe("sidebar");
  expect(sidebarPresented()).toBe(true);
  expect(sideShown()).toBe(false);
  expect(await checkRegionState("Right sidebar")).toBe(false);

  // Closing the visible one releases only its own priority.
  await toggleRegion("Left sidebar");
  expect(overlay()).toBeNull();
  expect(sidebarPresented()).toBe(false);

  // And the displaced one can be brought back through the menu.
  await toggleRegion("Right sidebar");
  expect(overlay()).toBe("side");
  expect(sideShown()).toBe(true);
});

it("leaves the conversation rail out of the layout solver", async () => {
  await mount(640);
  await toggleRegion("Right sidebar");
  expect(overlay()).toBe("side");
  await toggleRegion("Conversation tools");
  expect(overlay()).toBe("side");
  expect(sideShown()).toBe(true);
});

it("docks the right sidebar in a wide window without an overlay", async () => {
  await mount(1440);
  expect(sideShown()).toBe(false);
  await toggleRegion("Right sidebar");
  expect(sideShown()).toBe(true);
  expect(overlay()).toBeNull();
  expect(document.querySelector(".layout-overlay-backdrop")).toBeNull();
  await toggleRegion("Right sidebar");
  expect(sideShown()).toBe(false);
});
