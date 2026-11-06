import { describe, expect, it } from "vitest";
import { ConversationWorkspaceStore } from "../conversationWorkspace/store";
import { DockStore } from "./store";
import { snapCells, snapDividers, resizeSnapTree, windowSnapHit, SNAP_TEMPLATES, snapTemplateFits, snapTree } from "./snap";

const ref = (name: string) => ({ targetId: null, workspaceId: "workspace", sessionId: name, historyId: name });
function setup() {
  const workspace = new ConversationWorkspaceStore(null);
  workspace.setGeometry({ x: 0, y: 40, width: 1600, height: 960 }, { x: 260, y: 80, width: 1200, height: 800 });
  const first = workspace.open(ref("A"));
  const dock = new DockStore(null);
  dock.switchScope({ target: "local", project: "workspace", session: "A" }, false);
  dock.bindWindows(workspace.manager, workspace.documentFor(first)!.id, "A");
  return { workspace, manager: workspace.manager, first, dock };
}
function floatTool(dock: DockStore, panel: "changes" | "terminal") {
  dock.dispatch({ type: "move", panels: [panel], target: { region: "float", rect: { x: 100, y: 120, width: 580, height: 480 } } });
  return dock.getSnapshot().layout.floats.find(group => group.panels.includes(panel))!;
}

describe("unified workbench windows", () => {
  it.each([
    { side: "left", bottom: false, template: "stack-left", cell: 0 },
    { side: "left", bottom: true, template: "stack-left", cell: 1 },
    { side: "right", bottom: false, template: "stack-right", cell: 1 },
    { side: "right", bottom: true, template: "stack-right", cell: 2 },
  ])("keeps main conversation full height when a tool first snaps to the $side corner (bottom=$bottom)", ({ side, bottom, template, cell }) => {
    const { manager, first, dock } = setup();
    const tool = floatTool(dock, "changes"), id = dock.windowId(tool.id);
    const canvas = manager.geometry.canvas;
    const target = windowSnapHit(canvas.x + (side === "left" ? 90 : canvas.width - 90), canvas.y + (bottom ? canvas.height - 90 : 90), canvas, manager.getSnapshot().snap, !!manager.mainConversation(id))!;
    expect(target).toMatchObject({ template, cell });
    if ("maximize" in target) throw new Error("Expected a corner");
    const original = manager.getSnapshot();
    const preview = manager.project(id, target);
    expect(manager.getSnapshot()).toBe(original);
    const mainCell = Number(Object.entries(preview.snap!.members).find(([, member]) => member === first)![0]);
    const cells = snapCells(preview.snap!.template, preview.snap!.tree, manager.size(preview.snap));
    expect(cells[mainCell]).toMatchObject({ y: 0, width: canvas.width / 2, height: canvas.height });
    expect(cells[cell]).toMatchObject({ width: canvas.width / 2, height: canvas.height / 2 });
    manager.snap(id, target);
    expect(manager.getSnapshot().snap).toEqual(preview.snap);
  });
  it("keeps explicit four-cell layouts and dragging the main conversation itself as quarter placements", () => {
    const { manager, first } = setup();
    const canvas = manager.geometry.canvas;
    const target = windowSnapHit(canvas.x + 90, canvas.y + 90, canvas, null, !!manager.mainConversation(first))!;
    expect(target).toEqual({ template: "quarters", cell: 0 });
    manager.snap(first, { template: "quarters", cell: 0 });
    expect(snapCells("quarters", manager.getSnapshot().snap!.tree, manager.size())[0]?.height).toBe(canvas.height / 2);
  });
  it("does not reuse an empty old snap group when a main conversation is arranged again", () => {
    const { workspace, manager, first, dock } = setup();
    manager.snap(first, { template: "stack-left", cell: 0 });
    workspace.dock(first);
    const tool = floatTool(dock, "changes"), id = dock.windowId(tool.id), canvas = manager.geometry.canvas;
    const target = windowSnapHit(canvas.x + canvas.width - 90, canvas.y + 90, canvas, manager.getSnapshot().snap, !!manager.mainConversation(id))!;
    expect(target).toMatchObject({ template: "stack-right", cell: 1 });
  });
  it("returns the only visible conversation to the standard layout for maximize", () => {
    const { workspace, manager, first } = setup();
    workspace.float(first);
    const minimized = workspace.open(ref("minimized"), "float");
    workspace.setWindow(minimized, { minimized: true });
    const native = workspace.open(ref("native"), "float");
    workspace.setPin(native, "window");
    manager.maximize(first);
    expect(manager.get(first)).toMatchObject({ placement: "main", maximized: false });
    expect(workspace.documentFor(first)?.ref.sessionId).toBe("A");
  });
  it("counts tool windows when maximizing and shares control state with Dock", () => {
    const { workspace, manager, first, dock } = setup();
    workspace.float(first);
    const tool = floatTool(dock, "changes"), id = dock.windowId(tool.id);
    manager.maximize(first);
    expect(manager.get(first)).toMatchObject({ placement: "float", maximized: true });
    manager.maximize(id);
    expect(dock.getSnapshot().layout.floats[0]?.maximized).toBe(true);
    dock.dispatch({ type: "float", groupId: tool.id, maximized: false });
    expect(manager.get(id)?.maximized).toBe(false);
  });
  it("extracts only the dragged tool tab before snapping and leaves its sibling in place", () => {
    const { manager, dock } = setup();
    const tool = floatTool(dock, "changes"), id = dock.windowId(tool.id);
    dock.dispatch({ type: "move", panels: ["terminal"], target: { region: "float", groupId: tool.id } });
    manager.snap(id, { template: "halves", cell: 0 });
    const extracted = dock.floatPanels(["terminal"], tool.id)!;
    expect(extracted).not.toBe(tool.id);
    manager.snap(dock.windowId(extracted), { template: "stack-left", cell: 0, splitSide: "left" });
    expect(dock.getSnapshot().layout.floats.find(group => group.id === tool.id)?.panels).toEqual(["changes"]);
    expect(dock.getSnapshot().layout.floats.find(group => group.id === extracted)?.panels).toEqual(["terminal"]);
    expect(manager.cell(id)).toBe(1);
    expect(manager.cell(dock.windowId(extracted))).toBe(0);
  });
  it("preserves partitions when pinning and returns native tools to their vacant partitions", () => {
    const { workspace, manager, first, dock } = setup();
    const tool = floatTool(dock, "changes"), id = dock.windowId(tool.id);
    manager.snap(id, { template: "halves", cell: 0 });
    workspace.setPin(first, "application");
    expect(manager.cell(first)).toBe(1);
    dock.setPin(tool.id, "application");
    expect(manager.cell(id)).toBe(0);
    manager.maximize(id);
    dock.setPin(tool.id, "window");
    expect(manager.cell(id)).toBeUndefined();
    expect(manager.get(id)).toMatchObject({ maximized: true, placement: "native" });
    dock.setPin(tool.id, "topmost");
    expect(manager.get(id)?.maximized).toBe(true);
    dock.setPin(tool.id, "none");
    expect(manager.cell(id)).toBe(0);
    expect(manager.get(id)).toMatchObject({ maximized: true, placement: "float", pin: "none" });
    expect(dock.getSnapshot().layout.floats.find(group => group.id === tool.id)?.pin).toBeUndefined();
  });
  it("places main A beside an incoming tool in one published layout and keeps ownership", () => {
    const { workspace, manager, first, dock } = setup();
    const tool = floatTool(dock, "changes"), id = dock.windowId(tool.id);
    const states: Array<ReturnType<typeof manager.getSnapshot>> = [];
    manager.subscribe(() => states.push(manager.getSnapshot()));
    manager.snap(id, { template: "halves", cell: 0 });
    expect(states).toHaveLength(1);
    expect(manager.getSnapshot().snap?.members).toEqual({ 0: id, 1: first });
    expect(workspace.getSnapshot().views[0]?.placement).toBe("float");
    expect(manager.get(id)?.content.documentId).toBe(workspace.documentFor(first)?.id);
    dock.setConversationTitle("A renamed");
    expect(manager.get(id)?.title).toContain(" · A renamed");
  });
  it("splits only the hit side, preserves the other side, then splits both sides into quarters", () => {
    const { workspace, manager, first } = setup();
    const second = workspace.open(ref("B"), "float"), third = workspace.open(ref("C"), "float"), fourth = workspace.open(ref("D"), "float");
    manager.snap(second, { template: "wide-left", cell: 1 });
    const leftHit = windowSnapHit(265, 85, manager.geometry.canvas, manager.getSnapshot().snap)!;
    expect(leftHit).toEqual({ template: "stack-left", cell: 0, splitSide: "left" });
    if ("maximize" in leftHit) throw new Error("Expected partition");
    manager.snap(third, leftHit);
    expect(manager.getSnapshot().snap?.members).toEqual({ 0: third, 1: first, 2: second });
    const leftTree = manager.getSnapshot().snap!.tree;
    expect("ratio" in leftTree && leftTree.ratio).toBe(2 / 3);
    const row = snapDividers("stack-left", leftTree, manager.size()).find(divider => divider.axis === "row")!;
    manager.resize(resizeSnapTree(leftTree, row, 0.65));
    const rightHit = windowSnapHit(1455, 875, manager.geometry.canvas, manager.getSnapshot().snap)!;
    if ("maximize" in rightHit) throw new Error("Expected partition");
    manager.snap(fourth, rightHit);
    expect(manager.getSnapshot().snap?.members).toEqual({ 0: third, 1: second, 2: first, 3: fourth });
    expect(snapDividers("quarters", manager.getSnapshot().snap!.tree, manager.size()).find(divider => divider.path === "0")?.ratio).toBe(0.65);
  });
  it.each([
    { template: "quarters" as const, occupied: 0, side: "right", result: "stack-left" },
    { template: "quarters" as const, occupied: 2, side: "right", result: "stack-left" },
    { template: "quarters" as const, occupied: 1, side: "left", result: "stack-right" },
    { template: "quarters" as const, occupied: 3, side: "left", result: "stack-right" },
    { template: "stack-left" as const, occupied: 1, side: "right", result: "stack-left" },
    { template: "stack-right" as const, occupied: 2, side: "left", result: "stack-right" },
  ])("preserves $template cell $occupied when a window fills the $side side", ({ template, occupied, side, result }) => {
    const { workspace, manager, first } = setup();
    manager.snap(first, { template, cell: occupied });
    workspace.resizeSnap({ columns: [0.6], row: 0.4 });
    const second = workspace.open(ref("B"), "float");
    const before = manager.getSnapshot(), layout = before.snap!;
    const rectangle = snapCells(layout.template, layout.tree, manager.size())[occupied];
    const bounds = manager.geometry.canvas;
    const target = windowSnapHit(bounds.x + (side === "right" ? bounds.width - 50 : 50), bounds.y + bounds.height / 2, bounds, layout)!;
    if ("maximize" in target) throw new Error("Expected a full-height side");
    const preview = manager.project(second, target);
    expect(manager.getSnapshot()).toBe(before);
    expect(preview.snap?.template).toBe(result);
    const preservedCell = Number(Object.entries(preview.snap!.members).find(([, id]) => id === first)![0]);
    const previewCells = snapCells(preview.snap!.template, preview.snap!.tree, manager.size(preview.snap));
    expect(previewCells[preservedCell]).toEqual(rectangle);
    expect(previewCells[target.cell]).toMatchObject({ y: 0, height: bounds.height });
    manager.snap(second, target);
    expect(manager.getSnapshot().snap).toEqual(preview.snap);
    expect(manager.get(first)?.content.documentId).toBe(workspace.documentFor(first)!.id);
  });
  it("fills one side with a tool without moving displaced windows into vacant cells on the other side", () => {
    const { workspace, manager, first, dock } = setup();
    manager.snap(first, { template: "quarters", cell: 2 });
    const second = workspace.open(ref("B"), "float"), third = workspace.open(ref("C"), "float");
    manager.snap(second, { template: "quarters", cell: 1 });
    manager.snap(third, { template: "quarters", cell: 3 });
    const secondRect = manager.get(second)!.rect, thirdRect = manager.get(third)!.rect;
    const tool = floatTool(dock, "terminal"), id = dock.windowId(tool.id);
    const bounds = manager.geometry.canvas;
    const target = windowSnapHit(bounds.x + bounds.width - 50, bounds.y + bounds.height / 2, bounds, manager.getSnapshot().snap)!;
    if ("maximize" in target) throw new Error("Expected a full-height side");
    manager.snap(id, target);
    expect(manager.getSnapshot().snap?.members).toEqual({ 1: first, 2: id });
    expect(manager.cell(second)).toBeUndefined();
    expect(manager.cell(third)).toBeUndefined();
    expect(manager.get(second)?.rect).toBe(secondRect);
    expect(manager.get(third)?.rect).toBe(thirdRect);
    expect(manager.get(id)?.content.documentId).toBe(workspace.documentFor(first)!.id);
  });
  it("still replaces the entire layout when two columns are explicitly selected", () => {
    const { workspace, manager, first } = setup();
    manager.snap(first, { template: "quarters", cell: 0 });
    const second = workspace.open(ref("B"), "float");
    manager.snap(second, { template: "halves", cell: 1 });
    expect(manager.getSnapshot().snap?.template).toBe("halves");
    expect(snapCells("halves", manager.getSnapshot().snap!.tree, manager.size())[manager.cell(first)!]?.height).toBe(manager.geometry.canvas.height);
  });
  it("restores displaced and detached tool geometry and frees minimized or docked cells", () => {
    const { workspace, manager, first, dock } = setup();
    const tool = floatTool(dock, "terminal"), id = dock.windowId(tool.id), free = manager.get(id)!.rect;
    manager.snap(id, { template: "halves", cell: 0 });
    const second = workspace.open(ref("B"), "float");
    manager.snap(second, { template: "halves", cell: 0 });
    expect(manager.cell(id)).toBeUndefined();
    expect(manager.get(id)?.rect).toEqual(free);
    manager.snap(id, { template: "stack-left", cell: 1 });
    dock.dispatch({ type: "float", groupId: tool.id, minimized: true });
    expect(manager.cell(id)).toBeUndefined();
    dock.dispatch({ type: "open", panel: "terminal" });
    expect(manager.cell(id)).toBe(1);
    dock.dispatch({ type: "move", panels: ["terminal"], target: { region: "bottom" } });
    expect(manager.get(id)).toBeUndefined();
    expect(manager.cell(id)).toBeUndefined();
    expect(manager.get(first)).toBeDefined();
  });
  it("resizes a mixed split tree using each tool minimum and scrolls without changing ratios", () => {
    const { manager, dock } = setup();
    const tool = floatTool(dock, "terminal"), id = dock.windowId(tool.id);
    manager.snap(id, { template: "stack-right", cell: 2 });
    const layout = manager.getSnapshot().snap!;
    const row = snapDividers(layout.template, layout.tree, manager.size()).find(divider => divider.axis === "row")!;
    manager.resize(resizeSnapTree(layout.tree, row, 0.9, manager.minimums()));
    const resized = manager.getSnapshot().snap!;
    const cells = snapCells(resized.template, resized.tree, manager.size());
    expect(cells[2]!.height).toBeGreaterThanOrEqual(282);
    const tree = resized.tree;
    manager.geometry.canvas = { x: 260, y: 80, width: 500, height: 300 };
    expect(manager.size().height).toBeGreaterThan(300);
    expect(manager.getSnapshot().snap!.tree).toBe(tree);
  });
  it("offers six valid templates including both mirrored three-window arrangements", () => {
    expect(SNAP_TEMPLATES).toHaveLength(6);
    for (const template of SNAP_TEMPLATES) {
      expect(snapTemplateFits(template, { width: 1440, height: 900 })).toBe(true);
      const cells = snapCells(template, snapTree(template), { width: 1440, height: 900 });
      expect(cells.reduce((area, rect) => area + rect.width * rect.height, 0)).toBe(1440 * 900);
    }
  });
  it("persists mixed windows once and restores their geometry independently of legacy Dock coordinates", () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } } as Storage;
    const workspace = new ConversationWorkspaceStore(storage);
    const first = workspace.open(ref("A")), owner = workspace.documentFor(first)!.id;
    const dock = new DockStore(storage);
    const scope = { target: "local", project: "workspace", session: "A" };
    dock.switchScope(scope, false);
    dock.bindWindows(workspace.manager, owner, "A");
    const group = floatTool(dock, "terminal"), id = dock.windowId(group.id);
    const rect = { x: 220, y: 150, width: 620, height: 510 };
    dock.dispatch({ type: "float", groupId: group.id, rect });
    workspace.manager.snap(id, { template: "halves", cell: 0 });
    workspace.flush(); dock.flush();
    const persistedDock = JSON.parse(memory.get("omp.dock.v1")!);
    const savedGroup = Object.values(persistedDock.sessions).flatMap((layout: any) => layout.floats).find((value: any) => value.id === group.id) as any;
    expect(savedGroup.rect).toBeUndefined();
    expect(savedGroup.windowId).toBe(id);
    const restored = new ConversationWorkspaceStore(storage), restoredDock = new DockStore(storage);
    restoredDock.switchScope(scope, false); restoredDock.bindWindows(restored.manager, owner, "A");
    expect(restored.manager.get(id)?.rect).toEqual(rect);
    expect(restored.getSnapshot().snap?.members).toEqual({ 0: id, 1: first });
    expect(restoredDock.getSnapshot().layout.floats.find(value => value.id === group.id)?.rect).toEqual(rect);
    restored.manager.float(id);
    expect(restoredDock.getSnapshot().layout.floats.find(value => value.id === group.id)?.rect).toEqual(rect);
  });
});
