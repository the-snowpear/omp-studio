import { PANEL_IDS, agentPanelId, browserPagePanelId, isAgentPanelId, isBrowserPagePanelId, isConversationPanelId, type AgentPanelId, type AgentPanelTarget, type BrowserPagePanelId, type DockAction, type DockFloat, type DockGroup, type DockLayout, type DockLocation, type DockPreset, type DockRect, type DockTarget, type PanelId } from "./types";

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
    floatCoordinateVersion: 1,
    left: { visible: true, width: 272, ratio: 0.46, panels: ["files"] },
    rail: { mode: "hidden", lastMode: "expanded", width: 320, panels: ["environment", "context", "agents"] },
    right: { visible: false, size: 480, ratio: 0.5, groups: [{ id: "right-main", panels: ["changes", "git", "browser", "computer"], active: "changes" }] },
    bottom: { visible: true, expanded: false, size: 240, ratio: 0.5, groups: [{ id: "bottom-main", panels: ["terminal", "problems", "tests", "output", "logs", "pvlogs"], active: "logs" }] },
    floats: [],
    hidden: { btw: { region: "float", rect: { ...FLOAT_RECT } }, "agent-detail": { region: "right" }, "git-quick": { region: "rail" }, "context-viewer": { region: "float" }, "token-counter": { region: "float", rect: { x: 120, y: 90, width: 420, height: 460 } } },
    cards: Object.fromEntries(PANEL_IDS.map(id => [id, { collapsed: false, height: id === "browser" || id === "computer" ? 320 : id === "terminal" ? 240 : null }])) as DockLayout["cards"],
    agentPanels: {},
    browserPages: {},
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
    hidden: Object.fromEntries(Object.entries(layout.hidden).map(([id, location]) => [id, { ...location!, ...(location!.rect ? { rect: { ...location!.rect } } : {}) }])),
    cards: Object.fromEntries(Object.entries(layout.cards).map(([id, card]) => [id, { ...card }])) as DockLayout["cards"],
    agentPanels: Object.fromEntries(Object.entries(layout.agentPanels ?? {}).map(([id, descriptor]) => [id, { ...descriptor!, target: { ...descriptor!.target } }])),
    browserPages: Object.fromEntries(Object.entries(layout.browserPages ?? {}).map(([id, descriptor]) => [id, { ...descriptor! }])),
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

export function removePanels(layout: DockLayout, panels: PanelId[]): DockLayout {
  if (!panels.length) return layout;
  const next = copy(layout);
  remove(next, panels);
  for (const id of panels) delete next.cards[id];
  clean(next);
  return next;
}

const isEmpty = (layout: DockLayout, region: "right" | "bottom"): boolean => layout[region].groups.length === 0;

/** The live list holding a panel: a left/rail card list or a tab group. */
function holder(layout: DockLayout, id: PanelId): { list: PanelId[]; group?: DockGroup } | undefined {
  for (const region of ["left", "rail"] as const) if (layout[region].panels.includes(id)) return { list: layout[region].panels };
  const group = allGroups(layout).find(item => item.panels.includes(id));
  return group ? { list: group.panels, group } : undefined;
}

function replaceInPlace(layout: DockLayout, from: PanelId, to: PanelId): void {
  const found = holder(layout, from);
  if (!found) return;
  found.list[found.list.indexOf(from)] = to;
  if (found.group?.active === from) found.group.active = to;
}

const orderedPanels = (layout: DockLayout): PanelId[] => [...layout.left.panels, ...layout.rail.panels, ...allGroups(layout).flatMap(group => group.panels)];
const placedBrowserPages = (layout: DockLayout, sessionId: string): BrowserPagePanelId[] =>
  orderedPanels(layout).filter((id): id is BrowserPagePanelId => isBrowserPagePanelId(id) && layout.browserPages[id]?.sessionId === sessionId);

/** Passive placement at a remembered address: no region opens and no group changes its tab. */
function placeAt(layout: DockLayout, panel: PanelId, location: DockLocation): void {
  if (location.region === "left" || location.region === "rail") {
    const list = layout[location.region].panels;
    list.splice(clamp(location.index ?? list.length, 0, list.length), 0, panel);
    return;
  }
  const region = location.region === "float" ? "right" : location.region;
  const group = (location.region === "float" ? layout.floats.find(item => item.id === location.groupId) : undefined)
    ?? layout[region].groups.find(item => item.id === location.groupId) ?? layout[region].groups[0];
  if (group) group.panels.splice(clamp(location.index ?? group.panels.length, 0, group.panels.length), 0, panel);
  else layout[region].groups.push({ id: groupId(layout, `${region}-main`), panels: [panel], active: panel });
}

/**
 * A new page joins its opener, else the focused page, else the chat's other pages.
 * The chat's first page, or one opened from a showing start page, takes the generic
 * Browser tab's place so the tab strip does not keep an empty start page beside it.
 */
function landBrowserPage(layout: DockLayout, panel: BrowserPagePanelId, sessionId: string, reveal: boolean, after?: BrowserPagePanelId): void {
  const siblings = placedBrowserPages(layout, sessionId).filter(id => id !== panel);
  const insertAfter = (reference: PanelId) => { const found = holder(layout, reference)!; found.list.splice(found.list.indexOf(reference) + 1, 0, panel); };
  const anchor = locatePanel(layout, "browser");
  const takeAnchor = (location: DockLocation) => {
    layout.cards[panel] = { ...layout.cards.browser!, collapsed: false };
    replaceInPlace(layout, "browser", panel);
    layout.hidden.browser = location;
  };
  const showing = anchor && (anchor.region === "left" || anchor.region === "rail" ? !layout.cards.browser?.collapsed : allGroups(layout).find(group => group.id === anchor.groupId)?.active === "browser");
  if (after && siblings.includes(after)) insertAfter(after);
  else if (reveal && anchor && showing) takeAnchor(anchor);
  else if (layout.lastBrowserPage && siblings.includes(layout.lastBrowserPage)) insertAfter(layout.lastBrowserPage);
  else if (siblings.length) insertAfter(siblings.at(-1)!);
  else if (anchor) takeAnchor(anchor);
  else placeAt(layout, panel, layout.hidden.browser ?? { region: "right" });
}

/**
 * Visibility convergence, only ever applied to a final layout. A region that
 * lost its last module collapses, so an empty tab strip never keeps occupying
 * width (right) or height (bottom).
 *
 * Left cards and the conversation rail keep their state when empty: both are
 * deliberate empty states with their own "add a tool" affordance, and the rail
 * is an overlay that occupies no layout space.
 *
 * `before` is the layout the step started from: a region that was already
 * empty stays open, so an explicit "region visible" on an empty region still
 * shows its "add a tool" state. Without `before` (persisted data) every empty
 * region converges. Sizes, ratios, `bottom.expanded` and `rail.lastMode` are
 * user intent and survive; only `visible` changes.
 */
export function settle(layout: DockLayout, before?: DockLayout): void {
  for (const region of ["right", "bottom"] as const) {
    if (!isEmpty(layout, region)) continue;
    if (before && isEmpty(before, region)) continue;
    layout[region].visible = false;
  }
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
function move(layout: DockLayout, requested: PanelId[], target: DockTarget, preserveRequestedOrder = false): void {
  const ordered = [...layout.left.panels, ...layout.rail.panels, ...allGroups(layout).flatMap(group => group.panels), ...Object.keys(layout.hidden) as PanelId[]];
  const panels = preserveRequestedOrder ? requested.filter(id => ordered.includes(id)) : ordered.filter(id => requested.includes(id));
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

/** Git uses a separate compact surface when dropped in the conversation rail. */
export function panelsAtDockTarget(panels: readonly PanelId[], target: DockTarget): PanelId[] {
  return target.region === "rail" ? [...new Set(panels.map(panel => panel === "git" ? "git-quick" : panel))] : [...panels];
}

export function dockReducer(layout: DockLayout, action: DockAction, locked = false): DockLayout {
  if (locked && (action.type === "move" || action.type === "resize")) return layout;
  if (action.type === "apply") return same(layout, action.layout) ? layout : copy(action.layout);
  const next = copy(layout);
  switch (action.type) {
    case "move": {
      // The conversation rail presents Git as the compact card. Keep the full
      // Git panel at its existing location so the card can open it separately.
      if (action.target.region === "rail" && action.panels.includes("git")) {
        const old = locatePanel(next, "git");
        let target = action.target;
        if (old?.region === "rail") {
          remove(next, ["git"]);
          next.hidden.git = { region: "right", ...(next.right.groups[0] ? { groupId: next.right.groups[0].id } : {}) };
          next.cards["git-quick"] = { ...next.cards.git! };
          if (target.index !== undefined && old.index !== undefined && old.index < target.index) target = { ...target, index: target.index - 1 };
        }
        move(next, panelsAtDockTarget(action.panels, target), target, true);
      } else move(next, action.panels, action.target);
      break;
    }
    case "agent-focus": {
      if (next.agentPanels[action.panel]) next.lastAgentPanel = action.panel;
      break;
    }
    case "agent-open": {
      const old = next.agentPanels[action.panel];
      let replaceLegacy = false;
      next.agentPanels[action.panel] = { scope: action.descriptor.scope, target: { ...old?.target, ...action.descriptor.target } };
      if (!next.cards[action.panel]) next.cards[action.panel] = { collapsed: false, height: null };
      if (!locatePanel(next, action.panel) && !next.hidden[action.panel]) {
        const last = next.lastAgentPanel;
        const previous = last ? locatePanel(next, last) ?? next.hidden[last] : undefined;
        const legacy = locatePanel(next, "agent-detail") ?? next.hidden["agent-detail"] ?? { region: "right" as const };
        const location = previous ?? legacy;
        next.hidden[action.panel] = location.region === "left" || location.region === "rail"
          ? { ...location, ...(location.index === undefined ? {} : { index: location.index + (previous ? 1 : 0) }) }
          : { region: location.region, ...(location.groupId ? { groupId: location.groupId } : {}), ...(location.region === "float" && location.rect ? { rect: location.rect } : {}) };
        replaceLegacy = !previous && !!locatePanel(next, "agent-detail");
      }
      next.lastAgentPanel = action.panel;
      const opened = dockReducer(next, { type: "open", panel: action.panel }, locked);
      return replaceLegacy ? dockReducer(opened, { type: "hide", panels: ["agent-detail"] }, locked) : opened;
    }
    case "browser-page-open": {
      const { panel, descriptor } = action;
      next.browserPages[panel] = { ...next.browserPages[panel], ...descriptor };
      next.cards[panel] ??= { collapsed: false, height: null };
      if (!locatePanel(next, panel)) { landBrowserPage(next, panel, descriptor.sessionId, action.reveal, action.after); clean(next); }
      if (action.reveal) {
        next.lastBrowserPage = panel;
        const location = locatePanel(next, panel);
        if (location) reveal(next, location, panel);
        next.cards[panel]!.collapsed = false;
      }
      break;
    }
    case "browser-page-focus": {
      if (next.browserPages[action.panel]) next.lastBrowserPage = action.panel;
      break;
    }
    case "browser-page-close": {
      const panels = action.panels.filter(id => next.browserPages[id]);
      if (!panels.length) break;
      const focused = next.lastBrowserPage, sessionId = focused ? next.browserPages[focused]?.sessionId : undefined;
      const group = focused && panels.includes(focused) ? allGroups(next).find(item => item.panels.includes(focused)) : undefined;
      remove(next, panels);
      for (const id of panels) { delete next.browserPages[id]; delete next.cards[id]; }
      clean(next);
      if (focused && !next.browserPages[focused]) {
        // The tab that took the closed one's place is the chat's page now.
        const neighbour = group?.panels.length && isBrowserPagePanelId(group.active) && next.browserPages[group.active]?.sessionId === sessionId ? group.active : sessionId ? placedBrowserPages(next, sessionId)[0] : undefined;
        if (neighbour) next.lastBrowserPage = neighbour; else delete next.lastBrowserPage;
      }
      break;
    }
    case "hide": {
      const locations = action.panels.map(panel => {
        const location = locatePanel(next, panel);
        if (location?.index !== undefined) {
          const hiddenSlots = Object.values(next.hidden).filter(old => old!.region === location.region && old!.groupId === location.groupId && old!.index !== undefined).map(old => old!.index!).sort((a, b) => a - b);
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
        const earlierHidden = Object.entries(next.hidden).filter(([id, old]) => id !== action.panel && old!.region === previous.region && old!.groupId === previous.groupId && old!.index !== undefined && previous.index !== undefined && old!.index < previous.index).length;
        const restore: DockTarget = { ...previous, ...(previous.index === undefined ? {} : { index: Math.max(0, previous.index - earlierHidden) }) };
        // A surviving float may have been moved/resized since this tab was
        // hidden. Restore the tab, not stale geometry over its current group.
        if (restore.region === "float" && next.floats.some(group => group.id === restore.groupId)) delete restore.rect;
        move(next, [action.panel], restore);
        location = locatePanel(next, action.panel);
      }
      if (location) reveal(next, location, action.panel);
      next.cards[action.panel]!.collapsed = false;
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
      const card = next.cards[action.panel]!;
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
  // Only the committed result is judged; move() reorders inside a region and
  // briefly empties it on the way, so settling there would drop live regions.
  settle(next, layout);
  return same(layout, next) ? layout : next;
}

/** A preset remembers an Agent landing place, never session-specific identities. */
export function agentPresetLayout(layout: DockLayout): DockLayout {
  const ids = Object.keys(layout.agentPanels ?? {}) as AgentPanelId[];
  if (!ids.length) return copy(layout);
  const opened = ids.filter(id => locatePanel(layout, id));
  const last = layout.lastAgentPanel && ids.includes(layout.lastAgentPanel) ? layout.lastAgentPanel : opened[0] ?? ids[0]!;
  const destination = locatePanel(layout, last) ?? layout.hidden[last] ?? { region: "right" as const };
  let result = dockReducer(layout, { type: "hide", panels: ids });
  result = copy(result);
  for (const id of ids) { delete result.hidden[id]; delete result.cards[id]; delete result.agentPanels[id]; }
  delete result.lastAgentPanel;
  result = dockReducer(result, { type: "move", panels: ["agent-detail"], target: destination });
  if (!opened.length) result = dockReducer(result, { type: "hide", panels: ["agent-detail"] });
  return result;
}

/** Applying a preset relocates open Agent views without importing another session's targets. */
export function applyAgentPreset(preset: DockLayout, current: DockLayout): DockLayout {
  const ids = Object.keys(current.agentPanels ?? {}) as AgentPanelId[];
  if (!ids.length) return copy(preset);
  const ordered = [...current.left.panels, ...current.rail.panels, ...allGroups(current).flatMap(group => group.panels)].filter(isAgentPanelId);
  let result = copy(preset);
  for (const id of ordered) {
    const descriptor = current.agentPanels[id];
    if (!descriptor) continue;
    result = dockReducer(result, { type: "agent-open", panel: id, descriptor });
    result.cards[id] = { ...current.cards[id]! };
  }
  for (const id of ids.filter(id => !ordered.includes(id))) {
    const descriptor = current.agentPanels[id];
    if (!descriptor) continue;
    result.agentPanels[id] = descriptor;
    result.cards[id] = { ...current.cards[id]! };
    if (current.hidden[id]) result.hidden[id] = { ...current.hidden[id] };
  }
  const last = current.lastAgentPanel;
  if (last && result.agentPanels[last]) {
    result.lastAgentPanel = last;
    if (ordered.includes(last)) result = dockReducer(result, { type: "open", panel: last });
  }
  return result;
}

/** Like Agents, a preset keeps one generic Browser tab where the focused page was, never the pages. */
export function browserPagePresetLayout(layout: DockLayout): DockLayout {
  const ids = Object.keys(layout.browserPages ?? {}) as BrowserPagePanelId[];
  if (!ids.length) return copy(layout);
  const result = copy(layout);
  const placed = ids.filter(id => locatePanel(result, id));
  const focused = result.lastBrowserPage && placed.includes(result.lastBrowserPage) ? result.lastBrowserPage : placed[0];
  if (focused && !locatePanel(result, "browser")) { replaceInPlace(result, focused, "browser"); delete result.hidden.browser; }
  remove(result, ids);
  for (const id of ids) { delete result.cards[id]; delete result.browserPages[id]; }
  delete result.lastBrowserPage;
  clean(result);
  settle(result, layout);
  return result;
}

/** Applying a preset lands the chat's pages again, in their order, at the preset's Browser place. */
export function applyBrowserPagePreset(preset: DockLayout, current: DockLayout): DockLayout {
  if (!Object.keys(current.browserPages ?? {}).length) return copy(preset);
  let result = copy(preset);
  for (const id of orderedPanels(current).filter(isBrowserPagePanelId)) {
    const descriptor = current.browserPages[id];
    if (!descriptor) continue;
    result = dockReducer(result, { type: "browser-page-open", panel: id, descriptor, reveal: false });
    result.cards[id] = { ...current.cards[id]! };
  }
  if (current.lastBrowserPage && result.browserPages[current.lastBrowserPage]) result.lastBrowserPage = current.lastBrowserPage;
  return result;
}

/** Presets and the "modified" baseline never carry per-session Agents or pages. */
export const instancePresetLayout = (layout: DockLayout): DockLayout => removePanels(browserPagePresetLayout(agentPresetLayout(layout)), Object.keys(layout.cards).filter(isConversationPanelId));
export const applyInstancePreset = (preset: DockLayout, current: DockLayout): DockLayout => {
  let result = applyBrowserPagePreset(applyAgentPreset(preset, current), current);
  for (const panel of Object.keys(current.cards).filter(isConversationPanelId)) {
    const location = locatePanel(current, panel) ?? current.hidden[panel];
    result = { ...result, cards: { ...result.cards, [panel]: current.cards[panel]! }, hidden: { ...result.hidden, [panel]: location ?? { region: "float" } } };
    if (locatePanel(current, panel)) result = dockReducer(result, { type: "open", panel });
  }
  return result;
};

/** "Browser" in a tools menu shows the chat's focused page when there is one, not a blank start page. */
export function browserRevealTarget(layout: DockLayout, sessionId?: string): PanelId {
  const pages = (Object.keys(layout.browserPages ?? {}) as BrowserPagePanelId[]).filter(id => (sessionId === undefined || layout.browserPages[id]!.sessionId === sessionId) && locatePanel(layout, id));
  return layout.lastBrowserPage && pages.includes(layout.lastBrowserPage) ? layout.lastBrowserPage : pages[0] ?? "browser";
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
  for (const [id, value] of Object.entries(record(raw.agentPanels))) {
    const descriptor = record(value), target = record(descriptor.target);
    if (!isAgentPanelId(id) || typeof descriptor.scope !== "string" || typeof target.agentId !== "string" || agentPanelId(descriptor.scope, target.agentId) !== id) continue;
    layout.agentPanels[id] = { scope: descriptor.scope, target: target as AgentPanelTarget };
  }
  for (const [id, value] of Object.entries(record(raw.browserPages))) {
    const descriptor = record(value);
    if (!isBrowserPagePanelId(id) || typeof descriptor.sessionId !== "string" || typeof descriptor.pageId !== "string" || browserPagePanelId(descriptor.sessionId, descriptor.pageId) !== id) continue;
    layout.browserPages[id] = { sessionId: descriptor.sessionId, pageId: descriptor.pageId, ...(typeof descriptor.title === "string" ? { title: descriptor.title } : {}) };
  }
  const validPanel = (id: unknown): id is PanelId => isPanel(id) || typeof id === "string" && (isAgentPanelId(id) && !!layout.agentPanels[id] || isBrowserPagePanelId(id) && !!layout.browserPages[id] || isConversationPanelId(id));
  const seen = new Set<PanelId>();
  const ids = new Set<string>();
  const panels = (value: unknown): PanelId[] => Array.isArray(value) ? value.filter((id): id is PanelId => {
    if (!validPanel(id) || seen.has(id)) return false;
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
      else result.push({ id: readId(group.id, `${prefix}-${result.length + 1}`), panels: members, active: validPanel(group.active) && members.includes(group.active) ? group.active : members[0]! });
    }
    return result;
  };
  const left = record(raw.left), rail = record(raw.rail), right = record(raw.right), bottom = record(raw.bottom);
  layout.floatCoordinateVersion = raw.floatCoordinateVersion === 1 ? 1 : undefined;
  layout.left = { visible: bool(left.visible, true), width: clamp(number(left.width, 272), 200, 400), ratio: clamp(number(left.ratio, 0.46), 0.15, 0.85), panels: panels(left.panels) };
  const mode = rail.mode === "expanded" || rail.mode === "compact" ? rail.mode : "hidden";
  layout.rail = { mode, lastMode: mode !== "hidden" ? mode : rail.lastMode === "compact" ? "compact" : "expanded", width: clamp(number(rail.width, 320), 280, 480), panels: panels(rail.panels) };
  layout.right = { visible: bool(right.visible, false), size: Math.max(320, number(right.size, 480)), ratio: clamp(number(right.ratio, 0.5), 0.15, 0.85), groups: groups(right.groups, "right") };
  layout.bottom = { visible: bool(bottom.visible, true), expanded: bool(bottom.expanded, false), size: Math.max(120, number(bottom.size, 240)), ratio: clamp(number(bottom.ratio, 0.5), 0.15, 0.85), groups: groups(bottom.groups, "bottom") };
  layout.floats = [];
  if (Array.isArray(raw.floats)) for (const item of raw.floats) {
    const group = record(item);
    const members = panels(group.panels);
    if (members.length) layout.floats.push({ id: readId(group.id, "float"), panels: members, active: validPanel(group.active) && members.includes(group.active) ? group.active : members[0]!, rect: readRect(group.rect), minimized: bool(group.minimized, false), maximized: bool(group.maximized, false) });
  }
  // Migrate both original layouts and layouts saved by versions which introduced
  // git-quick but still allowed the full Git panel to remain in the rail.
  const migrateGitCard = layout.rail.panels.includes("git");
  const quickWasPlaced = seen.has("git-quick");
  const quickAlreadyInRail = layout.rail.panels.includes("git-quick");
  if (migrateGitCard) {
    if (quickAlreadyInRail) layout.rail.panels.splice(layout.rail.panels.indexOf("git"), 1);
    else {
      remove(layout, ["git-quick"]);
      layout.rail.panels[layout.rail.panels.indexOf("git")] = "git-quick";
    }
    seen.delete("git");
    seen.add("git-quick");
  }
  // Introduce Context beside Environment once; an explicitly hidden/moved card stays put.
  if (!seen.has("context") && !("context" in record(raw.hidden))) {
    const environmentIndex = layout.rail.panels.indexOf("environment");
    if (environmentIndex >= 0) {
      layout.rail.panels.splice(environmentIndex + 1, 0, "context");
      seen.add("context");
    }
  }
  // Other omitted/new modules stay recoverable without opening new tools.
  const defaults = createDefaultLayout();
  const hidden = record(raw.hidden);
  layout.hidden = {};
  for (const id of [...PANEL_IDS, ...Object.keys(layout.agentPanels) as AgentPanelId[], ...new Set([...Object.keys(record(raw.cards)), ...seen].filter(isConversationPanelId))]) {
    const card = record(record(raw.cards)[migrateGitCard && !quickWasPlaced && id === "git-quick" ? "git" : id]);
    layout.cards[id] = { collapsed: bool(card.collapsed, false), height: card.height === null ? null : typeof card.height === "number" && Number.isFinite(card.height) ? Math.max(id === "terminal" ? 240 : 80, card.height) : defaults.cards[id]?.height ?? null };
    if (seen.has(id)) continue;
    const old = record(hidden[id]);
    const fallback = locatePanel(defaults, id) ?? defaults.hidden[id] ?? { region: "right" as const };
    if (id === "git" && (migrateGitCard || old.region === "rail")) layout.hidden[id] = { region: "right", ...(layout.right.groups[0] ? { groupId: layout.right.groups[0].id } : {}) };
    else if (!["left", "rail", "right", "bottom", "float"].includes(String(old!.region))) layout.hidden[id] = fallback;
    else layout.hidden[id] = {
      region: old!.region as DockLocation["region"],
      ...(typeof old!.groupId === "string" ? { groupId: old!.groupId } : {}),
      ...(typeof old!.index === "number" && Number.isFinite(old!.index) ? { index: Math.max(0, Math.floor(old!.index)) } : {}),
      ...(old!.region === "float" && old.rect ? { rect: readRect(old.rect) } : {}),
    };
  }
  if (typeof raw.lastAgentPanel === "string" && isAgentPanelId(raw.lastAgentPanel) && layout.agentPanels[raw.lastAgentPanel]) layout.lastAgentPanel = raw.lastAgentPanel as AgentPanelId;
  for (const id of Object.keys(layout.browserPages) as BrowserPagePanelId[]) {
    // Pages are never hidden: one that lost its place is dropped, and the next sync lands it again.
    if (!seen.has(id)) { delete layout.browserPages[id]; continue; }
    const card = record(record(raw.cards)[id]);
    layout.cards[id] = { collapsed: bool(card.collapsed, false), height: typeof card.height === "number" && Number.isFinite(card.height) ? Math.max(80, card.height) : null };
  }
  if (typeof raw.lastBrowserPage === "string" && isBrowserPagePanelId(raw.lastBrowserPage) && layout.browserPages[raw.lastBrowserPage]) layout.lastBrowserPage = raw.lastBrowserPage;
  layout.presetId = typeof raw.presetId === "string" && raw.presetId ? raw.presetId : "default";
  clean(layout);
  // Old configurations could keep an empty region open; the same rule applies here.
  settle(layout);
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
