import { describe, expect, it } from "vitest";
import { builtInPresets, clampFloat, createDefaultLayout, dockReducer, locatePanel, normalizeLayout } from "./model";
import { PANEL_IDS, type DockAction, type DockLayout } from "./types";

function expectSingletons(layout: DockLayout): void {
  const groups = [...layout.right.groups, ...layout.bottom.groups, ...layout.floats];
  const all = [...layout.left.panels, ...layout.rail.panels, ...groups.flatMap(group => group.panels), ...Object.keys(layout.hidden)];
  expect(all.slice().sort()).toEqual([...PANEL_IDS].sort());
  expect(layout.right.groups.length).toBeLessThanOrEqual(2);
  expect(layout.bottom.groups.length).toBeLessThanOrEqual(2);
  expect(new Set(groups.map(group => group.id)).size).toBe(groups.length);
  for (const group of groups) expect(group.panels).toContain(group.active);
}

function reduce(...actions: DockAction[]): DockLayout {
  return actions.reduce((layout, action) => dockReducer(layout, action), createDefaultLayout());
}

describe("dock layouts", () => {
  it("starts with Files, hidden Agents, collapsed right and Logs bottom, hidden BTW", () => {
    const layout = createDefaultLayout();
    expect(layout.left).toMatchObject({ visible: true, width: 272, ratio: 0.46, panels: ["files"] });
    expect(layout.rail).toMatchObject({ mode: "hidden", lastMode: "expanded", width: 320, panels: ["agents"] });
    expect(layout.right).toMatchObject({ visible: false, groups: [{ active: "changes", panels: ["changes", "git", "browser", "computer"] }] });
    expect(layout.bottom).toMatchObject({ visible: true, expanded: false, groups: [{ active: "logs" }] });
    expect(layout.floats).toEqual([]);
    expect(layout.hidden.btw?.region).toBe("float");
    expectSingletons(layout);
  });

  it("moves the whole Terminal module and reorders tabs without duplicating or mutating it", () => {
    const original = createDefaultLayout();
    const saved = JSON.stringify(original);
    let layout = dockReducer(original, { type: "move", panels: ["terminal"], target: { region: "right", groupId: "right-main", index: 1 } });
    expect(layout.right.groups[0]!.panels).toEqual(["changes", "terminal", "git", "browser", "computer"]);
    expect(layout.right.groups[0]!.active).toBe("terminal");
    expect(layout.bottom.groups[0]!.panels).not.toContain("terminal");
    layout = dockReducer(layout, { type: "move", panels: ["git"], target: { region: "right", groupId: "right-main", index: 5 } });
    expect(layout.right.groups[0]!.panels).toEqual(["changes", "terminal", "browser", "computer", "git"]);
    expect(JSON.stringify(original)).toBe(saved);
    expectSingletons(layout);
  });

  it("preserves source order and active tab when a whole group becomes cards or joins another group", () => {
    const cards = reduce({ type: "move", panels: ["computer", "git", "changes", "browser"], target: { region: "left" } });
    expect(cards.left.panels).toEqual(["files", "changes", "git", "browser", "computer"]);
    expect(cards.right.groups).toEqual([]);
    const merged = reduce({ type: "move", panels: ["computer", "git", "changes", "browser"], target: { region: "bottom", groupId: "bottom-main", index: 2 } });
    expect(merged.bottom.groups[0]!.panels).toEqual(["terminal", "problems", "changes", "git", "browser", "computer", "tests", "output", "logs", "pvlogs"]);
    expect(merged.bottom.groups[0]!.active).toBe("changes");
    expectSingletons(cards);
    expectSingletons(merged);
  });

  it("creates two equal groups, routes further edges to existing groups, and cleans empty groups", () => {
    let layout = reduce({ type: "move", panels: ["git"], target: { region: "right", groupId: "right-main", split: "after" } });
    expect(layout.right.groups.map(group => group.panels)).toEqual([["changes", "browser", "computer"], ["git"]]);
    expect(layout.right.ratio).toBe(0.5);
    layout = dockReducer(layout, { type: "move", panels: ["terminal"], target: { region: "right", split: "after" } });
    expect(layout.right.groups.map(group => group.panels)).toEqual([["changes", "browser", "computer"], ["git", "terminal"]]);
    const remainingId = layout.right.groups[1]!.id;
    layout = dockReducer(layout, { type: "resize", region: "right", ratio: 0.7 });
    layout = dockReducer(layout, { type: "move", panels: [...layout.right.groups[0]!.panels], target: { region: "right", groupId: remainingId } });
    expect(layout.right.groups).toHaveLength(1);
    expect(layout.right.ratio).toBe(0.5);
    expectSingletons(layout);
  });

  it("retains group identity on floating and remembers float geometry across hide/reopen", () => {
    const rect = { x: 100, y: 130, width: 710, height: 470 };
    let layout = reduce({ type: "move", panels: ["changes", "git", "browser", "computer"], target: { region: "float", rect } });
    expect(layout.floats[0]!.id).toBe("right-main");
    layout = dockReducer(layout, { type: "hide", panels: ["changes", "git", "browser", "computer"] });
    expect(layout.floats).toEqual([]);
    for (const panel of ["computer", "git", "changes", "browser"] as const) layout = dockReducer(layout, { type: "open", panel });
    expect(layout.floats).toHaveLength(1);
    expect(layout.floats[0]).toMatchObject({ rect, panels: ["changes", "git", "browser", "computer"], active: "browser" });
    expectSingletons(layout);
  });

  it("reopening a float tab keeps a surviving group's newer geometry and maximization", () => {
    let layout = reduce({ type: "move", panels: ["changes", "git"], target: { region: "float" } });
    const id = layout.floats[0]!.id;
    layout = dockReducer(layout, { type: "hide", panels: ["git"] });
    const rect = { x: 230, y: 180, width: 650, height: 510 };
    layout = dockReducer(layout, { type: "float", groupId: id, rect, maximized: true });
    layout = dockReducer(layout, { type: "open", panel: "git" });
    expect(layout.floats[0]).toMatchObject({ rect, maximized: true, panels: ["changes", "git"] });
  });

  it("restores separately hidden tabs in original order even when reopened backwards", () => {
    let layout = reduce({ type: "hide", panels: ["git"] }, { type: "hide", panels: ["browser"] });
    layout = dockReducer(layout, { type: "open", panel: "browser" });
    layout = dockReducer(layout, { type: "open", panel: "git" });
    expect(layout.right.groups[0]!.panels).toEqual(["changes", "git", "browser", "computer"]);
    expectSingletons(layout);
  });

  it("reopens into an existing region if a previous group no longer exists", () => {
    let layout = reduce({ type: "hide", panels: ["changes", "git", "browser", "computer"] });
    layout = dockReducer(layout, { type: "move", panels: ["terminal"], target: { region: "right" } });
    const id = layout.right.groups[0]!.id;
    layout = dockReducer(layout, { type: "open", panel: "git" });
    expect(layout.right.groups).toHaveLength(1);
    expect(locatePanel(layout, "git")).toMatchObject({ region: "right", groupId: id });
  });

  it("open finds the moved panel, expands cards, restores minimized floats and raises them", () => {
    let layout = reduce({ type: "move", panels: ["terminal"], target: { region: "left" } }, { type: "card", panel: "terminal", collapsed: true, height: 370 }, { type: "region", region: "left", visible: false });
    layout = dockReducer(layout, { type: "open", panel: "terminal" });
    expect(locatePanel(layout, "terminal")?.region).toBe("left");
    expect(layout.left.visible).toBe(true);
    expect(layout.cards.terminal).toEqual({ collapsed: false, height: 370 });
    layout = dockReducer(layout, { type: "open", panel: "btw" });
    const id = layout.floats[0]!.id;
    layout = dockReducer(layout, { type: "float", groupId: id, minimized: true, maximized: true });
    layout = dockReducer(layout, { type: "move", panels: ["terminal"], target: { region: "float" } });
    layout = dockReducer(layout, { type: "open", panel: "btw" });
    expect(layout.floats.at(-1)).toMatchObject({ id, minimized: false, maximized: true });
  });

  it("keeps card height and collapse preferences across moves", () => {
    const layout = reduce({ type: "card", panel: "files", height: 370, collapsed: true }, { type: "move", panels: ["files"], target: { region: "bottom" } }, { type: "move", panels: ["files"], target: { region: "rail" } });
    expect(layout.cards.files).toEqual({ collapsed: true, height: 370 });
    expect(layout.rail.mode).toBe("expanded");
  });

  it("restores the most recent non-hidden rail mode without cycling", () => {
    let layout = reduce({ type: "region", region: "rail", visible: true });
    expect(layout.rail.mode).toBe("expanded");
    layout = dockReducer(layout, { type: "railMode", mode: "compact" });
    layout = dockReducer(layout, { type: "region", region: "rail", visible: false });
    expect(layout.rail).toMatchObject({ mode: "hidden", lastMode: "compact" });
    expect(dockReducer(layout, { type: "open", panel: "agents" }).rail.mode).toBe("compact");
    expect(dockReducer(layout, { type: "region", region: "rail", visible: true }).rail.mode).toBe("compact");
  });

  it("locks movement and sizing but not browsing, hiding, reopening, folding or explicit presets", () => {
    const initial = reduce({ type: "open", panel: "btw" });
    const id = initial.floats[0]!.id;
    for (const action of [
      { type: "move", panels: ["git"], target: { region: "left" } },
      { type: "resize", region: "right", size: 620 },
      { type: "float", groupId: id, rect: { x: 20, y: 20, width: 650, height: 520 } },
      { type: "card", panel: "files", height: 390 },
    ] as DockAction[]) expect(dockReducer(initial, action, true)).toBe(initial);
    expect(dockReducer(initial, { type: "card", panel: "files", height: 390, collapsed: true }, true).cards.files).toEqual({ collapsed: true, height: null });
    expect(dockReducer(initial, { type: "activate", groupId: "right-main", panel: "git" }, true).right.groups[0]!.active).toBe("git");
    const hidden = dockReducer(initial, { type: "hide", panels: ["git"] }, true);
    expect(hidden.hidden.git).toBeDefined();
    expect(locatePanel(dockReducer(hidden, { type: "open", panel: "git" }, true), "git")).toBeDefined();
    expect(dockReducer(initial, { type: "float", groupId: id, minimized: true }, true).floats[0]!.minimized).toBe(true);
    expect(dockReducer(initial, { type: "apply", layout: builtInPresets()[1]!.layout }, true).presetId).toBe("focus");
  });

  it("treats empty/cancelled and unchanged operations as identity no-ops", () => {
    const layout = createDefaultLayout();
    for (const action of [
      { type: "move", panels: [], target: { region: "float" } },
      { type: "hide", panels: ["btw"] },
      { type: "activate", groupId: "right-main", panel: "changes" },
      { type: "resize", region: "left", size: 272 },
      { type: "apply", layout: createDefaultLayout() },
      { type: "raise", groupId: "missing" },
    ] as DockAction[]) expect(dockReducer(layout, action)).toBe(layout);
  });

  it("normalizes persisted layouts once while retaining recoverable panels", () => {
    expect(normalizeLayout({ version: 9 })).toEqual(createDefaultLayout());
    const layout = createDefaultLayout();
    const raw = { ...layout, left: { ...layout.left, panels: ["files", "unknown", "files"] }, right: { ...layout.right, groups: [{ id: "dup", panels: ["changes"], active: "git" }, { id: "dup", panels: ["git"] }, { panels: ["computer", "browser"] }] }, cards: { terminal: { height: 30 } } };
    const restored = normalizeLayout(raw);
    expectSingletons(restored);
    expect(restored.right.groups.map(group => group.panels)).toEqual([["changes"], ["git", "computer", "browser"]]);
    expect(restored.cards.terminal.height).toBe(240);
    expect(normalizeLayout(restored)).toEqual(restored);
    const partial = normalizeLayout({ version: 1 });
    expectSingletons(partial);
    expect(locatePanel(dockReducer(partial, { type: "open", panel: "terminal" }), "terminal")?.region).toBe("bottom");
  });

  it("ships independent default, focus and debugging templates", () => {
    const presets = builtInPresets();
    expect(presets.map(preset => preset.id)).toEqual(["default", "focus", "debug"]);
    expect(presets[1]!.layout).toMatchObject({ left: { visible: false }, rail: { mode: "hidden" }, right: { visible: false }, bottom: { visible: false }, floats: [] });
    expect(presets[2]!.layout.right.groups.map(group => group.active)).toEqual(["git", "changes"]);
    expect(presets[2]!.layout.bottom.groups.map(group => group.active)).toEqual(["terminal", "logs"]);
    for (const preset of presets) expectSingletons(preset.layout);
    presets[0]!.layout.cards.files.collapsed = true;
    expect(builtInPresets()[0]!.layout.cards.files.collapsed).toBe(false);
  });

  it("clamps effective float geometry into the workbench without rewriting preferences", () => {
    const rect = { x: -80, y: -200, width: 950, height: 840 };
    expect(clampFloat(rect, { x: 15, y: 80, width: 700, height: 600 })).toEqual({ x: 15, y: 80, width: 700, height: 600 });
    expect(clampFloat({ x: 900, y: 800, width: 100, height: 100 }, { width: 800, height: 700 }, 272)).toEqual({ x: 480, y: 428, width: 320, height: 272 });
    expect(clampFloat(rect, { width: 200, height: 100 })).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(rect).toEqual({ x: -80, y: -200, width: 950, height: 840 });
  });
});

describe("dock empty regions", () => {
  const rightPanels = createDefaultLayout().right.groups[0]!.panels;
  const bottomPanels = createDefaultLayout().bottom.groups[0]!.panels;

  it("collapses the right region when its last group leaves, keeping size and other regions", () => {
    let layout = reduce({ type: "region", region: "right", visible: true }, { type: "resize", region: "right", size: 620 });
    expect(layout.right.visible).toBe(true);
    layout = dockReducer(layout, { type: "move", panels: rightPanels, target: { region: "left" } });
    expect(layout.right).toMatchObject({ visible: false, size: 620, groups: [] });
    expect(layout.left.panels).toEqual(["files", ...rightPanels]);
    expect(layout.left.visible).toBe(true);
    expect(layout.bottom.visible).toBe(true);
    expectSingletons(layout);
  });

  it("collapses the bottom region when its last group leaves but keeps expansion and size", () => {
    let layout = reduce({ type: "bottomExpanded", expanded: true }, { type: "resize", region: "bottom", size: 320 });
    layout = dockReducer(layout, { type: "move", panels: bottomPanels, target: { region: "right" } });
    expect(layout.bottom).toMatchObject({ visible: false, expanded: true, size: 320, groups: [] });
    expect(layout.right.visible).toBe(true);
    expect(layout.right.groups[0]!.panels).toEqual(expect.arrayContaining(bottomPanels));
    expectSingletons(layout);
  });

  it("keeps a multi-module region open and ignores reordering inside one region", () => {
    let layout = reduce({ type: "region", region: "right", visible: true });
    layout = dockReducer(layout, { type: "move", panels: ["git"], target: { region: "left" } });
    expect(layout.right).toMatchObject({ visible: true, groups: [{ panels: ["changes", "browser", "computer"] }] });
    layout = dockReducer(layout, { type: "move", panels: ["problems"], target: { region: "left" } });
    expect(layout.bottom.visible).toBe(true);
    // A whole group re-enters the same region as a new group: move() empties the
    // old group halfway through, but the committed layout is never empty.
    let reordered = reduce({ type: "region", region: "right", visible: true });
    reordered = dockReducer(reordered, { type: "move", panels: rightPanels, target: { region: "right", groupId: "right-main", split: "after" } });
    expect(reordered.right.visible).toBe(true);
    expect(reordered.right.groups).toHaveLength(1);
    expect(reordered.right.groups[0]!.panels).toEqual(rightPanels);
  });

  it("collapses right and bottom when their last module is hidden", () => {
    let layout = reduce({ type: "region", region: "right", visible: true });
    layout = dockReducer(layout, { type: "hide", panels: rightPanels });
    expect(layout.right).toMatchObject({ visible: false, groups: [] });
    expect(layout.hidden.changes).toBeDefined();
    layout = dockReducer(layout, { type: "hide", panels: bottomPanels });
    expect(layout.bottom).toMatchObject({ visible: false, groups: [] });
    // Reopening one module brings its region back.
    layout = dockReducer(layout, { type: "open", panel: "git" });
    expect(layout.right.visible).toBe(true);
    expect(locatePanel(layout, "git")?.region).toBe("right");
    expectSingletons(layout);
  });

  it("shows an explicitly opened empty region until the user closes it again", () => {
    let layout = reduce({ type: "move", panels: rightPanels, target: { region: "left" } });
    expect(layout.right.visible).toBe(false);
    layout = dockReducer(layout, { type: "region", region: "right", visible: true });
    expect(layout.right).toMatchObject({ visible: true, groups: [] });
    // Unrelated commits must not close the empty state the user asked for.
    layout = dockReducer(layout, { type: "resize", region: "left", size: 300 });
    expect(layout.right.visible).toBe(true);
    expect(dockReducer(layout, { type: "open", panel: "git" }).right.visible).toBe(true);
    expect(dockReducer(layout, { type: "region", region: "right", visible: false }).right.visible).toBe(false);
  });

  it("leaves empty left cards and an empty rail alone, and never touches the conversation", () => {
    let layout = reduce({ type: "region", region: "rail", visible: true });
    layout = dockReducer(layout, { type: "move", panels: ["files"], target: { region: "right" } });
    expect(layout.left).toMatchObject({ visible: true, panels: [], width: 272 });
    layout = dockReducer(layout, { type: "move", panels: ["agents"], target: { region: "right" } });
    expect(layout.rail).toMatchObject({ mode: "expanded", lastMode: "expanded", panels: [] });
    expect(layout.right.visible).toBe(true);
    expect(layout).not.toHaveProperty("center");
    expectSingletons(layout);
  });

  it("converges old configurations where an empty right or bottom region stayed visible", () => {
    const defaults = createDefaultLayout();
    const raw = {
      ...defaults,
      right: { ...defaults.right, visible: true, groups: [] },
      bottom: { ...defaults.bottom, visible: true, expanded: true, size: 300, groups: [] },
      left: { ...defaults.left, visible: true, panels: [] },
      rail: { ...defaults.rail, mode: "expanded", panels: [] },
    };
    const restored = normalizeLayout(raw);
    expect(restored.right).toMatchObject({ visible: false, groups: [] });
    expect(restored.bottom).toMatchObject({ visible: false, expanded: true, size: 300, groups: [] });
    expect(restored.left).toMatchObject({ visible: true, panels: [] });
    expect(restored.rail).toMatchObject({ mode: "expanded", panels: [] });
    expect(normalizeLayout(restored)).toEqual(restored);
    // A region closed by the user but still holding modules keeps its state.
    expect(normalizeLayout(builtInPresets()[1]!.layout).left.visible).toBe(false);
    expect(normalizeLayout(builtInPresets()[1]!.layout).bottom.visible).toBe(false);
  });
});
