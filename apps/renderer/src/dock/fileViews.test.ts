import { describe, it, expect } from "vitest";
import { DockStore } from "./store";
import { createDefaultLayout, dockReducer, instancePresetLayout, applyInstancePreset, locatePanel, normalizeLayout } from "./model";
import type { FilePanelDescriptor, FilePanelId } from "./types";

const panel: FilePanelId = "file-view:readme";
const descriptor: FilePanelDescriptor = { targetId: null, workspaceId: "project", path: "README.md", fileId: "file-a", title: "README.md", scope: "conversation" };
describe("file windows", () => {
  it("opens once as a float, can dock, and removes a closed file instead of hiding it", () => {
    let layout = dockReducer(createDefaultLayout(), { type: "file-open", panel, descriptor });
    layout = dockReducer(layout, { type: "file-open", panel, descriptor });
    expect(layout.floats.filter(group => group.panels.includes(panel))).toHaveLength(1);
    layout = dockReducer(layout, { type: "move", panels: [panel], target: { region: "bottom" } });
    expect(locatePanel(normalizeLayout(layout), panel)?.region).toBe("bottom");
    layout = dockReducer(layout, { type: "file-close", panels: [panel] });
    expect(locatePanel(layout, panel)).toBeUndefined(); expect(layout.fileViews[panel]).toBeUndefined(); expect(layout.hidden[panel]).toBeUndefined(); expect(layout.floats.every(group => group.panels.length > 0)).toBe(true);
  });
  it("keeps open files when applying presets without putting paths in a saved preset", () => {
    const current = dockReducer(createDefaultLayout(), { type: "file-open", panel, descriptor });
    const preset = instancePresetLayout(current);
    expect(preset.fileViews).toEqual({}); expect(JSON.stringify(preset)).not.toContain("README.md");
    expect(locatePanel(applyInstancePreset(preset, current), panel)?.region).toBe("float");
  });
  it("restores workspace pinned files with their descriptors and closes them from the pin", () => {
    const store = new DockStore(null);
    store.switchScope({ target: "local", project: "project", session: "a" }, false);
    store.dispatch({ type: "file-open", panel, descriptor });
    store.setPin(store.getSnapshot().layout.floats[0]!.id, "workspace");
    expect(store.getSnapshot().layout.fileViews[panel]?.scope).toBe("workspace");
    store.switchScope({ target: "local", project: "project", session: "b" }, false);
    expect(store.getSnapshot().layout.fileViews[panel]?.path).toBe("README.md");
    store.dispatch({ type: "file-close", panels: [panel] });
    expect(locatePanel(store.getSnapshot().layout, panel)).toBeUndefined();
    store.switchScope({ target: "local", project: "project", session: "a" }, false);
    expect(store.getSnapshot().layout.fileViews[panel]).toBeUndefined();
  });
  it("does not reopen a closed file when undoing an earlier layout move", () => {
    const store = new DockStore(null);
    store.dispatch({ type: "file-open", panel, descriptor });
    store.dispatch({ type: "move", panels: [panel], target: { region: "bottom" } });
    store.dispatch({ type: "file-close", panels: [panel] });
    store.undo();
    expect(store.getSnapshot().layout.fileViews[panel]).toBeUndefined();
    expect(locatePanel(store.getSnapshot().layout, panel)).toBeUndefined();
  });
});
