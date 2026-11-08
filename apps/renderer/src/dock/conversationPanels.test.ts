import { afterEach, describe, expect, it } from "vitest";
import { DockStore } from "./store";
import { WorkbenchWindows } from "./windows";
import { conversationPanelId } from "./types";
import { instancePresetLayout, locatePanel } from "./model";

afterEach(() => { window.dispatchEvent(new Event("pagehide")); localStorage.clear(); });

function setup(storage: Storage | null = null) {
  const manager = new WorkbenchWindows();
  manager.register({ id: "view-a", content: { kind: "conversation", documentId: "a" }, title: "Conversation A", minimum: { width: 360, height: 280 }, placement: "float", pin: "none", minimized: false, maximized: false, rect: { x: 80, y: 60, width: 720, height: 560 } });
  const dock = new DockStore(storage).fork({ target: "local", project: "project", session: "session-a" });
  dock.bindWindows(manager, "a", "Conversation A");
  return { dock, manager, panel: conversationPanelId("view-a") };
}

describe("conversation docking", () => {
  it.each(["left", "right", "bottom"] as const)("uses the %s region and restores the remembered window geometry", region => {
    const { dock, manager, panel } = setup();
    const rect = manager.get("view-a")!.rect;
    dock.dispatch({ type: "move", panels: [panel], target: { region } });
    expect(locatePanel(dock.getSnapshot().layout, panel)?.region).toBe(region);
    expect(manager.get("view-a")?.placement).toBe("docked");
    expect(manager.getSnapshot().records).toHaveLength(1);
    dock.dispatch({ type: "move", panels: [panel], target: { region: "float", rect } });
    expect(manager.get("view-a")).toMatchObject({ placement: "float", rect });
    expect(dock.getSnapshot().layout.floats.filter(group => group.panels.includes(panel))).toHaveLength(1);
    expect(manager.getSnapshot().records).toHaveLength(1);
  });
  it("keeps a conversation and tool in one floating group and detaches the original conversation", () => {
    const { dock, manager, panel } = setup();
    dock.dispatch({ type: "move", panels: ["terminal"], target: { region: "float" } });
    const group = dock.getSnapshot().layout.floats.find(group => group.panels.includes("terminal"))!;
    dock.dispatch({ type: "move", panels: [panel], target: { region: "float", groupId: group.id } });
    expect(dock.getSnapshot().layout.floats.find(value => value.id === group.id)?.panels).toEqual(["terminal", panel]);
    expect(manager.get("view-a")?.placement).toBe("docked");
    dock.dispatch({ type: "move", panels: [panel], target: { region: "float" } });
    expect(manager.get("view-a")?.placement).toBe("float");
    expect(dock.getSnapshot().layout.floats.filter(group => group.panels.includes(panel))).toHaveLength(1);
    expect(dock.getSnapshot().layout.floats.find(value => value.id === group.id)?.panels).toEqual(["terminal"]);
  });
  it("does not put conversation identities into presets or nest a conversation in its own tool column", () => {
    const { dock, manager, panel } = setup();
    dock.dispatch({ type: "move", panels: [panel], target: { region: "rail" } });
    expect(manager.get("view-a")?.placement).toBe("float");
    dock.dispatch({ type: "move", panels: [panel], target: { region: "bottom" } });
    const preset = instancePresetLayout(dock.getSnapshot().layout);
    expect(locatePanel(preset, panel)).toBeUndefined();
    expect(preset.cards[panel]).toBeUndefined();
  });
  it("can merge a tool into a conversation window without registering a duplicate window", () => {
    const { dock, manager, panel } = setup();
    dock.dispatch({ type: "move", panels: ["terminal"], target: { region: "float", groupId: panel } });
    const group = dock.getSnapshot().layout.floats.find(group => group.panels.includes(panel))!;
    expect(group.panels).toEqual([panel, "terminal"]);
    expect(manager.get("view-a")?.placement).toBe("docked");
    expect(manager.get(dock.windowId(group.id))?.content.kind).toBe("tools");
    dock.dispatch({ type: "move", panels: [panel], target: { region: "float" } });
    expect(manager.get("view-a")?.placement).toBe("float");
    expect(dock.getSnapshot().layout.floats).toHaveLength(2);
    expect(new Set(dock.getSnapshot().layout.floats.map(group => group.id)).size).toBe(2);
  });
  it("undoes and redoes docking without losing the conversation view", () => {
    const { dock, manager, panel } = setup();
    dock.dispatch({ type: "move", panels: [panel], target: { region: "right" } });
    dock.undo();
    expect(manager.get("view-a")?.placement).toBe("float");
    expect(locatePanel(dock.getSnapshot().layout, panel)?.region).toBe("float");
    dock.redo();
    expect(manager.get("view-a")?.placement).toBe("docked");
    expect(locatePanel(dock.getSnapshot().layout, panel)?.region).toBe("right");
  });
  it("restores conversation tab placement alongside the saved window layout", () => {
    const { dock, manager, panel } = setup(localStorage);
    dock.dispatch({ type: "move", panels: [panel], target: { region: "bottom" } });
    dock.flush();
    const restoredManager = new WorkbenchWindows();
    restoredManager.restore(JSON.parse(JSON.stringify(manager.getSnapshot())));
    const restoredDock = new DockStore(localStorage).fork({ target: "local", project: "project", session: "session-a" });
    restoredDock.bindWindows(restoredManager, "a", "Conversation A");
    expect(locatePanel(restoredDock.getSnapshot().layout, panel)?.region).toBe("bottom");
    expect(restoredDock.getSnapshot().layout.bottom.groups[0]?.active).toBe(panel);
    expect(restoredManager.getSnapshot().records).toHaveLength(1);
  });
  it("removes a closed conversation from a pinned group while keeping the tool", () => {
    const { dock, manager, panel } = setup();
    dock.dispatch({ type: "move", panels: ["terminal"], target: { region: "float", groupId: panel } });
    const group = dock.getSnapshot().layout.floats.find(group => group.panels.includes(panel))!;
    dock.setPin(group.id, "application");
    dock.removeConversationPanel("view-a");
    manager.remove("view-a");
    expect(dock.getSnapshot().layout.floats).toHaveLength(1);
    expect(dock.getSnapshot().layout.floats[0]).toMatchObject({ panels: ["terminal"], pin: { mode: "application" } });
    expect(locatePanel(dock.getSnapshot().layout, panel)).toBeUndefined();
  });
});
