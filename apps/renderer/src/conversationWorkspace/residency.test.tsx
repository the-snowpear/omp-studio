import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { isInaccessible } from "@testing-library/dom";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientContextScope, ClientTransport, SessionId, WorkspaceId } from "@omp-studio/client-contract";
import { StudioClientImpl } from "@omp-studio/client";
import { contractFixtures } from "@omp-studio/testkit";
import { App } from "../App";
import { __resetAppSettingsForTests } from "../settings/appSettings";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "../settings/startupNotice";
import { ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID } from "../onboarding/onboardingState";
import { collectRendererResources } from "../rendererResources";

vi.setConfig({ testTimeout: 15_000 });
afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  window.dispatchEvent(new Event("pagehide"));
  localStorage.clear(); __resetAppSettingsForTests(null);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function fixture(beforeBootstrap?: () => Promise<void>) {
  const workspaceId = "residency-project" as WorkspaceId;
  const history = contractFixtures.queryResponses["history.list"];
  if (!history.ok) throw new Error("Expected history fixture");
  const entries = Array.from({ length: 6 }, (_, index) => ({ ...history.result.entries[0]!,
    historyId: `residency-history-${index}`, threadId: `residency-thread-${index}`, sessionId: `residency-session-${index}`, title: `Residency session ${index}` }));
  const counts = { opened: 0, closed: 0, projectsOpened: 0, projectsClosed: 0 };
  function transport(scope?: ClientContextScope): ClientTransport {
    let closed = false;
    return {
      openContext: async next => { if (next.sessionId) counts.opened++; else counts.projectsOpened++; return transport(next); },
      bootstrap: async () => {
        if (scope) await beforeBootstrap?.();
        const { snapshot: _snapshot, stateVersion: _version, ...base } = structuredClone(contractFixtures.bootstrap);
        return { ...base, runtime: { status: "unavailable", classification: "unavailable" },
          selected: { workspaceId, ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}) },
          residents: { generatedAt: "2026-11-09T00:00:00Z", residents: [] } };
      },
      query: async request => {
        const result = structuredClone((contractFixtures.queryResponses as Record<string, unknown>)[request.queryName]) as any;
        if (request.queryName === "projects.list") result.result = { activeWorkspaceId: workspaceId, workspaces: [{ workspaceId, name: "Residency project", active: true, lastOpenedAt: "2026-11-09T00:00:00Z" }] };
        if (request.queryName === "history.list") result.result = { entries, total: entries.length };
        if (request.queryName === "session.transcript.readPage") result.result.sessionId = scope?.sessionId as SessionId;
        if (request.queryName === "session.agents.list") result.result = { sessionId: scope?.sessionId, agents: [] };
        if (request.queryName === "residents.list") result.result = { generatedAt: "2026-11-09T00:00:00Z", residents: [] };
        return result;
      },
      command: async () => { throw new Error("Residency tests do not execute commands"); },
      subscribe: () => () => {},
      close: async () => { if (!closed) { closed = true; if (scope?.sessionId) counts.closed++; else if (scope) counts.projectsClosed++; } },
    };
  }
  return { counts, client: new StudioClientImpl(transport()) };
}

async function mount(input = fixture(), startupPage: "home" | "workbench" = "workbench") {
  localStorage.setItem("omp.previewMode", "0");
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID);
  __resetAppSettingsForTests(JSON.stringify({ language: "en", theme: "light", restoreLastSession: false, rememberLayout: false, startupPage }));
  // These APIs exist in Electron but not jsdom, as in the window integration harness.
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  render(<App client={input.client} />);
  await waitFor(() => startupPage === "home"
    ? expect(document.querySelector("#pageBody")?.getAttribute("data-route")).toBe("home")
    : expect(row(0)).toBeDefined());
  return input;
}
function row(index: number) {
  return [...document.querySelectorAll<HTMLButtonElement>("#projectList .thread")].find(button => button.textContent?.includes(`Residency session ${index}`));
}
async function select(index: number) {
  await waitFor(() => expect(row(index)).toBeDefined());
  fireEvent.click(row(index)!);
  await waitFor(() => expect(document.querySelector(".cw-main-conversation #appRoot[aria-busy=true]")).toBeNull());
  await waitFor(() => expect(row(index)?.classList.contains("active")).toBe(true));
}

function navigateTo(name: "Workbench" | "History") {
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name }));
}
async function expectConversation(index: number) {
  await waitFor(() => expect(document.querySelector("#pageBody")?.getAttribute("data-route")).toBeUndefined());
  await waitFor(() => expect(row(index)?.classList.contains("active")).toBe(true));
  const transcript = screen.getByRole("log");
  expect(isInaccessible(transcript)).toBe(false);
  await waitFor(() => expect(transcript.textContent).toContain("world"));
}

it.each([false, true])("honors Home on launch, then shows an explicitly opened offline archive (restored workspace=%s)", async restored => {
  if (restored) {
    await mount();
    await select(0);
    cleanup();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  await mount(fixture(), "home");
  expect(isInaccessible(document.querySelector("#pageBody")!)).toBe(false);
  navigateTo("Workbench");
  await waitFor(() => expect(row(1)).toBeDefined());
  expect(isInaccessible(row(1)!)).toBe(false);
  fireEvent.click(row(1)!);
  await expectConversation(1);
});

it.each([false, true])("opens a conversation from History instead of restoring its page route (released=%s)", async released => {
  const input = await mount();
  await select(0);
  const editor = document.querySelector<HTMLElement>(".cw-main-conversation [contenteditable=true]")!;
  editor.textContent = "draft retained across page navigation"; fireEvent.input(editor);
  navigateTo("History");
  await waitFor(() => expect(document.querySelector("#pageBody")?.getAttribute("data-route")).toBe("history"));
  const target = released ? 1 : 0;
  fireEvent.click(await screen.findByRole("link", { name: new RegExp(`^Residency session ${target}`) }));
  if (released) {
    await expectConversation(1);
    await waitFor(() => expect(input.counts.closed).toBe(1));
    expect(editor.isConnected).toBe(false);
    fireEvent.click(row(0)!);
  }
  await expectConversation(0);
  expect(document.querySelector<HTMLElement>(".cw-main-conversation [contenteditable=true]")!.textContent).toBe("draft retained across page navigation");
});

it("keeps only the displayed conversation engine and closes replaced contexts while offline", async () => {
  const baseline = collectRendererResources()["engines.active"] ?? 0;
  const input = await mount();
  for (let index = 0; index < 6; index++) {
    await select(index);
    await waitFor(() => expect(input.counts.closed).toBe(index));
    expect(collectRendererResources()["engines.active"]).toBe(baseline + 1);
    await waitFor(() => expect(window.ompSessionPerf.snapshot().counters["real.hosts"]).toBe(1));
  }
  expect(input.counts.opened).toBe(6);
  expect(input.counts.projectsOpened).toBe(1);
  expect(window.ompSessionPerf.snapshot().counters["real.mountedDocuments"]).toBe(1);
  expect(window.ompSessionPerf.snapshot(true).counters["real.detachedNodes"]).toBe(0);
});

it("restores the latest draft after releasing its view, without reusing its old editor DOM", async () => {
  await mount();
  await select(0);
  const editor = document.querySelector<HTMLElement>(".cw-main-conversation [contenteditable=true]")!;
  editor.textContent = "draft"; fireEvent.input(editor);
  editor.textContent = "draft typed just before switching"; fireEvent.input(editor);
  await select(1);
  await waitFor(() => expect(editor.isConnected).toBe(false));
  await select(0);
  const restored = document.querySelector<HTMLElement>(".cw-main-conversation [contenteditable=true]")!;
  expect(restored).not.toBe(editor);
  await waitFor(() => expect(restored.textContent).toBe("draft typed just before switching"));
});

it("releases a context even when switching away before its bootstrap completes", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const input = await mount(fixture(() => pending));
  fireEvent.click(row(0)!);
  await waitFor(() => expect(input.counts.opened).toBe(1));
  await waitFor(() => expect(row(1)).toBeDefined());
  fireEvent.click(row(1)!);
  await waitFor(() => expect(input.counts.closed).toBe(1));
  finish();
  await waitFor(() => expect(document.querySelector(".cw-main-conversation #appRoot[aria-busy=true]")).toBeNull());
  await waitFor(() => expect(window.ompSessionPerf.snapshot().counters["real.hosts"]).toBe(1));
  expect(input.counts.opened).toBe(2);
});
