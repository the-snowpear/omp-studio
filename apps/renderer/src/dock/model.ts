import { PANEL_IDS, type DockAction, type DockFloat, type DockGroup, type DockLayout, type DockLocation, type DockPreset, type DockRect, type DockTarget, type PanelId } from "./types";

const FLOAT_RECT: DockRect = { x: 80, y: 60, width: 560, height: 400 };
const isPanel = (value: unknown): value is PanelId => typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bool = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createDefaultLayout(): DockLayout {
  return {
    version: 1,
    left: { visible: true, width: 272, ratio: 0.46, panels: ["files"] },
    rail: { mode: "hidden", lastMode: "expanded", width: 320, panels: ["agents"] },
    right: { visible: false, size: 480, ratio: 0.5, groups: [{ id: "right-main", panels: ["changes", "git", "browser", "computer"], active: "changes" }] },
    bottom: { visible: true, expanded: false, size: 240, ratio: 0.5, groups: [{ id: "bottom-main", panels: ["terminal", "problems", "tests", "output", "logs", "pvlogs"], active: "logs" }] },
    floats: [],
    hidden: { btw: { region: "float", rect: { ...FLOAT_RECT } } },
    cards: Object.fromEntries(PANEL_IDS.map(id => [id, { collapsed: false, height: id === "browser" || id === "computer" ? 320 : id === "terminal" ? 240 : null }])) as DockLayout["cards"],
    presetId: "default",
  };
}

/** Hidden panels deliberately have no live location; their return address is in hidden. */
export function locatePanel(layout: DockLayout, id: PanelId): DockLocation | undefined {
  for (const region of ["left", "rail"] as const) {
    const index = layout[region].panels.indexOf(id);
    if (index >= 0) return { region, index };
  }
  for (const region of ["right", "bottom"] as const) {
    for (const group of layout[region].groups) {
      const index = group.panels.indexOf(id);
      if (index >= 0) return { region, groupId: group.id, index };
    }
  }
  for (const group of layout.floats) {
    const index = group.panels.indexOf(id);
    if (index >= 0) return { region: "float", groupId: group.id, index, rect: { ...group.rect } };
  }
  return undefined;
}

function copy(layout: DockLayout): DockLayout {
  return {
    ...layout,
    left: { ...layout.left, panels: [...layout.left.panels] },
    rail: { ...layout.rail, panels: [...layout.rail.panels] },
    right: { ...layout.right, groups: layout.right.groups.map(group => ({ ...group, panels: [...group.panels] })) },
    bottom: { ...layout.bottom, groups: layout.bottom.groups.map(group => ({ ...group, panels: [...group.panels] })) },
    floats: layout.floats.map(group => ({ ...group, panels: [...group.panels], rect: { ...group.rect } })),
    hidden: Object.fromEntries(Object.entries(layout.hidden).map(([id, location]) => [id, { ...location, ...(location.rect ? { rect: { ...location.rect } } : {}) }])),
    cards: Object.fromEntries(PANEL_IDS.map(id => [id, { ...layout.cards[id] }])) as DockLayout["cards"],
  };
}

const allGroups = (layout: DockLayout): DockGroup[] => [...layout.right.groups, ...layout.bottom.groups, ...layout.floats];
function groupId(layout: DockLayout, base: string): string {
  const ids = new Set(allGroups(layout).map(group => group.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

function remove(layout: DockLayout, panels: PanelId[]): void {
  const selected = new Set(panels);
  layout.left.panels = layout.left.panels.filter(id => !selected.has(id));
  layout.rail.panels = layout.rail.panels.filter(id => !selected.has(id));
  for (const group of allGroups(layout)) {
    const activeIndex = group.panels.indexOf(group.active);
    group.panels = group.panels.filter(id => !selected.has(id));
    if (!group.panels.includes(group.active) && group.panels.length) group.active = group.panels[Math.min(activeIndex, group.panels.length - 1)]!;
  }
  for (const id of panels) delete layout.hidden[id];
}

function clean(layout: DockLayout): void {
  for (const region of ["right", "bottom"] as const) {
    layout[region].groups = layout[region].groups.filter(group => group.panels.length > 0);
    if (layout[region].groups.length < 2) layout[region].ratio = 0.5;
  }
  layout.floats = layout.floats.filter(group => group.panels.length > 0);
}

function reveal(layout: DockLayout, location: DockLocation, panel: PanelId): void {
  if (location.region === "left") layout.left.visible = true;
  else if (location.region === "rail") {
    if (layout.rail.mode === "hidden") layout.rail.mode = layout.rail.lastMode;
  } else if (location.region === "float") {
    const index = layout.floats.findIndex(group => group.id === location.groupId);
    if (index >= 0) {
      const group = layout.floats.splice(index, 1)[0]!;
      group.active = panel;
      group.minimized = false;
      layout.floats.push(group);
    }
  } else {
    layout[location.region].visible = true;
    if (location.region === "bottom") layout.bottom.expanded = true;
    const group = layout[location.region].groups.find(item => item.id === location.groupId);
    if (group) group.active = panel;
  }
}

/** target.index is a gap in the original list, before removing the moving panels. */
function move(layout: DockLayout, requested: PanelId[], target: DockTarget): void {
  const ordered = [...layout.left.panels, ...layout.rail.panels, ...allGroups(layout).flatMap(group => group.panels), ...PANEL_IDS.filter(id => layout.hidden[id])];
  const panels = ordered.filter(id => requested.includes(id));
  if (!panels.length) return;
  const source = allGroups(layout).find(group => panels.every(id => group.panels.includes(id)));
  const active = source && panels.includes(source.active) ? source.active : panels[0]!;
  const wholeGroup = source && source.panels.length === panels.length ? source.id : undefined;
  const oldGroups = target.region === "right" || target.region === "bottom" ? layout[target.region].groups : [];
  let destination = target.region === "float"
    ? layout.floats.find(group => group.id === target.groupId)
    : oldGroups.find(group => group.id === target.groupId) ?? oldGroups[0];
  // With two groups an outer edge selects its existing group, never a third.
  if (target.split && oldGroups.length === 2) destination = target.split === "before" ? oldGroups[0] : oldGroups[1];
  const split = !!target.split && oldGroups.length === 1;
  const originalList = target.region === "left" || target.region === "rail" ? layout[target.region].panels : destination?.panels ?? [];
  const gap = target.index === undefined ? originalList.length : clamp(target.index, 0, originalList.length);
  const index = gap - originalList.slice(0, gap).filter(id => panels.includes(id)).length;
  remove(layout, panels);
  if (target.region === "left" || target.region === "rail") {
    layout[target.region].panels.splice(index, 0, ...panels);
    reveal(layout, { region: target.region }, active);
  } else if (target.region === "float") {
    let floating = destination as DockFloat | undefined;
    if (!floating) {
      // Keep a whole group's identity when detaching it; empty sources are removed below.
      clean(layout);
      floating = { id: groupId(layout, target.groupId ?? wholeGroup ?? `float-${panels[0]}`), panels: [], active, rect: { ...(target.rect ?? FLOAT_RECT) }, minimized: false, maximized: false };
      layout.floats.push(floating);
    }
    floating.panels.splice(index, 0, ...panels);
    if (target.rect) {
      floating.rect = { ...target.rect };
      // A direct move/resize overrides full-workbench maximization.
      floating.maximized = false;
    }
    reveal(layout, { region: "float", groupId: floating.id }, active);
  } else {
    const region = layout[target.region];
    if (split || !destination) {
      const reference = destination;
      clean(layout);
      destination = { id: groupId(layout, wholeGroup ?? target.groupId ?? `${target.region}-group`), panels: [], active };
      const referenceIndex = reference ? region.groups.indexOf(reference) : -1;
      region.groups.splice(referenceIndex < 0 ? region.groups.length : referenceIndex + (target.split === "after" ? 1 : 0), 0, destination);
      region.ratio = 0.5;
    }
    destination.panels.splice(split ? 0 : index, 0, ...panels);
    reveal(layout, { region: target.region, groupId: destination.id }, active);
  }
  clean(layout);
}

export function dockReducer(layout: DockLayout, action: DockAction, locked = false): DockLayout {
  if (locked && (action.type === "move" || action.type === "resize")) return layout;
  if (action.type === "apply") return same(layout, action.layout) ? layout : copy(action.layout);
  const next = copy(layout);
  switch (action.type) {
    case "move": move(next, action.panels, action.target); break;
    case "hide": {
      const locations = action.panels.map(panel => {
        const location = locatePanel(next, panel);
        if (location?.index !== undefined) {
          const hiddenSlots = Object.values(next.hidden).filter(old => old.region === location.region && old.groupId === location.groupId && old.index !== undefined).map(old => old.index!).sort((a, b) => a - b);
          for (const slot of hiddenSlots) if (slot <= location.index) location.index++;
        }
        return [panel, location] as const;
      });
      remove(next, locations.filter(([, location]) => location).map(([panel]) => panel));
      for (const [panel, location] of locations) if (location) next.hidden[panel] = location;
      clean(next);
      break;
    }
    case "open": {
      let location = locatePanel(next, action.panel);
      if (!location) {
        const previous = next.hidden[action.panel];
        if (!previous) return layout;
        // A hidden group can be reopened in any order. Its missing earlier tabs
        // still occupy saved slots, but not gaps in the current live strip.
        const earlierHidden = Object.entries(next.hidden).filter(([id, old]) => id !== action.panel && old.region === previous.region && old.groupId === previous.groupId && old.index !== undefined && previous.index !== undefined && old.index < previous.index).length;
        const restore: DockTarget = { ...previous, ...(previous.index === undefined ? {} : { index: Math.max(0, previous.index - earlierHidden) }) };
        // A surviving float may have been moved/resized since this tab was
        // hidden. Restore the tab, not stale geometry over its current group.
        if (restore.region === "float" && next.floats.some(group => group.id === restore.groupId)) delete restore.rect;
        move(next, [action.panel], restore);
        location = locatePanel(next, action.panel);
      }
      if (location) reveal(next, location, action.panel);
      next.cards[action.panel].collapsed = false;
      break;
    }
    case "activate": {
      const group = allGroups(next).find(item => item.id === action.groupId);
      if (group?.panels.includes(action.panel)) group.active = action.panel;
      break;
    }
    case "region":
      if (action.region === "rail") next.rail.mode = action.visible ? next.rail.lastMode : "hidden";
      else next[action.region].visible = action.visible;
      break;
    case "railMode":
      next.rail.mode = action.mode;
      if (action.mode !== "hidden") next.rail.lastMode = action.mode;
      break;
    case "bottomExpanded":
      next.bottom.expanded = action.expanded;
      if (action.expanded) next.bottom.visible = true;
      break;
    case "card": {
      const card = next.cards[action.panel];
      if (action.collapsed !== undefined) card.collapsed = action.collapsed;
      if (!locked && action.height !== undefined) card.height = action.height === null ? null : Math.max(action.panel === "terminal" ? 240 : 80, action.height);
      break;
    }
    case "resize": {
      const region = next[action.region];
      if (action.ratio !== undefined && "ratio" in region) region.ratio = clamp(action.ratio, 0.15, 0.85);
      if (action.size !== undefined) {
        if (action.region === "left") next.left.width = clamp(action.size, 200, 400);
        else if (action.region === "rail") next.rail.width = clamp(action.size, 280, 480);
        else if (action.region === "right") next.right.size = Math.max(320, action.size);
        else next.bottom.size = Math.max(120, action.size);
      }
      break;
    }
    case "float": {
      const group = next.floats.find(item => item.id === action.groupId);
      if (!group) break;
      if (!locked && action.rect) group.rect = { ...action.rect };
      if (action.minimized !== undefined) group.minimized = action.minimized;
      if (action.maximized !== undefined) group.maximized = action.maximized;
      break;
    }
    case "raise": {
      const index = next.floats.findIndex(group => group.id === action.groupId);
      if (index >= 0) next.floats.push(next.floats.splice(index, 1)[0]!);
      break;
    }
  }
  return same(layout, next) ? layout : next;
}

export function builtInPresets(): DockPreset[] {
  const standard = createDefaultLayout();
  const focus = createDefaultLayout();
  focus.presetId = "focus";
  focus.left.visible = false;
  focus.bottom.visible = false;
  const debug = createDefaultLayout();
  debug.presetId = "debug";
  debug.right.visible = true;
  debug.right.groups = [{ id: "right-git", panels: ["git"], active: "git" }, { id: "right-changes", panels: ["changes", "browser", "computer"], active: "changes" }];
  debug.bottom.expanded = true;
  debug.bottom.groups = [{ id: "bottom-terminal", panels: ["terminal", "problems", "tests", "output"], active: "terminal" }, { id: "bottom-logs", panels: ["logs", "pvlogs"], active: "logs" }];
  debug.rail.mode = debug.rail.lastMode = "compact";
  return [{ id: "default", name: "默认", layout: standard, builtin: true }, { id: "focus", name: "专注", layout: focus, builtin: true }, { id: "debug", name: "调试", layout: debug, builtin: true }];
}

function readRect(value: unknown): DockRect {
  const raw = record(value);
  return { x: number(raw.x, FLOAT_RECT.x), y: number(raw.y, FLOAT_RECT.y), width: Math.max(320, number(raw.width, FLOAT_RECT.width)), height: Math.max(200, number(raw.height, FLOAT_RECT.height)) };
}

/** Persistence boundary only. The reducer consumes the typed, normalized model. */
export function normalizeLayout(value: unknown): DockLayout {
  const raw = record(value);
  if (raw.version !== 1) return createDefaultLayout();
  const layout = createDefaultLayout();
  const seen = new Set<PanelId>();
  const ids = new Set<string>();
  const panels = (value: unknown): PanelId[] => Array.isArray(value) ? value.filter((id): id is PanelId => {
    if (!isPanel(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }) : [];
  const readId = (value: unknown, fallback: string) => {
    const base = typeof value === "string" && value ? value : fallback;
    let id = base;
    let suffix = 2;
    while (ids.has(id)) id = `${base}-${suffix++}`;
    ids.add(id);
    return id;
  };
  const groups = (value: unknown, prefix: string): DockGroup[] => {
    if (!Array.isArray(value)) return [];
    const result: DockGroup[] = [];
    for (const item of value) {
      const group = record(item);
      const members = panels(group.panels);
      if (!members.length) continue;
      if (result.length === 2) result[1]!.panels.push(...members);
      else result.push({ id: readId(group.id, `${prefix}-${result.length + 1}`), panels: members, active: isPanel(group.active) && members.includes(group.active) ? group.active : members[0]! });
    }
    return result;
  };
  const left = record(raw.left), rail = record(raw.rail), right = record(raw.right), bottom = record(raw.bottom);
  layout.left = { visible: bool(left.visible, true), width: clamp(number(left.width, 272), 200, 400), ratio: clamp(number(left.ratio, 0.46), 0.15, 0.85), panels: panels(left.panels) };
  const mode = rail.mode === "expanded" || rail.mode === "compact" ? rail.mode : "hidden";
  layout.rail = { mode, lastMode: mode !== "hidden" ? mode : rail.lastMode === "compact" ? "compact" : "expanded", width: clamp(number(rail.width, 320), 280, 480), panels: panels(rail.panels) };
  layout.right = { visible: bool(right.visible, false), size: Math.max(320, number(right.size, 480)), ratio: clamp(number(right.ratio, 0.5), 0.15, 0.85), groups: groups(right.groups, "right") };
  layout.bottom = { visible: bool(bottom.visible, true), expanded: bool(bottom.expanded, false), size: Math.max(120, number(bottom.size, 240)), ratio: clamp(number(bottom.ratio, 0.5), 0.15, 0.85), groups: groups(bottom.groups, "bottom") };
  layout.floats = [];
  if (Array.isArray(raw.floats)) for (const item of raw.floats) {
    const group = record(item);
    const members = panels(group.panels);
    if (members.length) layout.floats.push({ id: readId(group.id, "float"), panels: members, active: isPanel(group.active) && members.includes(group.active) ? group.active : members[0]!, rect: readRect(group.rect), minimized: bool(group.minimized, false), maximized: bool(group.maximized, false) });
  }
  // Omitted/new modules stay recoverable without unexpectedly opening new tools.
  const defaults = createDefaultLayout();
  const hidden = record(raw.hidden);
  layout.hidden = {};
  for (const id of PANEL_IDS) {
    const card = record(record(raw.cards)[id]);
    layout.cards[id] = { collapsed: bool(card.collapsed, false), height: card.height === null ? null : typeof card.height === "number" && Number.isFinite(card.height) ? Math.max(id === "terminal" ? 240 : 80, card.height) : defaults.cards[id].height };
    if (seen.has(id)) continue;
    const old = record(hidden[id]);
    const fallback = locatePanel(defaults, id) ?? defaults.hidden[id]!;
    if (!["left", "rail", "right", "bottom", "float"].includes(String(old.region))) layout.hidden[id] = fallback;
    else layout.hidden[id] = {
      region: old.region as DockLocation["region"],
      ...(typeof old.groupId === "string" ? { groupId: old.groupId } : {}),
      ...(typeof old.index === "number" && Number.isFinite(old.index) ? { index: Math.max(0, Math.floor(old.index)) } : {}),
      ...(old.region === "float" ? { rect: readRect(old.rect) } : {}),
    };
  }
  layout.presetId = typeof raw.presetId === "string" && raw.presetId ? raw.presetId : "default";
  clean(layout);
  return layout;
}

/** Effective viewport geometry only; never write its result back on window resize. */
export function clampFloat(rect: DockRect, bounds: Pick<DockRect, "width" | "height"> & Partial<Pick<DockRect, "x" | "y">>, minHeight = 200): DockRect {
  const x = number(bounds.x, 0), y = number(bounds.y, 0);
  const availableWidth = Math.max(0, number(bounds.width, 0)), availableHeight = Math.max(0, number(bounds.height, 0));
  const width = Math.min(availableWidth, Math.max(320, number(rect.width, 560)));
  const height = Math.min(availableHeight, Math.max(minHeight, number(rect.height, 400)));
  return { x: clamp(number(rect.x, x), x, x + availableWidth - width), y: clamp(number(rect.y, y), y, y + availableHeight - height), width, height };
}
