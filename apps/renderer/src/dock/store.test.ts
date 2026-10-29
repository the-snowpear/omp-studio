import { describe, expect, it, vi } from "vitest";
import { builtInPresets, createDefaultLayout, locatePanel } from "./model";
import { DockStore, dockProjectKey } from "./store";
import type { DockScope } from "./types";

class MemoryStorage implements Storage {
  readonly data = new Map<string, string>();
  writes: string[] = [];
  attempts = 0;
  failures = 0;
  failAll = false;
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) {
    this.attempts++;
    if (this.failAll || this.failures > 0) {
      if (this.failures > 0) this.failures--;
      throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
    }
    this.writes.push(key);
    this.data.set(key, value);
  }
}

const a: DockScope = { target: "local", project: "project-a", session: "session-a" };
const b: DockScope = { ...a, session: "session-b" };
const c: DockScope = { target: "ssh:work", project: "project-a", session: "session-a" };
const draft: DockScope = { ...a, session: "draft-1", draft: true };
const layout = (store: DockStore) => store.getSnapshot().layout;
const openGit = (store: DockStore) => store.dispatch({ type: "open", panel: "git" });

function setup(): { store: DockStore; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const store = new DockStore(storage);
  store.switchScope(a, false);
  storage.writes = [];
  return { store, storage };
}

describe("dock persistence and session scope", () => {
  it("adopts a real draft completed while preview is displayed without switching namespaces", () => {
    const { store, storage } = setup();
    store.beginDraft(draft);
    store.dispatch({ type: "move", panels: ["git"], target: { region: "left" } });
    const expected = layout(store);
    store.switchScope({ target: "preview", project: "demo", session: "demo" }, true);
    const demo = store.getSnapshot();
    const writes = storage.writes.length;
    store.adoptDraft(b, { scope: draft, preview: false });
    expect(store.getSnapshot().preview).toBe(true);
    expect(store.getSnapshot().scope).toEqual(demo.scope);
    expect(layout(store)).toEqual(demo.layout);
    expect(storage.writes).toHaveLength(writes);
    store.switchScope(b, false);
    expect(layout(store)).toEqual(expected);
    const restart = new DockStore(storage);
    restart.switchScope(b, false);
    expect(layout(restart)).toEqual(expected);
  });
  it("saves committed actions under target/project/session identity", () => {
    const { store, storage } = setup();
    store.dispatch({ type: "move", panels: ["terminal"], target: { region: "left" } });
    expect(storage.writes).toEqual([]); // batched, not lost
    store.flush();
    expect(storage.writes).toHaveLength(1);
    const moved = layout(store);
    store.switchScope(b, false);
    expect(layout(store)).toEqual(createDefaultLayout());
    openGit(store);
    const bLayout = layout(store);
    store.switchScope(c, false);
    expect(layout(store)).toEqual(createDefaultLayout());
    store.switchScope({ ...a, project: "other-project" }, false);
    expect(layout(store)).toEqual(createDefaultLayout());
    store.switchScope(a, false);
    expect(layout(store)).toEqual(moved);
    const reloaded = new DockStore(storage);
    reloaded.switchScope(b, false);
    expect(layout(reloaded)).toEqual(bLayout);
    reloaded.switchScope(a, false);
    expect(locatePanel(layout(reloaded), "terminal")?.region).toBe("left");
    expect(reloaded.getSnapshot().canUndo).toBe(false);
  });

  it("does not write or notify for cancelled, unchanged or forbidden edits", () => {
    const { store, storage } = setup();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    const snapshot = store.getSnapshot();
    // Drag previews/cancellation do not dispatch a model action. Even an empty
    // move and no-change final resize are true no-ops at the store boundary.
    store.dispatch({ type: "move", panels: [], target: { region: "float" } });
    store.dispatch({ type: "resize", region: "left", size: 272 });
    store.dispatch({ type: "hide", panels: ["btw"] });
    store.dispatch({ type: "activate", groupId: "right-main", panel: "changes" });
    store.switchScope(a, false);
    expect(storage.writes).toEqual([]);
    expect(notifications).toBe(0);
    expect(store.getSnapshot()).toBe(snapshot);
    store.updatePreferences({ locked: true });
    const before = storage.writes.length;
    store.dispatch({ type: "move", panels: ["files"], target: { region: "right" } });
    store.dispatch({ type: "resize", region: "left", size: 350 });
    expect(storage.writes).toHaveLength(before);
    unsubscribe();
    const count = notifications;
    openGit(store);
    expect(notifications).toBe(count);
  });

  it("has 20 undo entries per scope, excludes browsing/focus, and persists undo without saving history", () => {
    const { store, storage } = setup();
    for (let index = 1; index <= 25; index++) store.dispatch({ type: "resize", region: "left", size: 272 + index });
    store.dispatch({ type: "activate", groupId: "right-main", panel: "git" });
    store.dispatch({ type: "raise", groupId: "not-a-float" });
    store.switchScope(b, false);
    expect(store.getSnapshot().canUndo).toBe(false);
    openGit(store);
    store.undo();
    expect(layout(store)).toEqual(createDefaultLayout());
    store.switchScope(a, false);
    for (let index = 0; index < 20; index++) store.undo();
    expect(layout(store).left.width).toBe(277);
    expect(store.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true });
    store.undo();
    expect(layout(store).left.width).toBe(277);
    for (let index = 0; index < 20; index++) store.redo();
    expect(layout(store).left.width).toBe(297);
    expect(layout(store).right.groups[0]!.active).toBe("git");
    expect(store.getSnapshot().canRedo).toBe(false);
    store.undo();
    store.dispatch({ type: "hide", panels: ["files"] });
    expect(store.getSnapshot().canRedo).toBe(false);
    store.flush();
    const restored = new DockStore(storage);
    restored.switchScope(a, false);
    expect(layout(restored)).toEqual(layout(store));
    expect(restored.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it("preserves tab selection and float raising without offering an undo step", () => {
    const { store, storage } = setup();
    store.dispatch({ type: "activate", groupId: "right-main", panel: "git" });
    expect(store.getSnapshot().canUndo).toBe(false);
    store.flush();
    expect(storage.writes).toHaveLength(1);
    store.dispatch({ type: "open", panel: "btw" });
    store.dispatch({ type: "move", panels: ["files"], target: { region: "float" } });
    const id = layout(store).floats[0]!.id;
    store.dispatch({ type: "raise", groupId: id });
    store.undo();
    expect(layout(store).floats).toHaveLength(1);
    expect(layout(store).left.panels).toContain("files");
  });

  it("uses project then app defaults, never inheritance, for existing sessions without records", () => {
    const { store } = setup();
    openGit(store);
    store.updatePreferences({ appDefault: "focus", projectDefaults: { [dockProjectKey(a)]: "debug" }, inherit: true });
    store.switchScope(b, false);
    expect(layout(store)).toEqual(builtInPresets()[2]!.layout);
    store.switchScope(c, false);
    expect(layout(store).presetId).toBe("focus");
    expect(layout(store).right.visible).toBe(false);
    store.switchScope({ ...a, project: null, session: "unscoped" }, false);
    expect(layout(store).presetId).toBe("focus");
    // Browsing alone is not a commit: an unsaved session picks up a subsequently
    // changed project default when revisited, not a stale cache-only layout.
    store.updatePreferences({ projectDefaults: { [dockProjectKey(a)]: "focus" } });
    store.switchScope(b, false);
    expect(layout(store).presetId).toBe("focus");
  });

  it("drafts inherit only committed layouts from their project and transfer independent copies on creation", () => {
    const { store, storage } = setup();
    store.dispatch({ type: "move", panels: ["terminal"], target: { region: "left" } });
    const original = layout(store);
    store.updatePreferences({ inherit: true });
    const saved = [...storage.data.entries()];
    store.beginDraft(draft);
    expect(layout(store)).toEqual(original);
    expect(layout(store)).not.toBe(original);
    expect(store.getSnapshot().scope.draft).toBe(true);
    store.dispatch({ type: "card", panel: "terminal", height: 360, collapsed: true });
    expect([...storage.data.entries()]).toEqual(saved);
    const draftLayout = layout(store);
    store.adoptDraft(b);
    expect(store.getSnapshot().scope).toMatchObject({ ...b, draft: false });
    expect(layout(store)).toEqual(draftLayout);
    expect(store.getSnapshot().canUndo).toBe(true);
    store.switchScope(a, false);
    expect(layout(store)).toEqual(original);
    const reload = new DockStore(storage);
    reload.switchScope(b, false);
    expect(layout(reload)).toEqual(draftLayout);
    reload.updatePreferences({ inherit: false, appDefault: "focus" });
    reload.beginDraft({ ...draft, session: "branch-draft" });
    expect(layout(reload).presetId).toBe("focus");
  });

  it("draft edits and merely browsing sessions do not replace the project inheritance source", () => {
    const { store } = setup();
    openGit(store);
    const recent = layout(store);
    store.updatePreferences({ inherit: true });
    store.beginDraft(draft);
    store.dispatch({ type: "hide", panels: ["files"] });
    store.switchScope(b, false);
    expect(layout(store)).toEqual(createDefaultLayout());
    store.beginDraft({ ...draft, session: "draft-2" });
    expect(layout(store)).toEqual(recent);
    store.beginDraft({ ...draft, target: "remote", session: "remote-draft" });
    expect(layout(store)).toEqual(createDefaultLayout());
  });

  it("late draft adoption cannot overwrite whichever session the user switched to", () => {
    const { store } = setup();
    store.beginDraft(draft);
    openGit(store);
    const fromDraft = layout(store);
    store.switchScope(a, false);
    store.dispatch({ type: "hide", panels: ["files"] });
    const viewed = layout(store);
    store.adoptDraft(b);
    expect(store.getSnapshot().scope).toEqual(a);
    expect(layout(store)).toBe(viewed);
    store.switchScope(b, false);
    expect(layout(store)).toEqual(fromDraft);
    store.adoptDraft({ ...b, session: "unrelated" });
    expect(store.getSnapshot().scope).toEqual(b);
  });

  it("deleting a session removes disk state and undo without recreating it on scope switch", () => {
    const { store, storage } = setup();
    openGit(store);
    store.updatePreferences({ inherit: true });
    store.deleteSession(a);
    expect(layout(store)).toEqual(createDefaultLayout());
    expect(store.getSnapshot().canUndo).toBe(false);
    store.switchScope(b, false);
    store.switchScope(a, false);
    const reload = new DockStore(storage);
    reload.switchScope(a, false);
    expect(layout(reload)).toEqual(createDefaultLayout());
    reload.beginDraft(draft);
    expect(layout(reload)).toEqual(createDefaultLayout());
  });

  it("retains in-memory state if storage throws on reads/writes", () => {
    const blocked: Storage = { length: 0, key: () => null, getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("blocked"); }, clear: () => {} };
    const store = new DockStore(blocked);
    store.switchScope(a, false);
    openGit(store);
    store.switchScope(b, false);
    store.switchScope(a, false);
    expect(layout(store).right.groups[0]!.active).toBe("git");
    store.undo();
    expect(layout(store)).toEqual(createDefaultLayout());
    expect(new DockStore(null).getSnapshot().layout).toEqual(createDefaultLayout());
  });
});

describe("dock presets and preview", () => {
  it("saves, renames and updates custom templates without implicitly modifying them", () => {
    const { store, storage } = setup();
    openGit(store);
    const id = store.savePreset("  Review  ");
    expect(id).not.toBe("");
    expect(store.getSnapshot().modified).toBe(false);
    expect(store.getSnapshot().presets.find(preset => preset.id === id)?.name).toBe("Review");
    store.dispatch({ type: "hide", panels: ["files"] });
    expect(store.getSnapshot().modified).toBe(true);
    expect(store.getSnapshot().presets.find(preset => preset.id === id)?.layout.left.panels).toContain("files");
    store.renamePreset(id, "Ship review");
    store.updatePreset(id);
    expect(store.getSnapshot().modified).toBe(false);
    const template = store.getSnapshot().presets.find(preset => preset.id === id)!;
    store.resetFactory();
    expect(layout(store)).toEqual(createDefaultLayout());
    store.applyPreset(id);
    expect(layout(store)).toEqual(template.layout);
    store.dispatch({ type: "open", panel: "files" });
    store.resetPreset();
    expect(layout(store)).toEqual(template.layout);
    const reloaded = new DockStore(storage);
    reloaded.switchScope(a, false);
    expect(reloaded.getSnapshot().presets.find(preset => preset.id === id)?.name).toBe("Ship review");
    expect(layout(reloaded)).toEqual(template.layout);
  });

  it("keeps builtins immutable and makes preset application and factory reset undoable even locked", () => {
    const { store } = setup();
    store.updatePreset("default");
    store.renamePreset("debug", "Overwritten");
    store.deletePreset("focus");
    expect(store.getSnapshot().presets).toEqual(builtInPresets());
    expect(store.savePreset(" ")).toBe("");
    store.updatePreferences({ locked: true });
    store.applyPreset("debug");
    expect(layout(store).presetId).toBe("debug");
    store.resetFactory();
    expect(layout(store).presetId).toBe("default");
    store.undo();
    expect(layout(store).presetId).toBe("debug");
    store.undo();
    expect(layout(store).presetId).toBe("default");
    expect(store.getSnapshot().preferences.locked).toBe(true);
  });

  it("deleting presets preserves existing sessions while falling default references back to builtin", () => {
    const { store, storage } = setup();
    openGit(store);
    const id = store.savePreset("Review");
    const saved = layout(store);
    store.updatePreferences({ appDefault: id, projectDefaults: { [dockProjectKey(a)]: id } });
    store.deletePreset(id);
    expect(layout(store)).toBe(saved);
    expect(store.getSnapshot().preferences).toMatchObject({ appDefault: "default", projectDefaults: { [dockProjectKey(a)]: "default" } });
    expect(store.getSnapshot().modified).toBe(true);
    store.switchScope(b, false);
    expect(layout(store)).toEqual(createDefaultLayout());
    const reload = new DockStore(storage);
    reload.switchScope(a, false);
    expect(layout(reload)).toEqual(saved);
    reload.resetPreset();
    expect(layout(reload)).toEqual(createDefaultLayout());
  });

  it("isolates preview layout, history, drafts, defaults and custom presets with zero real writes", () => {
    const { store, storage } = setup();
    openGit(store);
    const id = store.savePreset("Real preset");
    store.updatePreferences({ inherit: true });
    const real = store.getSnapshot();
    const disk = [...storage.data.entries()];
    storage.writes = [];
    store.switchScope(a, true);
    store.dispatch({ type: "move", panels: ["terminal"], target: { region: "rail" } });
    store.updatePreferences({ appDefault: "debug", projectDefaults: { [dockProjectKey(a)]: "focus" }, locked: true, snap: false });
    const demoId = store.savePreset("Demo only");
    store.renamePreset(demoId, "Still demo");
    store.deletePreset(demoId);
    store.deleteSession(a);
    store.applyPreset("debug");
    store.beginDraft(draft);
    store.adoptDraft(b);
    store.undo();
    store.redo();
    store.resetFactory();
    expect(storage.writes).toEqual([]);
    expect([...storage.data.entries()]).toEqual(disk);
    store.switchScope(a, false);
    expect(layout(store)).toEqual(real.layout);
    expect(store.getSnapshot().preferences).toEqual(real.preferences);
    expect(store.getSnapshot().presets).toEqual(real.presets);
    expect(store.getSnapshot().presets.find(preset => preset.id === id)).toBeDefined();
    expect(store.getSnapshot().canUndo).toBe(real.canUndo);
    expect(storage.writes).toEqual([]);
    store.beginDraft({ ...draft, session: "real-draft" });
    expect(layout(store)).toEqual(real.layout);
  });

  it("a preview-only mount never writes even the migration marker", () => {
    const storage = new MemoryStorage();
    storage.data.set("omp.layoutMemory.global", JSON.stringify({ sidebarWidth: 300 }));
    const store = new DockStore(storage);
    store.switchScope(a, true);
    store.applyPreset("focus");
    store.savePreset("Demo");
    store.updatePreferences({ inherit: true });
    store.switchScope(b, true);
    expect(storage.writes).toEqual([]);
    expect(storage.length).toBe(1);
  });
});

describe("legacy layout migration", () => {
  it("migrates global/project layouts once into named presets, preserving old values and BTW geometry", () => {
    const storage = new MemoryStorage();
    const oldGlobal = JSON.stringify({ collapsed: true, sidebarWidth: 310, splitRatio: 0.63, sideOpen: true, sideTab: "git", panelWidth: 610, bottomVisible: true, bottomOpen: true, bottomHeight: 330, bottomTab: "terminal", explorerOpen: false, btwOpen: true, btwPlacement: "float", btwMinimized: true, btwX: 222, btwY: 165, btwW: 680, btwH: 450, btwCapX: 99, btwCapY: 60 });
    storage.data.set("omp.layoutMemory.global", oldGlobal);
    storage.data.set("omp.layoutMemory.project:sample", JSON.stringify({ sidebarWidth: 290, sideOpen: false, btwOpen: false, btwPlacement: "float", btwX: 100, btwY: 140, btwW: 570, btwH: 350 }));
    storage.data.set("omp.layoutMemory.broken", "{invalid");
    storage.data.set("omp.layoutMemory.empty", "{}");
    const store = new DockStore(storage);
    expect(storage.writes).toEqual([]);
    store.switchScope(a, false);
    expect(layout(store)).toEqual(createDefaultLayout());
    const presets = store.getSnapshot().presets.filter(preset => !preset.builtin);
    expect(presets).toHaveLength(2);
    const global = presets.find(preset => preset.name.includes("全局"))!;
    expect(global.layout).toMatchObject({ left: { visible: false, width: 310, ratio: 0.63, panels: ["files", "agents"] }, right: { visible: true, size: 610, groups: [{ active: "git" }] }, bottom: { visible: true, expanded: true, size: 330, groups: [{ active: "terminal" }] }, cards: { files: { collapsed: true } }, floats: [{ rect: { x: 222, y: 165, width: 680, height: 450 }, minimized: true, panels: ["btw"] }] });
    const project = presets.find(preset => preset.name.includes("project:sample"))!;
    expect(project.layout.hidden.btw).toMatchObject({ region: "float", rect: { x: 100, y: 140, width: 570, height: 350 } });
    expect(JSON.stringify(project.layout)).not.toContain("project:sample");
    expect(storage.getItem("omp.layoutMemory.global")).toBe(oldGlobal);
    expect(storage.writes.every(key => !key.startsWith("omp.layoutMemory."))).toBe(true);
    store.deletePreset(global.id);
    const reload = new DockStore(storage);
    reload.switchScope(b, false);
    expect(reload.getSnapshot().presets.filter(preset => !preset.builtin)).toHaveLength(1);
    expect(reload.getSnapshot().presets.some(preset => preset.id === global.id)).toBe(false);
    expect(layout(reload)).toEqual(createDefaultLayout());
  });

  it("restores old docked BTW to the right group without automatically opening the region", () => {
    const storage = new MemoryStorage();
    storage.data.set("omp.layoutMemory.global", JSON.stringify({ btwPlacement: "docked", sideTab: "btw", sideOpen: false }));
    const store = new DockStore(storage);
    const preset = store.getSnapshot().presets.find(preset => !preset.builtin)!;
    expect(preset.layout.floats).toEqual([]);
    expect(preset.layout.right).toMatchObject({ visible: false, groups: [{ active: "btw" }] });
    expect(locatePanel(preset.layout, "btw")?.region).toBe("right");
  });
});

describe("dock persistence batching", () => {
  it("writes once for a burst of dispatches and reads back after a flush", () => {
    const { store, storage } = setup();
    for (let index = 0; index < 40; index++) store.dispatch({ type: "resize", region: "left", size: 240 + index });
    expect(storage.writes).toEqual([]);
    const resized = layout(store);
    store.flush();
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]).toBe("omp.dock.v1");
    const reload = new DockStore(storage);
    reload.switchScope(a, false);
    expect(layout(reload)).toEqual(resized);
  });

  it("lands the batch window on its own", () => {
    vi.useFakeTimers();
    try {
      const { store, storage } = setup();
      store.dispatch({ type: "resize", region: "left", size: 300 });
      store.dispatch({ type: "resize", region: "left", size: 320 });
      expect(storage.writes).toEqual([]);
      vi.advanceTimersByTime(400);
      expect(storage.writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes before a scope change, a draft handoff and a page hide", () => {
    const { store, storage } = setup();
    store.dispatch({ type: "move", panels: ["terminal"], target: { region: "left" } });
    const moved = layout(store);
    store.switchScope(b, false);
    expect(storage.writes.length).toBeGreaterThan(0);
    store.switchScope(a, false);
    expect(layout(store)).toEqual(moved);
    store.dispatch({ type: "resize", region: "left", size: 300 });
    store.beginDraft(draft);
    expect(storage.data.get("omp.dock.v1")).toContain('"width":300');
    store.switchScope(a, false);
    store.dispatch({ type: "resize", region: "left", size: 310 });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    delete (document as { hidden?: boolean }).hidden;
    expect(storage.data.get("omp.dock.v1")).toContain('"width":310');
    store.dispatch({ type: "resize", region: "left", size: 320 });
    window.dispatchEvent(new Event("pagehide"));
    expect(storage.data.get("omp.dock.v1")).toContain('"width":320');
  });
});

describe("dock storage failures", () => {
  it("retries once with a lean payload that keeps the current session", () => {
    const storage = new MemoryStorage();
    const store = new DockStore(storage);
    store.switchScope(a, false);
    storage.writes = [];
    store.dispatch({ type: "move", panels: ["git"], target: { region: "left" } });
    storage.failures = 1;
    store.flush();
    expect(storage.writes).toHaveLength(1);
    const reload = new DockStore(storage);
    reload.switchScope(a, false);
    expect(locatePanel(layout(reload), "git")?.region).toBe("left");
  });

  it("stops retrying after the lean payload also fails, and stays usable", () => {
    const storage = new MemoryStorage();
    const store = new DockStore(storage);
    store.switchScope(a, false);
    storage.failAll = true;
    storage.attempts = 0;
    store.dispatch({ type: "resize", region: "left", size: 300 });
    store.flush();
    expect(storage.attempts).toBe(2); // full payload, then the lean one
    for (let index = 0; index < 5; index++) store.dispatch({ type: "resize", region: "left", size: 300 + index });
    store.flush();
    expect(storage.attempts).toBe(2); // the session stopped writing after the first failure
    expect(layout(store).left.width).toBe(304);
    expect(store.getSnapshot().canUndo).toBe(true);
  });
});

describe("dock region events", () => {
  it("emits one omp:dock-region event per region action with the requested state", () => {
    const { store } = setup();
    const events: { region: string; visible: boolean }[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<{ region: string; visible: boolean }>).detail);
    window.addEventListener("omp:dock-region", listener);
    try {
      store.dispatch({ type: "region", region: "right", visible: true });
      store.dispatch({ type: "region", region: "rail", visible: false });
      store.dispatch({ type: "railMode", mode: "compact" });
      store.dispatch({ type: "bottomExpanded", expanded: true });
      store.dispatch({ type: "open", panel: "git" });
    } finally {
      window.removeEventListener("omp:dock-region", listener);
    }
    expect(events).toEqual([{ region: "right", visible: true }, { region: "rail", visible: false }]);
    expect(store.getSnapshot().layout.right.visible).toBe(true);
    expect(store.getSnapshot().layout.rail.mode).toBe("compact");
  });
});

describe("dock auto-collapse and history", () => {
  it("undo restores the region a move collapsed, redo collapses it again", () => {
    const { store } = setup();
    const panels = layout(store).right.groups[0]!.panels;
    store.dispatch({ type: "region", region: "right", visible: true });
    const opened = layout(store);
    store.dispatch({ type: "move", panels, target: { region: "bottom" } });
    expect(layout(store).right).toMatchObject({ visible: false, groups: [] });
    store.undo();
    expect(layout(store)).toEqual(opened);
    expect(layout(store).right.visible).toBe(true);
    store.redo();
    expect(layout(store).right).toMatchObject({ visible: false, groups: [] });
  });

  it("keeps the menu state and the layout in agreement after a hidden empty region", () => {
    const { store } = setup();
    const panels = layout(store).right.groups[0]!.panels;
    store.dispatch({ type: "region", region: "right", visible: true });
    store.dispatch({ type: "hide", panels });
    // The View menu renders `checked={layout[region].visible}`, so the collapsed
    // region reads as unchecked and can be reopened into its empty state.
    expect(layout(store).right.visible).toBe(false);
    store.dispatch({ type: "region", region: "right", visible: true });
    expect(layout(store).right).toMatchObject({ visible: true, groups: [] });
    store.dispatch({ type: "region", region: "right", visible: false });
    expect(layout(store).right.visible).toBe(false);
  });
});
