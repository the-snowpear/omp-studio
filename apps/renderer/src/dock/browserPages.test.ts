import { afterEach, describe, expect, it } from "vitest";
import { browserRevealTarget, createDefaultLayout, dockReducer, locatePanel } from "./model";
import { DockStore } from "./store";
import { browserPagePanelId, type BrowserPagePanelId, type DockLayout } from "./types";

const stores: DockStore[] = [];
function makeStore(storage: Storage | null): DockStore {
  const store = new DockStore(storage);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  window.localStorage.clear();
});

const page = (pageId: string, sessionId = "chat-a") => browserPagePanelId(sessionId, pageId);
const open = (layout: DockLayout, pageId: string, options: { reveal?: boolean; after?: BrowserPagePanelId; sessionId?: string } = {}) => dockReducer(layout, {
  type: "browser-page-open", panel: page(pageId, options.sessionId), descriptor: { sessionId: options.sessionId ?? "chat-a", pageId }, reveal: options.reveal ?? false, ...(options.after ? { after: options.after } : {}),
});
const strip = (layout: DockLayout, panel: BrowserPagePanelId) => layout.right.groups.concat(layout.bottom.groups, layout.floats).find(group => group.panels.includes(panel))!;
function browserTabsLayout(): DockLayout {
  const layout = dockReducer(createDefaultLayout(), { type: "move", panels: ["changes", "git", "browser", "computer"], target: { region: "right" } });
  layout.right.visible = false;
  return layout;
}

describe("web pages as dock tabs", () => {
  it("lets the first page take the Browser tab's place and puts later pages beside the focused one", () => {
    let layout = open(browserTabsLayout(), "docs");
    expect(layout.right.groups[0]!.panels).toEqual(["changes", "git", page("docs"), "computer"]);
    expect(locatePanel(layout, "browser")).toBeUndefined();
    layout = open(layout, "api");
    layout = open(layout, "preview", { after: page("docs") });
    expect(layout.right.groups[0]!.panels).toEqual(["changes", "git", page("docs"), page("preview"), page("api"), "computer"]);
    layout = dockReducer(layout, { type: "browser-page-focus", panel: page("api") });
    layout = open(layout, "search");
    expect(strip(layout, page("search")).panels.indexOf(page("search"))).toBe(strip(layout, page("api")).panels.indexOf(page("api")) + 1);
  });

  it("keeps Agent pages out of sight while a page the user opens comes to the front", () => {
    let layout = open(browserTabsLayout(), "agent");
    expect(layout.right.visible).toBe(false);
    expect(layout.right.groups[0]!.active).toBe("changes");
    layout = open(layout, "mine", { reveal: true });
    expect(layout.right.visible).toBe(true);
    expect(layout.right.groups[0]!.active).toBe(page("mine"));
    expect(layout.lastBrowserPage).toBe(page("mine"));
  });

  it("turns a showing start page into the page opened from it", () => {
    let layout = open(createDefaultLayout(), "docs");
    layout = dockReducer(layout, { type: "open", panel: "browser" });
    layout = dockReducer(layout, { type: "move", panels: ["browser"], target: { region: "bottom" } });
    layout = open(layout, "typed", { reveal: true });
    expect(locatePanel(layout, page("typed"))?.region).toBe("bottom");
    expect(locatePanel(layout, "browser")).toBeUndefined();
    expect(layout.bottom.groups[0]!.active).toBe(page("typed"));
  });

  it("removes a closed page entirely and focuses the tab that takes its place", () => {
    let layout = open(open(open(createDefaultLayout(), "a", { reveal: true }), "b", { reveal: true }), "c");
    layout = dockReducer(layout, { type: "browser-page-close", panels: [page("b")] });
    expect(locatePanel(layout, page("b"))).toBeUndefined();
    expect(layout.browserPages[page("b")]).toBeUndefined();
    expect(layout.hidden[page("b")]).toBeUndefined();
    expect(layout.right.groups[0]!.active).toBe(page("c"));
    expect(layout.lastBrowserPage).toBe(page("c"));
    layout = dockReducer(layout, { type: "browser-page-close", panels: [page("a"), page("c")] });
    expect(layout.lastBrowserPage).toBeUndefined();
    expect(browserRevealTarget(layout)).toBe("browser");
  });

  it("restores page tabs per chat and does not mark the layout modified for its own pages", () => {
    const storage = window.localStorage;
    storage.clear();
    const first = { target: "local", project: "project", session: "chat-a" };
    const store = makeStore(storage);
    store.switchScope(first, false);
    store.dispatch({ type: "browser-page-open", panel: page("docs"), descriptor: { sessionId: "chat-a", pageId: "docs", title: "Docs" }, reveal: false });
    expect(store.getSnapshot().modified).toBe(false);
    store.dispatch({ type: "move", panels: [page("docs")], target: { region: "bottom" } });
    store.flush();
    store.switchScope({ ...first, session: "chat-b" }, false);
    expect(Object.keys(store.getSnapshot().layout.browserPages)).toEqual([]);
    const reload = makeStore(storage);
    reload.switchScope(first, false);
    expect(locatePanel(reload.getSnapshot().layout, page("docs"))?.region).toBe("bottom");
    expect(reload.getSnapshot().layout.browserPages[page("docs")]?.title).toBe("Docs");
    storage.clear();
  });

  it("saves presets with a Browser place instead of pages and lands the chat's pages there", () => {
    const store = makeStore(null);
    store.switchScope({ target: "local", project: "project", session: "chat-a" }, false);
    for (const pageId of ["docs", "api"]) store.dispatch({ type: "browser-page-open", panel: page(pageId), descriptor: { sessionId: "chat-a", pageId }, reveal: true });
    store.dispatch({ type: "move", panels: [page("docs"), page("api")], target: { region: "bottom" } });
    const preset = store.savePreset("browser below");
    const saved = store.getSnapshot().presets.find(item => item.id === preset)!;
    expect(Object.keys(saved.layout.browserPages)).toEqual([]);
    expect(JSON.stringify(saved.layout)).not.toContain("browser-page:");
    expect(locatePanel(saved.layout, "browser")?.region).toBe("bottom");
    store.applyPreset("default");
    expect(store.getSnapshot().layout.right.groups[0]!.panels).toEqual([page("docs"), page("api")]);
    store.applyPreset(preset);
    expect(locatePanel(store.getSnapshot().layout, page("docs"))?.region).toBe("bottom");
    expect(locatePanel(store.getSnapshot().layout, page("api"))?.region).toBe("bottom");
  });

  it("keeps a pinned page across a restart and returns it to its chat when unpinned", () => {
    const storage = window.localStorage;
    storage.clear();
    const chat = { target: "local", project: "project", session: "chat-a" };
    const store = makeStore(storage);
    store.switchScope(chat, false);
    store.dispatch({ type: "browser-page-open", panel: page("docs"), descriptor: { sessionId: "chat-a", pageId: "docs" }, reveal: true });
    store.dispatch({ type: "move", panels: [page("docs")], target: { region: "float" } });
    store.setPin(store.getSnapshot().layout.floats[0]!.id, "application");
    store.flush();
    const reload = makeStore(storage);
    reload.switchScope({ ...chat, session: "chat-b" }, false);
    const pinned = reload.getSnapshot().layout.floats.find(group => group.panels.includes(page("docs")));
    expect(pinned?.pin?.mode).toBe("application");
    expect(reload.getSnapshot().layout.browserPages[page("docs")]?.sessionId).toBe("chat-a");
    reload.setPin(pinned!.id, "none");
    expect(locatePanel(reload.getSnapshot().layout, page("docs"))).toBeUndefined();
    reload.switchScope(chat, false);
    expect(locatePanel(reload.getSnapshot().layout, page("docs"))).toBeDefined();
    storage.clear();
  });
});
