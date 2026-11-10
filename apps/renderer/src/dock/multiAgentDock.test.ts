import { describe, expect, it } from "vitest";
import { agentPresetLayout, createDefaultLayout, dockReducer, locatePanel, normalizeLayout } from "./model";
import { DockStore } from "./store";
import { agentPanelId, type DockLayout } from "./types";

const scope = JSON.stringify(["local", "project", "parent", false]);
const deps = agentPanelId(scope, "deps");
const preview = agentPanelId(scope, "preview");
const tests = agentPanelId(scope, "tests");
const open = (layout: DockLayout, agentId: string, toolCallId?: string) => dockReducer(layout, {
  type: "agent-open", panel: agentPanelId(scope, agentId), descriptor: { scope, target: { agentId, ...(toolCallId ? { toolCallId } : {}) } },
});

describe("multiple agent dock views", () => {
  it("replaces a visible legacy detail in its existing split without moving other tools", () => {
    let layout = dockReducer(createDefaultLayout(), { type: "open", panel: "changes" });
    layout = dockReducer(layout, { type: "open", panel: "agent-detail" });
    layout = dockReducer(layout, { type: "move", panels: ["agent-detail"], target: { region: "right", split: "after" } });
    const oldLocation = locatePanel(layout, "agent-detail");
    const otherPanels = [...layout.right.groups[0]!.panels];
    layout = open(layout, "deps");
    expect(locatePanel(layout, deps)?.groupId).toBe(oldLocation?.groupId);
    expect(layout.right.groups[0]!.panels).toEqual(otherPanels);
    expect(locatePanel(layout, "agent-detail")).toBeUndefined();
  });
  it("opens one view per target, restores its location, and puts new agents beside the last active one", () => {
    let layout = open(createDefaultLayout(), "deps", "delegate-1");
    layout = open(layout, "preview");
    expect(layout.right.groups[0]?.panels).toEqual(expect.arrayContaining([deps, preview]));
    layout = dockReducer(layout, { type: "move", panels: [deps], target: { region: "bottom" } });
    layout = open(layout, "deps");
    expect(locatePanel(layout, deps)?.region).toBe("bottom");
    expect(layout.agentPanels[deps]?.target.toolCallId).toBe("delegate-1");
    layout = open(layout, "tests");
    expect(locatePanel(layout, tests)?.groupId).toBe(locatePanel(layout, deps)?.groupId);
    layout = dockReducer(layout, { type: "hide", panels: [deps] });
    layout = open(layout, "deps", "delegate-2");
    expect(locatePanel(layout, deps)?.region).toBe("bottom");
    expect(layout.agentPanels[deps]?.target.toolCallId).toBe("delegate-2");
    expect(Object.keys(layout.agentPanels)).toHaveLength(3);
  });

  it("restores dynamic identities and locations after persistence, isolated by parent scope", () => {
    const storage = window.localStorage;
    storage.clear();
    const first = { target: "local", project: "project", session: "parent" };
    const second = { ...first, session: "other" };
    const store = new DockStore(storage);
    store.switchScope(first, false);
    store.dispatch({ type: "agent-open", panel: deps, descriptor: { scope, target: { agentId: "deps" } } });
    store.dispatch({ type: "move", panels: [deps], target: { region: "bottom" } });
    store.flush();
    store.switchScope(second, false);
    expect(Object.keys(store.getSnapshot().layout.agentPanels)).toEqual([]);
    const reload = new DockStore(storage);
    reload.switchScope(first, false);
    expect(locatePanel(reload.getSnapshot().layout, deps)?.region).toBe("bottom");
    expect(reload.getSnapshot().layout.agentPanels[deps]?.target.agentId).toBe("deps");
    expect(normalizeLayout(JSON.parse(JSON.stringify(reload.getSnapshot().layout))).agentPanels[deps]?.target.agentId).toBe("deps");
    storage.clear();
  });


  it("saves a generic preset anchor and applies it to existing agent views", () => {
    const store = new DockStore(null);
    store.switchScope({ target: "local", project: "project", session: "parent" }, false);
    for (const agentId of ["deps", "preview"]) store.dispatch({ type: "agent-open", panel: agentPanelId(scope, agentId), descriptor: { scope, target: { agentId } } });
    store.dispatch({ type: "move", panels: [preview], target: { region: "bottom" } });
    store.dispatch({ type: "agent-focus", panel: preview });
    const preset = store.savePreset("agents at bottom");
    const saved = store.getSnapshot().presets.find(item => item.id === preset)!;
    expect(Object.keys(saved.layout.agentPanels)).toEqual([]);
    expect(locatePanel(saved.layout, "agent-detail")?.region).toBe("bottom");
    expect(JSON.stringify(saved.layout)).not.toContain("deps");
    store.applyPreset("default");
    expect(locatePanel(store.getSnapshot().layout, deps)?.region).toBe("right");
    expect(locatePanel(store.getSnapshot().layout, preview)?.region).toBe("right");
    store.applyPreset(preset);
    expect(locatePanel(store.getSnapshot().layout, deps)?.region).toBe("bottom");
    expect(locatePanel(store.getSnapshot().layout, preview)?.region).toBe("bottom");
    expect(Object.keys(agentPresetLayout(store.getSnapshot().layout).agentPanels)).toEqual([]);
  });
});
