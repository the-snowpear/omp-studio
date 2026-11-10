import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { WORKBENCH_PANELS } from "../panels/registry";
import { DockProvider, useDock } from "../dock/DockContext";
import { DockFloatingLayer, DockGroupRegion, DockRail } from "../dock/DockRegions";
import { WindowFocusContext, WindowFocusStore } from "../dock/windowOrder";
import { WorkbenchWindows } from "../dock/windows";
import { createDefaultLayout, locatePanel, normalizeLayout } from "../dock/model";
import { DockStore } from "../dock/store";
import { panelBaseId } from "../dock/types";
import { BackgroundTasksDock } from "./BackgroundTasksDock";

let frames: FrameRequestCallback[] = [];
function flush() { act(() => { const pending = frames; frames = []; pending.forEach(callback => callback(0)); }); }
afterEach(() => { cleanup(); localStorage.removeItem(PREVIEW_MODE_STORAGE_KEY); vi.restoreAllMocks(); vi.unstubAllGlobals(); frames = []; });
function Surface({ client }: { client: StudioClient }) {
  const { layout } = useDock();
  return <>
    <div className="adaptive-workbench" data-dock-window="main-surface"><div className="convo-wrap"><DockRail mode={layout.rail.mode} /></div><DockGroupRegion region="right" visible={layout.right.visible} /></div>
    <DockFloatingLayer />
    <BackgroundTasksDock client={client} scopeKey="preview-task-test" available={false} jobsReady={false} workbenchVisible canListServices={false} canStopServices={false} canCancelJobs={false} />
  </>;
}
function setup(collapsed = false, manager?: WorkbenchWindows) {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    return new DOMRect(0, 0, this.matches(".adaptive-workbench,.convo-wrap") ? 1400 : 320, this.matches(".adaptive-workbench,.convo-wrap") ? 900 : 280);
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 320, 280)] as unknown as DOMRectList);
  const store = new DockStore(null);
  const focus = manager?.focus ?? new WindowFocusStore();
  if (manager) store.bindWindows(manager, "task-chat", "Task conversation");
  focus.register("main-surface", { ownerId: "task-chat", surface: document, floating: false });
  focus.activate("main-surface");
  store.dispatch({ type: "move", panels: ["jobs"], target: { region: "rail" } });
  store.dispatch({ type: "railMode", mode: "expanded" });
  store.dispatch({ type: "card", panel: "jobs", collapsed });
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><WindowFocusContext.Provider value={focus}><DockProvider definitions={WORKBENCH_PANELS} store={store}><Surface client={client} /></DockProvider></WindowFocusContext.Provider></PreviewModeProvider></I18nProvider>);
  flush(); flush();
  return { store, client, focus };
}
it("preserves an explicitly hidden saved background task layout", () => {
  const old = createDefaultLayout();
  old.rail.panels = old.rail.panels.filter(panel => panel !== "jobs");
  old.hidden.jobs = { region: "float" };
  old.rail.mode = "compact";
  old.rail.lastMode = "compact";
  const restored = normalizeLayout(old);
  expect(restored.rail).toEqual(old.rail);
  expect(restored.left).toEqual(old.left);
  expect(restored.right).toEqual(old.right);
  expect(restored.floats).toEqual(old.floats);
  expect(locatePanel(restored, "jobs")).toBeUndefined();
  expect(restored.hidden.jobs?.region).toBe("float");
});
it("publishes collapsed and icon summaries before the body is ever mounted", () => {
  const { store, client } = setup(true);
  expect(document.querySelector(".background-tasks")).toBeNull();
  expect(Array.from(document.querySelectorAll(".dock-status-summary")).some(node => node.getAttribute("aria-label")?.startsWith("Background tasks"))).toBe(true);
  act(() => store.dispatch({ type: "railMode", mode: "compact" }));
  flush(); flush();
  expect(document.querySelector(".background-tasks")).toBeNull();
  expect(document.querySelector(".dock-meter-badge")?.textContent).toMatch(/\d/);
  expect(client.command).not.toHaveBeenCalled();
});
it("opens selected details beside the retained card and shares service stop state", () => {
  const { store, client } = setup();
  const card = document.querySelector<HTMLElement>(".background-tasks.is-card")!;
  expect(card).toBeTruthy();
  const before = Number(card.querySelector(".bt-activity b")!.textContent);
  fireEvent.click(card.querySelector<HTMLButtonElement>(".bt-row[data-kind='service'] .bt-task-main")!);
  flush(); flush();
  expect(store.getSnapshot().layout.rail.panels).toContain("jobs");
  expect(store.getSnapshot().layout.right.groups.some(group => group.panels.some(id => panelBaseId(id) === "jobs"))).toBe(true);
  expect(store.getSnapshot().layout.floats).toHaveLength(0);
  const full = document.querySelector<HTMLElement>(".background-tasks:not(.is-card)")!;
  expect(full).toBeTruthy();
  expect(full.querySelector(".bt-detail")!.textContent).toContain("preview-web");
  fireEvent.click(card.querySelector<HTMLButtonElement>(".bt-row[data-kind='service'] .bt-stop")!);
  fireEvent.click(within(screen.getByRole("dialog", { name: "停止服务" })).getByRole("button", { name: "停止服务" }));
  expect(Number(card.querySelector(".bt-activity b")!.textContent)).toBe(before - 1);
  expect(full.querySelector(".bt-activity b")!.textContent).toBe(String(before - 1));
  expect(full.querySelector(".bt-detail-summary")!.textContent).toContain("已退出");
  expect(client.command).not.toHaveBeenCalled();
});

const rightJobs = (store: DockStore) => store.getSnapshot().layout.right.groups.flatMap(group => group.panels).filter(id => panelBaseId(id) === "jobs");
const cardJob = (index = 0) => document.querySelectorAll<HTMLButtonElement>(".background-tasks.is-card .bt-row[data-kind='job'] .bt-task-main")[index]!;
const panelBody = (id: string) => document.querySelector<HTMLElement>(`[data-panel="${id}"] .background-tasks`)!;
function clickCardJob(index = 0) {
  const button = cardJob(index);
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 300, clientY: 120 });
  fireEvent.click(button, { detail: 1 });
  flush(); flush();
}

it("switches different tasks inside one right-side page without opening a float", () => {
  const { store } = setup();
  clickCardJob();
  const id = rightJobs(store)[0]!;
  const body = panelBody(id);
  expect(body.querySelector(".bt-detail h3")!.textContent).toBe("bunx tsc --noEmit");
  clickCardJob(1);
  expect(rightJobs(store)).toEqual([id]);
  expect(panelBody(id)).toBe(body);
  expect(body.querySelector(".bt-detail h3")!.textContent).toBe("npm run check -- --only renderer");
  expect(store.getSnapshot().layout.floats).toHaveLength(0);
});

it("keeps using the focused other window even though the card click focuses the conversation", () => {
  const manager = new WorkbenchWindows();
  const { store, focus } = setup(false, manager);
  act(() => store.openIn("jobs", { region: "float" })); flush(); flush();
  const group = store.getSnapshot().layout.floats.find(group => panelBaseId(group.active) === "jobs")!;
  const body = panelBody(group.active);
  act(() => manager.activate(store.windowId(group.id)));
  expect(focus.getSnapshot().activeId).toBe(store.windowId(group.id));
  const button = cardJob(1);
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 300, clientY: 120 });
  // Fixed portal hosts omit the conversation wrapper; model its normal focus activation.
  act(() => focus.activate("main-surface"));
  expect(focus.getSnapshot().activeId).toBe("main-surface");
  fireEvent.click(button, { detail: 1 }); flush(); flush();
  expect(rightJobs(store)).toHaveLength(0);
  expect(store.getSnapshot().layout.floats).toHaveLength(1);
  expect(panelBody(group.active)).toBe(body);
  expect(body.querySelector(".bt-detail h3")!.textContent).toBe("npm run check -- --only renderer");
});

it("creates a right-side twin instead of moving an unfocused background task window", () => {
  const { store, focus } = setup();
  act(() => store.openIn("jobs", { region: "float" })); flush(); flush();
  const group = store.getSnapshot().layout.floats.find(group => panelBaseId(group.active) === "jobs")!;
  const before = { id: group.id, active: group.active, rect: { ...group.rect } };
  act(() => focus.activate("main-surface"));
  clickCardJob();
  expect(rightJobs(store)).toHaveLength(1);
  expect(rightJobs(store)[0]).not.toBe(before.active);
  const retained = store.getSnapshot().layout.floats.find(value => value.id === before.id)!;
  expect(retained.active).toBe(before.active);
  expect(retained.rect).toEqual(before.rect);
  expect(panelBody(rightJobs(store)[0]!).querySelector(".bt-detail h3")!.textContent).toBe("bunx tsc --noEmit");
});

it("always prefers the existing right-side page over a focused float", () => {
  const { store, focus } = setup();
  act(() => store.openIn("jobs", { region: "float" })); flush(); flush();
  const floating = store.getSnapshot().layout.floats.find(group => panelBaseId(group.active) === "jobs")!;
  act(() => store.openIn("jobs", { region: "right" })); flush(); flush();
  const id = rightJobs(store)[0]!;
  const body = panelBody(id);
  act(() => focus.activate(store.windowId(floating.id), null));
  clickCardJob(1);
  expect(rightJobs(store)).toEqual([id]);
  expect(panelBody(id)).toBe(body);
  expect(body.querySelector(".bt-detail h3")!.textContent).toBe("npm run check -- --only renderer");
  expect(store.getSnapshot().layout.floats).toHaveLength(1);
});

it("reveals and switches the same right-side page when its region is hidden", () => {
  const { store } = setup();
  act(() => store.openIn("jobs", { region: "right" })); flush(); flush();
  const id = rightJobs(store)[0]!;
  act(() => store.dispatch({ type: "region", region: "right", visible: false })); flush();
  clickCardJob(1);
  expect(store.getSnapshot().layout.right.visible).toBe(true);
  expect(rightJobs(store)).toEqual([id]);
  expect(panelBody(id).querySelector(".bt-detail h3")!.textContent).toBe("npm run check -- --only renderer");
  expect(store.getSnapshot().layout.floats).toHaveLength(0);
});

it("does not restore a minimized other window instead of opening the right sidebar", () => {
  const { store } = setup();
  act(() => store.openIn("jobs", { region: "float" })); flush(); flush();
  const floating = store.getSnapshot().layout.floats.find(group => panelBaseId(group.active) === "jobs")!;
  act(() => store.dispatch({ type: "float", groupId: floating.id, minimized: true })); flush();
  clickCardJob();
  expect(rightJobs(store)).toHaveLength(1);
  expect(store.getSnapshot().layout.floats.find(group => group.id === floating.id)?.minimized).toBe(true);
});
