import { createDefaultLayout, dockReducer, normalizeLayout } from "./model";
import type { DockFloat, DockLayout, DockScope, PanelId } from "./types";

export const isNativeFloat = (group: DockFloat) => group.pin?.mode === "window" || group.pin?.mode === "topmost";
export const pinWorkspace = (scope: DockScope) => JSON.stringify([scope.target, scope.project]);
export const pinOwner = (scope: DockScope) => JSON.stringify([scope.target, scope.project, scope.session, !!scope.draft]);
export const pinsForScope = (pins: readonly DockFloat[], scope: DockScope) => pins.filter(group => (!group.pin?.owner || group.pin.owner === pinOwner(scope)) && (group.pin?.mode !== "workspace" || group.pin.workspace === pinWorkspace(scope)));

/** Pinned groups borrow the single panel instance without rewriting session layouts. */
export function withPins(layout: DockLayout, pins: readonly DockFloat[]): DockLayout {
  if (!pins.length) return layout;
  const panels = pins.flatMap(group => group.panels);
  const agentPanels = Object.assign({}, ...pins.map(group => group.pin?.agentPanels ?? {}), layout.agentPanels) as DockLayout["agentPanels"];
  const browserPages = Object.assign({}, ...pins.map(group => group.pin?.browserPages ?? {}), layout.browserPages) as DockLayout["browserPages"];
  const cards = { ...layout.cards };
  for (const id of [...Object.keys(agentPanels), ...Object.keys(browserPages)] as PanelId[]) cards[id] ??= { collapsed: false, height: null };
  const next = dockReducer({ ...layout, agentPanels, browserPages, cards }, { type: "hide", panels });
  const hidden = { ...next.hidden };
  for (const panel of panels) delete hidden[panel];
  return { ...next, hidden, floats: [...next.floats, ...pins] };
}

export function subtractPinPanels(pins: readonly DockFloat[], panels: readonly PanelId[]): DockFloat[] {
  return pins.flatMap(group => {
    const remaining = group.panels.filter(panel => !panels.includes(panel));
    if (remaining.length === group.panels.length) return [group];
    if (!remaining.length) return [];
    const keep = <Value,>(source: Record<string, Value> | undefined) => Object.fromEntries(Object.entries(source ?? {}).filter(([id]) => remaining.includes(id as PanelId)));
    let pin = group.pin;
    if (pin) { const { browserPages, ...rest } = pin; const pages = keep(browserPages); pin = { ...rest, agentPanels: keep(pin.agentPanels), ...(Object.keys(pages).length ? { browserPages: pages } : {}) }; }
    return [{ ...group, panels: remaining, active: remaining.includes(group.active) ? group.active : remaining[0]!, ...(pin ? { pin } : {}) }];
  });
}

/** Different workspaces may remember the same tool; only overlapping scopes compete. */
export function putPin(pins: readonly DockFloat[], group: DockFloat): DockFloat[] {
  return [...pins.flatMap(previous => previous.pin?.owner !== group.pin?.owner || (previous.pin?.mode === "workspace" && group.pin?.mode === "workspace" && previous.pin.workspace !== group.pin.workspace)
    ? [previous] : subtractPinPanels([previous], group.panels)), group];
}

/** Read at the existing persistence boundary, reusing layout normalization. */
export function readPins(value: unknown): DockFloat[] {
  if (!Array.isArray(value)) return [];
  let result: DockFloat[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const pin = entry.pin;
    if (!pin || !["workspace", "application", "window", "topmost"].includes(pin.mode)) continue;
    if (pin.mode === "workspace" && typeof pin.workspace !== "string") continue;
    const blank = createDefaultLayout();
    blank.left.panels = []; blank.rail.panels = []; blank.right.groups = []; blank.bottom.groups = []; blank.hidden = {};
    const normalized = normalizeLayout({ ...blank, floats: [entry], agentPanels: pin.agentPanels ?? {}, browserPages: pin.browserPages ?? {} });
    const group = normalized.floats[0];
    if (!group) continue;
    let windowRect;
    if (pin.windowRect && ["x", "y", "width", "height"].every(key => typeof pin.windowRect[key] === "number" && Number.isFinite(pin.windowRect[key]))) windowRect = { ...pin.windowRect };
    group.pin = { mode: pin.mode, ...(pin.coordinateVersion === 1 ? { coordinateVersion: 1 } : {}), ...(typeof pin.owner === "string" ? { owner: pin.owner } : {}), ...(pin.mode === "workspace" ? { workspace: pin.workspace } : {}), ...(windowRect ? { windowRect } : {}), agentPanels: normalized.agentPanels, ...(Object.keys(normalized.browserPages).length ? { browserPages: normalized.browserPages } : {}), ...(["none", "workspace", "application"].includes(pin.returnMode) ? { returnMode: pin.returnMode } : {}) };
    result = putPin(result, group);
  }
  return result;
}
