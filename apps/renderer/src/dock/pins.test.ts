import { afterEach, describe, expect, it } from "vitest";
import { DockStore } from "./store";
import { locatePanel } from "./model";
import { agentPanelId, type DockScope, type PanelId } from "./types";

const first: DockScope = { target: "local", project: "one", session: "a" };
afterEach(() => window.dispatchEvent(new Event("pagehide")));
const second = { ...first, session: "b" };
const other = { ...first, project: "two", session: "c" };
function setup() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); }, clear: () => data.clear(), key: (index: number) => [...data.keys()][index] ?? null, get length() { return data.size; } } satisfies Storage;
  const store = new DockStore(storage); store.switchScope(first, false);
  const float = (panels: PanelId[] = ["files"]) => {
    store.dispatch({ type: "move", panels, target: { region: "float", rect: { x: 90, y: 70, width: 580, height: 440 } } });
    return store.getSnapshot().layout.floats.find(group => group.panels.includes(panels[0]!))!;
  };
  return { store, storage, data, float };
}
const pinned = (store: DockStore) => store.getSnapshot().layout.floats.filter(group => group.pin);

describe("floating window pin behavior", () => {
  it("remembers separate workspace pins for the same tool without replacing the other workspace", () => {
    const { store, storage, float } = setup();
    store.setPin(float().id, "workspace"); const a = pinned(store)[0]!.id;
    store.switchScope(other, false);
    store.setPin(float().id, "workspace"); const b = pinned(store)[0]!.id;
    store.dispatch({ type: "float", groupId: b, rect: { x: 120, y: 80, width: 600, height: 450 } });
    store.flush();
    const restored = new DockStore(storage); restored.switchScope(first, false);
    expect(pinned(restored)[0]?.id).toBe(a);
    restored.switchScope(other, false); expect(pinned(restored)[0]?.id).toBe(b);
    restored.dispatch({ type: "hide", panels: ["files"] });
    restored.switchScope(first, false); expect(pinned(restored)[0]?.id).toBe(a);
    restored.flush();
  });
  it("preserves multiple Agent identities and incoming Agent tabs across pin scopes and restart", () => {
    const { store, storage, float } = setup();
    const scout = agentPanelId("source-a", "scout"), reviewer = agentPanelId("source-a", "reviewer");
    for (const [panel, name] of [[scout, "scout"], [reviewer, "reviewer"]] as const) store.dispatch({ type: "agent-open", panel, descriptor: { scope: "source-a", target: { agentId: name, parentSessionId: "parent-a" } } });
    store.setPin(float([scout]).id, "application");
    const id = pinned(store)[0]!.id;
    store.dispatch({ type: "move", panels: [reviewer], target: { region: "float", groupId: id } });
    store.setPin(id, "window"); store.flush();
    const restored = new DockStore(storage); restored.switchScope(other, false);
    expect(pinned(restored)[0]?.panels).toEqual([scout, reviewer]);
    expect(restored.getSnapshot().layout.agentPanels[scout]?.target.agentId).toBe("scout");
    expect(restored.getSnapshot().layout.agentPanels[reviewer]?.target.agentId).toBe("reviewer");
    restored.setPin(id, "none");
    expect(restored.getSnapshot().layout.floats.find(group => group.id === id)?.panels).toEqual([scout, reviewer]);
    restored.flush();
  });
  it("keeps a workspace group across sessions and restores it when returning from another workspace", () => {
    const { store, float } = setup();
    store.setPin(float(["files", "git"]).id, "workspace");
    const group = pinned(store)[0]!;
    store.switchScope(second, false);
    expect(pinned(store)).toEqual([group]);
    expect(store.getSnapshot().layout.left.panels).not.toContain("files");
    store.switchScope(other, false);
    expect(pinned(store)).toEqual([]);
    expect(locatePanel(store.getSnapshot().layout, "files")?.region).toBe("left");
    store.switchScope(first, false);
    expect(pinned(store)).toEqual([group]);
  });
  it("keeps global pins across execution targets, presets and restarts without copying a tool", () => {
    const { store, storage, float } = setup();
    store.setPin(float().id, "application");
    const id = pinned(store)[0]!.id;
    store.switchScope({ target: "ssh:host", project: "remote", session: "d" }, false);
    store.applyPreset("debug"); store.resetPreset();
    expect(pinned(store)[0]?.id).toBe(id);
    expect(store.getSnapshot().layout.left.panels).not.toContain("files");
    store.flush();
    const restored = new DockStore(storage); restored.switchScope(first, false);
    expect(pinned(restored)[0]?.id).toBe(id);
  });
  it("minimizes without unpinning, but close cancels pin and does not reopen a system window", () => {
    const { store, storage, float } = setup();
    store.setPin(float().id, "topmost");
    const id = pinned(store)[0]!.id;
    store.dispatch({ type: "float", groupId: id, minimized: true });
    expect(pinned(store)[0]?.minimized).toBe(true);
    store.dispatch({ type: "open", panel: "files" });
    expect(pinned(store)[0]?.minimized).toBe(false);
    store.dispatch({ type: "hide", panels: ["files"] }); store.flush();
    expect(pinned(store)).toEqual([]);
    const restored = new DockStore(storage); restored.switchScope(first, false);
    restored.dispatch({ type: "open", panel: "files" });
    expect(pinned(restored)).toEqual([]);
    expect(locatePanel(restored.getSnapshot().layout, "files")).toBeDefined();
  });
  it("unpins docked tabs while the rest of the group stays pinned and incoming tabs inherit", () => {
    const { store, float } = setup();
    store.setPin(float(["files", "git"]).id, "application");
    const id = pinned(store)[0]!.id;
    store.dispatch({ type: "move", panels: ["files"], target: { region: "left" } });
    expect(pinned(store)[0]?.panels).toEqual(["git"]);
    expect(locatePanel(store.getSnapshot().layout, "files")?.region).toBe("left");
    store.dispatch({ type: "move", panels: ["terminal"], target: { region: "float", groupId: id } });
    expect(pinned(store)[0]?.panels).toEqual(["git", "terminal"]);
    store.switchScope(second, false);
    expect(pinned(store)[0]?.panels).toEqual(["git", "terminal"]);
    expect(store.getSnapshot().layout.bottom.groups.flatMap(group => group.panels)).not.toContain("terminal");
  });
  it("returns an independent group to the current session and keeps separate native geometry", () => {
    const { store, float } = setup();
    const initial = float(["files", "git"]);
    store.setPin(initial.id, "window");
    const id = pinned(store)[0]!.id;
    const rect = { x: 1600, y: 100, width: 800, height: 600 };
    store.setNativeState(id, { rect, minimized: false, maximized: false });
    store.setPin(id, "topmost");
    expect(pinned(store)[0]?.pin?.windowRect).toEqual(rect);
    expect(pinned(store)[0]?.rect).toEqual(initial.rect);
    store.switchScope(second, false); store.setPin(id, "none");
    expect(pinned(store)).toEqual([]);
    expect(store.getSnapshot().layout.floats.find(group => group.id === id)?.panels).toEqual(initial.panels);
  });
  it("isolates demo pins and geometry without writing real storage", () => {
    const { store, storage, data, float } = setup();
    store.setPin(float().id, "application"); store.flush();
    const saved = storage.getItem("omp.dock.v1");
    store.switchScope({ ...first, session: "demo" }, true);
    store.setPin(float(["git"]).id, "window"); store.flush();
    expect(storage.getItem("omp.dock.v1")).toBe(saved);
    expect(pinned(store)[0]?.panels).toEqual(["git"]);
    store.switchScope(first, false);
    expect(pinned(store)[0]?.panels).toEqual(["files"]);
    expect(data.size).toBeGreaterThan(0);
  });
});
