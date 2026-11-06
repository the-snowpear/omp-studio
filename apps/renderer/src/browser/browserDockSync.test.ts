import { describe, expect, it } from "vitest";
import type { ManagedBrowserPage, ManagedBrowserState } from "@omp-studio/studio-protocol";
import { createDefaultLayout, dockReducer, locatePanel } from "../dock/model";
import { browserPagePanelId, type DockLayout } from "../dock/types";
import { planBrowserDockSync, type BrowserDockMemory } from "./browserDockSync";

const page = (id: string, patch: Partial<ManagedBrowserPage> = {}): ManagedBrowserPage => ({ id, sessionId: "chat", spaceId: "shared", title: id, url: `http://localhost:5173/${id}`, status: "ready", canGoBack: false, canGoForward: false, zoom: 1, devtools: false, ...patch });
const state = (pages: ManagedBrowserPage[], activePageId = pages.at(-1)?.id ?? null): ManagedBrowserState => ({ sessionId: "chat", pages, activePageId, spaces: [], control: "human", connection: "connected", settings: { maxTabs: 16, downloadDirectory: "", askDownloadLocation: false }, downloads: [], permissions: [] });
const tab = (id: string) => browserPagePanelId("chat", id);

/** Runs passes like the live sync until nothing changes. */
function settle(layout: DockLayout, browser: ManagedBrowserState, memory?: BrowserDockMemory) {
  let selected: string | undefined;
  for (let pass = 0; pass < 4; pass++) {
    const plan = planBrowserDockSync({ layout, sessionId: "chat", state: browser, memory });
    memory = plan.memory;
    selected ??= plan.select;
    if (!plan.actions.length) break;
    for (const action of plan.actions) layout = dockReducer(layout, action);
  }
  return { layout, memory: memory!, selected };
}

describe("browser pages and their dock tabs", () => {
  it("restores existing pages quietly and reveals a page the user opens", () => {
    let { layout, memory } = settle(createDefaultLayout(), state([page("a"), page("b")], "a"));
    expect(layout.right.groups[0]!.panels).toEqual(["changes", "git", tab("a"), tab("b"), "computer"]);
    expect(layout.right.visible).toBe(false);
    ({ layout, memory } = settle(layout, state([page("a"), page("b"), page("c", { opener: { source: "human", pageId: "a" } })], "c"), memory));
    expect(layout.right.visible).toBe(true);
    expect(layout.right.groups[0]!.active).toBe(tab("c"));
    expect(layout.right.groups[0]!.panels.indexOf(tab("c"))).toBe(layout.right.groups[0]!.panels.indexOf(tab("a")) + 1);
  });

  it("follows the Agent to a new page only where this chat's pages are already showing", () => {
    let { layout, memory } = settle(dockReducer(createDefaultLayout(), { type: "region", region: "right", visible: true }), state([page("a")], "a"));
    layout = dockReducer(layout, { type: "activate", groupId: "right-main", panel: tab("a") });
    ({ layout, memory } = settle(layout, state([page("a"), page("agent", { opener: { source: "agent" } })], "agent"), memory));
    expect(layout.right.groups[0]!.active).toBe(tab("agent"));
    layout = dockReducer(layout, { type: "activate", groupId: "right-main", panel: "git" });
    ({ layout } = settle(layout, state([page("a"), page("agent"), page("more", { opener: { source: "agent" } })], "more"), memory));
    expect(layout.right.groups[0]!.active).toBe("git");
    expect(locatePanel(layout, tab("more"))).toBeDefined();
  });

  it("selects the page of a clicked tab and drops tabs of closed pages", () => {
    let { layout, memory } = settle(createDefaultLayout(), state([page("a"), page("b")], "b"));
    layout = dockReducer(layout, { type: "browser-page-focus", panel: tab("a") });
    const clicked = settle(layout, state([page("a"), page("b")], "b"), memory);
    expect(clicked.selected).toBe("a");
    ({ layout, memory } = settle(clicked.layout, state([page("a")], "a"), clicked.memory));
    expect(locatePanel(layout, tab("b"))).toBeUndefined();
    expect(layout.browserPages[tab("b")]).toBeUndefined();
  });

  it("remembers a page's title once it has loaded, not every retitle", () => {
    let { layout, memory } = settle(createDefaultLayout(), state([page("a", { status: "loading", title: "http://localhost:5173/a" })], "a"));
    expect(layout.browserPages[tab("a")]?.title).toBeUndefined();
    ({ layout, memory } = settle(layout, state([page("a", { title: "Dashboard" })], "a"), memory));
    expect(layout.browserPages[tab("a")]?.title).toBe("Dashboard");
    ({ layout } = settle(layout, state([page("a", { title: "Dashboard (3)" })], "a"), memory));
    expect(layout.browserPages[tab("a")]?.title).toBe("Dashboard");
  });
});
