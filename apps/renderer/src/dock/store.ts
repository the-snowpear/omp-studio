import type { LayoutMemory } from "../settings/appSettings";
import { preserveFileViews, applyBrowserPagePreset, applyInstancePreset, builtInPresets, clampFloat, createDefaultLayout, dockReducer, instancePresetLayout, locatePanel, moveConflicts, normalizeLayout, removePanels, resolveOpenIn } from "./model";
import { projectConversationPanel } from "./conversationPanels";
import { workbenchBounds } from "./workbenchGeometry";
import { pinWorkspace, pinsForScope, putPin, readPins, subtractPinPanels, withPins } from "./pins";
import type { DockFloat, DockPinMode, DockRect } from "./types";
import { WorkbenchWindows, toolWindowId, type WorkbenchWindow } from "./windows";
import { WINDOW_MINIMUM } from "./snap";
import { WORKBENCH_PANELS } from "../panels/registry";
import { isFilePanelId, PANEL_IDS, conversationPanelId, isConversationPanelId, isAgentPanelId, isBrowserPagePanelId, panelBaseId, type DockAction, type DockLayout, type DockPreferences, type DockPreset, type DockScope, type DockSnapshot, type DockTarget, type PanelId } from "./types";

const STORAGE_KEY = "omp.dock.v1";
/** One manual-recovery snapshot of the last good payload; never rewritten. */
const BACKUP_KEY = "omp.dock.v1.backup";
const LEGACY_PREFIX = "omp.layoutMemory.";
const HISTORY_LIMIT = 20;
/** One write per interaction burst; page hide flushes anything still pending. */
const PERSIST_DELAY = 200;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cloneLayout = (layout: DockLayout): DockLayout => dockReducer(createDefaultLayout(), { type: "apply", layout });
const panelId = (value: unknown): value is PanelId => typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);

export function toolWindowMinimum(active: PanelId, panelCount: number) {
  const definition = WORKBENCH_PANELS.find(value => value.id === panelBaseId(active));
  const body = Math.max(definition?.minHeight ?? 0, isConversationPanelId(active) ? 280 : active === "terminal" ? 240 : 0);
  return { width: WINDOW_MINIMUM.width, height: Math.max(WINDOW_MINIMUM.height, body + 42 + (panelCount > 1 ? 36 : 0)) };
}

/** Shared by the project-default setting and inheritance; no display names or epochs. */
export function dockProjectKey(scope: Pick<DockScope, "target" | "project">): string {
  return JSON.stringify([scope.target, scope.project]);
}

function scopeKey(scope: DockScope): string {
  return JSON.stringify([scope.target, scope.project, scope.session, !!scope.draft]);
}

/** A pin carries the descriptors of the Agents and pages it holds, so it can render them in any session. */
function withPinnedInstances<Pin extends object>(pin: Pin, panels: readonly PanelId[], layout: DockLayout): Pin & { agentPanels: DockLayout["agentPanels"]; browserPages?: DockLayout["browserPages"]; fileViews?: DockLayout["fileViews"] } {
  const pick = <Value,>(source: Record<string, Value>, keep: (id: PanelId) => boolean) => Object.fromEntries(panels.filter(keep).flatMap(id => source[id] ? [[id, source[id]]] : [])) as Record<string, Value>;
  const browserPages = pick(layout.browserPages ?? {}, isBrowserPagePanelId);
  return { ...pin, fileViews: pick(layout.fileViews ?? {}, isFilePanelId), agentPanels: pick(layout.agentPanels, isAgentPanelId), ...(Object.keys(browserPages).length ? { browserPages } : {}) };
}

function defaultPreferences(): DockPreferences {
  return { snap: true, locked: false, inherit: false, appDefault: "default", projectDefaults: {} };
}

type LayoutHistoryEntry = { layout: DockLayout; conversation: WorkbenchWindow | undefined };
type History = { undo: LayoutHistoryEntry[]; redo: LayoutHistoryEntry[] };
type Recent = { scopeKey: string; layout: DockLayout };
type StoreState = {
  pins: DockFloat[];
  preferences: DockPreferences;
  presets: DockPreset[];
  layouts: Map<string, DockLayout>;
  saved: Map<string, DockLayout>;
  recent: Map<string, Recent>;
  histories: Map<string, History>;
  drafts: Map<string, string>;
};

function emptyState(): StoreState {
  return { pins: [], preferences: defaultPreferences(), presets: builtInPresets(), layouts: new Map(), saved: new Map(), recent: new Map(), histories: new Map(), drafts: new Map() };
}

function centeredFocusRect(): DockRect {
  const box = typeof document === "undefined" ? undefined : workbenchBounds();
  const width = box?.width || (typeof window === "undefined" ? 1280 : window.innerWidth);
  const height = box?.height || (typeof window === "undefined" ? 900 : window.innerHeight);
  const w = Math.min(1120, Math.max(0, width - 32));
  const h = Math.min(820, height * 0.9, Math.max(0, height - 32));
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: Math.round(w), height: Math.round(h) };
}

function preferences(value: unknown, presets: DockPreset[]): DockPreferences {
  const raw = object(value);
  const ids = new Set(presets.map(preset => preset.id));
  const defaults = defaultPreferences();
  const projectDefaults = Object.fromEntries(Object.entries(object(raw.projectDefaults)).map(([key, id]) => [key, typeof id === "string" && ids.has(id) ? id : "default"]));
  return {
    snap: typeof raw.snap === "boolean" ? raw.snap : defaults.snap,
    locked: typeof raw.locked === "boolean" ? raw.locked : defaults.locked,
    inherit: typeof raw.inherit === "boolean" ? raw.inherit : defaults.inherit,
    appDefault: typeof raw.appDefault === "string" && ids.has(raw.appDefault) ? raw.appDefault : "default",
    projectDefaults,
  };
}

function browserStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function read(storage: Storage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch { return undefined; }
}

/** Only known legacy UI fields are read. Old keys remain untouched. */
function legacyPreset(value: unknown, source: string, id: string): DockPreset | undefined {
  const raw = object(value);
  const booleanFields = ["collapsed", "sideOpen", "bottomOpen", "bottomVisible", "explorerOpen", "btwOpen", "btwMinimized"];
  const numberFields = ["sidebarWidth", "splitRatio", "panelWidth", "bottomHeight", "btwX", "btwY", "btwW", "btwH"];
  if (!booleanFields.some(key => typeof raw[key] === "boolean") && !numberFields.some(key => typeof raw[key] === "number" && Number.isFinite(raw[key])) && !panelId(raw.sideTab) && !panelId(raw.bottomTab) && raw.btwPlacement !== "float" && raw.btwPlacement !== "docked") return undefined;
  const memory = raw as Partial<LayoutMemory>;
  // Legacy memory described the old populated right sidebar.
  let layout = dockReducer(createDefaultLayout(), { type: "move", panels: ["changes", "git", "browser", "computer"], target: { region: "right", groupId: "right-main" } });
  layout.right.visible = false;
  layout.rail.mode = "hidden";
  layout.bottom.visible = true;
  layout.cards.agents.collapsed = false;
  if (typeof memory.collapsed === "boolean") layout.left.visible = !memory.collapsed;
  if (typeof memory.sidebarWidth === "number") layout.left.width = memory.sidebarWidth;
  if (typeof memory.splitRatio === "number") layout.left.ratio = memory.splitRatio;
  if (typeof memory.sideOpen === "boolean") layout.right.visible = memory.sideOpen;
  if (typeof memory.bottomVisible === "boolean") layout.bottom.visible = memory.bottomVisible;
  if (typeof memory.bottomOpen === "boolean") layout.bottom.expanded = memory.bottomOpen;
  if (typeof memory.explorerOpen === "boolean") layout.cards.files.collapsed = !memory.explorerOpen;
  if (typeof memory.panelWidth === "number") layout.right.size = memory.panelWidth;
  if (typeof memory.bottomHeight === "number") layout.bottom.size = memory.bottomHeight;
  if (panelId(memory.bottomTab) && layout.bottom.groups[0]!.panels.includes(memory.bottomTab)) layout.bottom.groups[0]!.active = memory.bottomTab;
  // Agents used to live below the left navigation alongside Files.
  layout = dockReducer(layout, { type: "move", panels: ["agents"], target: { region: "left" } });
  if (typeof memory.collapsed === "boolean") layout.left.visible = !memory.collapsed;
  const rect = { x: memory.btwX ?? 80, y: memory.btwY ?? 60, width: memory.btwW ?? 560, height: memory.btwH ?? 400 };
  const docked = memory.btwPlacement === "docked";
  const btwOpen = typeof memory.btwOpen === "boolean" ? memory.btwOpen : docked;
  layout.hidden.btw = docked ? { region: "right", groupId: layout.right.groups[0]!.id } : { region: "float", rect };
  if (btwOpen) {
    layout = dockReducer(layout, { type: "open", panel: "btw" });
    const floating = layout.floats.find(group => group.panels.includes("btw"));
    if (floating) floating.minimized = memory.btwMinimized === true;
  }
  if (panelId(memory.sideTab) && layout.right.groups[0]!.panels.includes(memory.sideTab)) layout.right.groups[0]!.active = memory.sideTab;
  // Migration preserves the old region switches, even when its selected tool was hidden.
  if (typeof memory.sideOpen === "boolean") layout.right.visible = memory.sideOpen;
  layout.presetId = id;
  return { id, name: `旧布局 · ${source}`, layout: normalizeLayout(layout) };
}

export class DockStore {
  documentId?: string;
  eventWindow?: Window;
  windowManager?: WorkbenchWindows;
  private conversationTitle = "";
  private reconcilingWindows = false;
  private unmigratedWindows = new Set<string>();
  private readonly owner: DockStore | undefined;
  private readonly handles: Set<DockStore>;
  private readonly storage: Storage | null;
  private readonly listeners = new Set<() => void>();
  private readonly real: StoreState;
  private readonly demo: StoreState;
  private scope: DockScope = { target: "local", project: null, session: "initial", draft: true };
  private preview = false;
  private snapshot: DockSnapshot;
  private dirty = false;
  private sequence = 0;
  private modalPanel: PanelId | null = null;
  /** Pending debounced write; a drag resize dispatches per frame but stores once. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Lifecycle listeners exist only while a write is pending. */
  private unwatch: (() => void) | undefined;
  /** Storage refused even the degraded payload: this session keeps everything in memory. */
  private blocked = false;

  constructor(storage?: Storage | null, owner?: DockStore, scope?: DockScope, preview = false) {
    this.owner = owner;
    this.handles = owner?.handles ?? new Set();
    this.handles.add(this);
    if (owner) {
      this.storage = owner.storage;
      this.real = owner.real;
      this.demo = owner.demo;
      this.scope = { ...(scope ?? owner.scope) };
      this.preview = preview;
      if (!this.state.layouts.has(scopeKey(this.scope))) this.state.layouts.set(scopeKey(this.scope), this.startingLayout(this.scope));
      this.snapshot = this.makeSnapshot();
      return;
    }
    this.storage = storage === undefined ? browserStorage() : storage;
    this.real = emptyState();
    const stored = object(read(this.storage, STORAGE_KEY));
    this.real.pins = readPins(stored.pins);
    if (stored.version === 1) {
      const ids = new Set(this.real.presets.map(preset => preset.id));
      if (Array.isArray(stored.presets)) for (const item of stored.presets) {
        const preset = object(item);
        if (typeof preset.id !== "string" || !preset.id || ids.has(preset.id) || typeof preset.name !== "string" || object(preset.layout).version !== 1) continue;
        const layout = normalizeLayout(preset.layout);
        layout.presetId = preset.id;
        this.real.presets.push({ id: preset.id, name: preset.name, layout });
        ids.add(preset.id);
      }
      this.real.preferences = preferences(stored.preferences, this.real.presets);
      for (const [key, value] of Object.entries(object(stored.sessions))) {
        if (object(value).version !== 1) continue;
        const layout = normalizeLayout(value);
        this.real.layouts.set(key, layout);
        this.real.saved.set(key, layout);
      }
      for (const [key, value] of Object.entries(object(stored.recent))) {
        const recent = object(value);
        if (typeof recent.scopeKey === "string" && object(recent.layout).version === 1) this.real.recent.set(key, { scopeKey: recent.scopeKey, layout: normalizeLayout(recent.layout) });
      }
    }
    if (stored.version !== 1 || stored.migrated !== true) {
      this.migrate();
      // Delay the migration write until a real scope is entered. A preview-only
      // mount must not change storage, including the one-time migration marker.
      this.dirty = true;
    }
    this.demo = emptyState();
    this.demo.preferences = { ...this.real.preferences, projectDefaults: { ...this.real.preferences.projectDefaults } };
    this.demo.presets = this.real.presets.map(preset => ({ ...preset, layout: cloneLayout(preset.layout) }));
    this.real.layouts.set(scopeKey(this.scope), createDefaultLayout());
    this.snapshot = this.makeSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  fork(scope: DockScope, preview = false): DockStore {
    const store = new DockStore(undefined, this.owner ?? this, scope, preview);
    store.switchScope(scope, preview);
    return store;
  }

  /** Release a mounted fork, retaining only its shared layout/undo data. */
  dispose(): void {
    if (!this.handles.delete(this)) return;
    this.flush();
    this.listeners.clear();
    delete this.windowManager;
    delete this.eventWindow;
    this.unmigratedWindows.clear();
  }

  getSnapshot = (): DockSnapshot => this.snapshot;
  windowId(groupId: string) { return isConversationPanelId(groupId) ? groupId.slice("conversation:".length) : toolWindowId(this.documentId ?? "standalone", groupId); }
  private conversationWindow() { return this.windowManager?.getSnapshot().records.find(record => record.content.kind === "conversation" && record.content.documentId === this.documentId); }
  removeConversationPanel(viewId: string) {
    const panel = conversationPanelId(viewId);
    const pins = subtractPinPanels(this.state.pins, [panel]);
    if (!equal(pins, this.state.pins)) { this.state.pins = pins; if (!this.preview) this.dirty = true; }
    this.commit(removePanels(this.layout, [panel]), false);
  }
  floatPanels(panels: PanelId[], sourceGroupId?: string, rect?: DockRect): string | undefined {
    const group = this.snapshot.layout.floats.find(value => value.id === sourceGroupId);
    if (group && group.panels.length === panels.length && group.panels.every(panel => panels.includes(panel))) {
      if (rect) this.dispatch({ type: "float", groupId: group.id, rect });
      return group.id;
    }
    this.dispatch({ type: "move", panels, target: { region: "float", ...(rect ? { rect } : {}) } });
    return this.snapshot.layout.floats.find(value => panels.every(panel => value.panels.includes(panel)))?.id;
  }
  /** A region's "add tool" entry: keep an existing instance elsewhere and open a second one here. */
  openIn(panel: PanelId, target: DockTarget): void {
    if (this.state.preferences.locked) return;
    const resolved = resolveOpenIn(this.layout, panel, target);
    if (resolved.kind === "focus") { this.dispatch({ type: "reveal", panel: resolved.panel }); return; }
    this.dispatch({ type: "move", panels: [resolved.panel], target });
    this.dispatch({ type: "reveal", panel: resolved.panel });
  }
  bindWindows(manager: WorkbenchWindows, documentId: string, title: string) {
    this.windowManager = manager;
    this.documentId = documentId;
    this.conversationTitle = title;
    this.publish();
    const unsubscribe = manager.subscribe(() => {
      if (this.reconcilingWindows) return;
      if (this.modalPanel) {
        const group = this.snapshot.layout.floats.find(value => value.panels.includes(this.modalPanel!));
        const record = group && manager.get(this.windowId(group.id));
        if (!record || record.minimized || record.pin !== "none" || manager.cell(record.id) !== undefined) this.modalPanel = null;
      }
      this.publish(false);
    });
    return unsubscribe;
  }
  setConversationTitle(title: string) { if (title !== this.conversationTitle) { this.conversationTitle = title; this.publish(); } }
  private bindWindowGeometry(group: DockFloat): DockFloat {
    const manager = this.windowManager!, id = this.windowId(group.id);
    const { rect, minimized, maximized, ...content } = group;
    return Object.defineProperties({ ...content, windowId: id }, {
      rect: { enumerable: true, get: () => manager.get(id)?.rect ?? rect },
      minimized: { enumerable: true, get: () => manager.get(id)?.minimized ?? minimized },
      maximized: { enumerable: true, get: () => manager.get(id)?.maximized ?? maximized },
    }) as DockFloat;
  }
  private projectLayout(layout: DockLayout): DockLayout {
    const manager = this.windowManager;
    if (!manager) return layout;
    const projected = projectConversationPanel(layout, this.conversationWindow());
    return { ...projected, floats: projected.floats.map(group => {
      const record = manager.get(this.windowId(group.id));
      return record ? { ...group, rect: record.rect, minimized: record.minimized, maximized: record.maximized,
        ...(group.pin ? { pin: { ...group.pin, mode: record.pin === "none" ? group.pin.mode : record.pin, ...(record.nativeRect ? { windowRect: record.nativeRect } : {}) } } : {}) } : group;
    }) };
  }
  private reconcileWindows() {
    const manager = this.windowManager;
    if (!manager || this.reconcilingWindows) return;
    this.reconcilingWindows = true;
    try { manager.transaction(() => {
      const groups = withPins(projectConversationPanel(this.layout, this.conversationWindow(), false), pinsForScope(this.state.pins, this.scope)).floats;
      const ids = new Set(groups.map(group => this.windowId(group.id)));
      for (const record of manager.getSnapshot().records) if (record.content.kind === "tools" && record.content.documentId === this.documentId && !ids.has(record.id)) manager.remove(record.id);
      for (const group of groups) {
        const id = this.windowId(group.id), pin = group.pin?.mode ?? "none";
        const definition = WORKBENCH_PANELS.find(value => value.id === panelBaseId(group.active));
        const conversationActive = isConversationPanelId(group.active);
        const minimum = toolWindowMinimum(group.active, group.panels.length);
        const title = conversationActive ? this.conversationTitle : `${definition?.title ?? this.snapshot?.layout.agentPanels[group.active]?.target.displayName ?? (isFilePanelId(group.active) ? this.snapshot?.layout.fileViews[group.active]?.title || "File" : isBrowserPagePanelId(group.active) ? this.snapshot?.layout.browserPages[group.active]?.title || "Browser" : group.active)}${this.conversationTitle ? ` · ${this.conversationTitle}` : ""}`;
        if (!manager.get(id)) {
          if (group.pin ? group.pin.coordinateVersion !== 1 : this.layout.floatCoordinateVersion !== 1) this.unmigratedWindows.add(id);
          manager.register({ id, content: { kind: "tools", documentId: this.documentId!, groupId: group.id }, title, minimum, placement: pin === "window" || pin === "topmost" ? "native" : "float", pin, rect: group.rect, minimized: group.minimized, maximized: group.maximized, ...(group.pin?.windowRect ? { nativeRect: group.pin.windowRect } : {}) });
        }
        else manager.patch(id, { title, minimum });
      }
      const layout = { ...this.layout, floats: this.layout.floats.map(group => this.bindWindowGeometry(group)) };
      this.state.layouts.set(scopeKey(this.scope), layout);
      if (this.state.saved.has(scopeKey(this.scope))) this.state.saved.set(scopeKey(this.scope), layout);
      this.state.pins = this.state.pins.map(group => ids.has(this.windowId(group.id)) ? this.bindWindowGeometry(group) : group);
    }); } finally { this.reconcilingWindows = false; }
  }
  isPinned = (panel: PanelId): boolean => pinsForScope(this.state.pins, this.scope).some(group => group.panels.includes(panel));

  endModalFocus(panel: PanelId): void {
    if (this.modalPanel !== panel) return;
    this.modalPanel = null;
    this.publish();
  }

  private get state(): StoreState { return this.preview ? this.demo : this.real; }
  private get layout(): DockLayout { return this.state.layouts.get(scopeKey(this.scope))!; }

  private history(): History {
    const key = scopeKey(this.scope);
    let history = this.state.histories.get(key);
    if (!history) this.state.histories.set(key, history = { undo: [], redo: [] });
    return history;
  }

  private makeSnapshot(): DockSnapshot {
    const state = this.state;
    const history = state.histories.get(scopeKey(this.scope));
    const layout = this.layout;
    const preset = state.presets.find(preset => preset.id === layout.presetId)?.layout;
    const baseline = preset && Object.keys(layout.browserPages).length ? instancePresetLayout(applyBrowserPagePreset(preset, layout)) : preset;
    return {
      layout: this.projectLayout(withPins(layout, pinsForScope(state.pins, this.scope))), preferences: state.preferences, presets: state.presets, scope: this.scope, preview: this.preview, modalPanel: this.modalPanel,
      canUndo: !!history?.undo.length, canRedo: !!history?.redo.length,
      modified: !equal(instancePresetLayout(layout), baseline),
    };
  }

  private publish(reconcile = true): void {
    if (reconcile) this.reconcileWindows();
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }

  /**
   * Commits are batched: resizing a card dispatches per frame, and serializing
   * every session layout per frame is what made the dock stutter. Every
   * explicit boundary (scope change, draft handoff, page hide) calls `flush`.
   */
  private queue(): void {
    if (this.preview || !this.dirty || this.blocked) return;
    if (this.owner) { this.owner.dirty = true; this.dirty = false; this.owner.queue(); return; }
    this.watch();
    if (this.timer !== undefined) return;
    this.timer = setTimeout(this.write, PERSIST_DELAY);
  }

  /** Synchronous write; never throws, even when storage is full or blocked. */
  flush(): void {
    if (this.owner) { if (this.preview) return; if (this.dirty) { this.owner.dirty = true; this.dirty = false; } this.owner.flush(); return; }
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    this.write();
  }

  /**
   * The only thing a degraded payload may drop is `recent`: it is a derived
   * cache of "this project's last layout" that is rebuilt on the next save.
   * Everything else - every saved session, every preset, the preferences - is
   * the only copy the user has, so dropping it would be data loss rather than
   * a smaller save.
   */
  private payload(degraded: boolean): string {
    return JSON.stringify({
      version: 1, migrated: true,
      pins: this.real.pins,
      preferences: this.real.preferences,
      presets: this.real.presets.filter(preset => !preset.builtin),
      sessions: Object.fromEntries(this.real.saved),
      recent: degraded ? {} : Object.fromEntries(this.real.recent),
    }, (_key, value: unknown) => {
      if (value && typeof value === "object" && "windowId" in value && "panels" in value) {
        const { rect, minimized, maximized, ...content } = value as DockFloat;
        return content;
      }
      return value;
    });
  }

  /** One-time snapshot of the last successfully stored payload, for manual recovery. */
  private backup(storage: Storage): void {
    if (storage.getItem(BACKUP_KEY)) return;
    const previous = storage.getItem(STORAGE_KEY);
    if (previous) storage.setItem(BACKUP_KEY, previous);
  }

  private write = (): void => {
    this.timer = undefined;
    this.unwatch?.(); this.unwatch = undefined;
    if (this.preview || !this.dirty || this.blocked) return;
    const storage = this.storage;
    if (!storage) { this.dirty = false; return; }
    const full = this.payload(false);
    try {
      storage.setItem(STORAGE_KEY, full);
      this.dirty = false;
      return;
    } catch { /* Full: keep the last good payload, then drop only the cache. */ }
    const degraded = this.payload(true);
    // Only a real degradation is worth a recovery snapshot of the previous payload.
    if (degraded !== full) try { this.backup(storage); } catch { /* Best effort; never blocks the save. */ }
    try {
      storage.setItem(STORAGE_KEY, degraded);
      this.dirty = false;
    } catch {
      // Never replace the stored layout with a partial one: keep the previous
      // payload, keep everything in memory, and stop writing for this session.
      this.blocked = true;
    }
  };

  /** Page hide / backgrounding is the last chance to write a pending layout. */
  private watch(): void {
    if (this.unwatch || typeof window === "undefined") return;
    const leave = () => this.flush();
    const visibility = () => { if (document.hidden) this.flush(); };
    window.addEventListener("pagehide", leave);
    window.addEventListener("beforeunload", leave);
    document.addEventListener("visibilitychange", visibility);
    this.unwatch = () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("beforeunload", leave);
      document.removeEventListener("visibilitychange", visibility);
      this.unwatch = undefined;
    };
  }

  private save(scope: DockScope, layout: DockLayout): void {
    const state = this.state;
    const key = scopeKey(scope);
    state.layouts.set(key, layout);
    if (!scope.draft || Object.keys(layout.cards).some(isConversationPanelId)) {
      state.saved.set(key, layout);
      if (scope.project !== null) state.recent.set(dockProjectKey(scope), { scopeKey: key, layout });
      if (!this.preview) this.dirty = true;
    }
  }

  private commit(layout: DockLayout, undoable = true, conversation = this.conversationWindow()): void {
    if (layout === this.layout) return;
    if (undoable) {
      const history = this.history();
      history.undo.push({ layout: this.layout, conversation });
      if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
      history.redo = [];
    }
    this.save(this.scope, layout);
    this.queue();
    this.publish();
  }

  migrateFloatCoordinates(previous: DockRect, current: DockRect) {
    const convert = (rect: DockRect) => {
      const shown = clampFloat(rect, { width: previous.width, height: previous.height });
      return { ...shown, x: shown.x + previous.x - current.x, y: shown.y + previous.y - current.y };
    };
    let changed = false;
    if (this.windowManager && this.unmigratedWindows.size) this.windowManager.transaction(() => {
      for (const id of this.unmigratedWindows) {
        const record = this.windowManager!.get(id);
        if (record) this.windowManager!.patch(id, { rect: convert(record.rect) });
      }
      this.unmigratedWindows.clear();
    });
    if (this.layout.floatCoordinateVersion !== 1) {
      this.save(this.scope, { ...this.layout, floatCoordinateVersion: 1,
        floats: this.layout.floats.map(group => ({ ...group, rect: convert(group.rect) })),
        hidden: Object.fromEntries(Object.entries(this.layout.hidden).map(([id, location]) => [id, location?.region === "float" && location.rect ? { ...location, rect: convert(location.rect) } : location])),
      });
      changed = true;
    }
    const active = new Set(pinsForScope(this.state.pins, this.scope).filter(group => group.pin?.coordinateVersion !== 1).map(group => group.id));
    if (active.size) {
      this.state.pins = this.state.pins.map(group => active.has(group.id) ? { ...group, rect: convert(group.rect), pin: { ...group.pin!, coordinateVersion: 1 } } : group);
      changed = true;
    }
    if (changed) { if (!this.preview) this.dirty = true; this.queue(); this.publish(); }
  }

  dispatch(action: DockAction): void {
    const manager = this.windowManager;
    if (action.type === "move" && action.target.region === "rail" && action.panels.some(isConversationPanelId)) return;
    // A tool lives once per region: dropping it onto its own twin focuses the
    // twin instead of creating a second copy (and never enters the undo stack).
    if (action.type === "move" && !this.state.preferences.locked) {
      const conflict = moveConflicts(this.layout, action.panels, action.target);
      if (conflict.length && action.panels.length === 1) action = { type: "reveal", panel: conflict[0]! };
    }
    if (manager && action.type === "raise") { manager.activate(this.windowId(action.groupId)); return; }
    if (manager && action.type === "float") {
      if (this.snapshot.preferences.locked && action.rect) return;
      const id = this.windowId(action.groupId);
      manager.transaction(() => {
        if (action.rect) manager.float(id, action.rect);
        if (action.minimized === true) manager.minimize(id);
        if (action.minimized === false) manager.activate(id);
        if (action.maximized !== undefined && manager.get(id)?.maximized !== action.maximized) manager.maximize(id);
      });
      return;
    }
    if (manager && (action.type === "open" || action.type === "reveal" || action.type === "browser-page-open" && action.reveal)) {
      const group = this.snapshot.layout.floats.find(value => value.panels.includes(action.panel));
      if (group) manager.activate(this.windowId(group.id));
    }
    if (action.type === "open" && (action.panel === "context-viewer" || action.panel === "annotations")
      && !locatePanel(this.snapshot.layout, action.panel)) {
      this.save(this.scope, { ...this.layout, hidden: { ...this.layout.hidden, [action.panel]: { region: "float", rect: centeredFocusRect() } } });
      this.modalPanel = action.panel;
    }
    const activePins = pinsForScope(this.state.pins, this.scope);
    const effective = dockReducer(this.snapshot.layout, action, this.state.preferences.locked);
    if (this.modalPanel) {
      const focused = effective.floats.find(group => group.panels.includes(this.modalPanel!));
      if (action.type === "apply" || !focused || focused.minimized || focused.pin || focused.panels.length !== 1) this.modalPanel = null;
    }
    const pinIds = new Set(activePins.map(group => group.id));
    let pinsChanged = false;
    if (action.type !== "apply" && effective !== this.snapshot.layout && activePins.length) {
      const updated = effective.floats.filter(group => pinIds.has(group.id)).map(group => ({ ...group, pin: withPinnedInstances(activePins.find(old => old.id === group.id)!.pin!, group.panels, effective) }));
      const inactive = this.state.pins.filter(group => !pinIds.has(group.id));
      const nextPins = updated.reduce((pins, group) => putPin(pins, group), inactive);
      pinsChanged = !equal(nextPins, this.state.pins);
      if (pinsChanged) { this.state.pins = nextPins; if (!this.preview) this.dirty = true; }
    }
    // A destination pin owns the moved panels; the session retains their return locations.
    const intoPin = action.type === "move" && action.target.region === "float" && pinIds.has(action.target.groupId ?? "");
    const conversation = this.conversationWindow();
    let base = intoPin ? this.layout : dockReducer(conversation ? projectConversationPanel(this.layout, conversation) : this.layout, action, this.state.preferences.locked);
    if (conversation && manager) {
      const panel = conversationPanelId(conversation.id);
      const location = locatePanel(effective, panel);
      const touched = (action.type === "move" || action.type === "hide") && action.panels.includes(panel) || action.type === "open" && action.panel === panel;
      const group = location?.region === "float" ? effective.floats.find(group => group.id === location.groupId) : undefined;
      if (group?.id === panel && group.panels.length > 1) base = { ...base, floats: base.floats.map(value => value.id === panel ? { ...value, id: `group:${panel}` } : value) };
      this.reconcilingWindows = true;
      try {
        if (location && (touched || conversation.placement === "docked" || group && group.panels.length > 1)) {
          if (group?.panels.length === 1) {
            manager.float(conversation.id, group.rect);
            base = removePanels(base, [panel]);
          } else manager.dock(conversation.id);
        } else if (!location && touched) {
          manager.float(conversation.id);
          manager.minimize(conversation.id);
          base = removePanels(base, [panel]);
        }
        if (manager.get(conversation.id)?.placement !== "docked") base = removePanels(base, [panel]);
      } finally { this.reconcilingWindows = false; }
    }
    // Page tabs follow the browser's own state, so undo must never restore a closed page or drop an open one.
    if (base !== this.layout) this.commit(base, action.type !== "activate" && action.type !== "reveal" && action.type !== "raise" && action.type !== "agent-focus" && !action.type.startsWith("browser-page-") && !action.type.startsWith("file-"), conversation);
    else if (pinsChanged) { this.queue(); this.publish(); }
    if (action.type === "file-close") {
      this.state.pins = subtractPinPanels(this.state.pins, action.panels);
      for (const [key, layout] of this.state.layouts) {
        const next = dockReducer(layout, action);
        if (next === layout) continue;
        this.state.layouts.set(key, next);
        if (this.state.saved.has(key)) this.state.saved.set(key, next);
      }
      for (const [key, recent] of this.state.recent) this.state.recent.set(key, { ...recent, layout: dockReducer(recent.layout, action) });
      if (!this.preview) this.dirty = true;
      this.queue();
      for (const handle of this.handles) if (handle.preview === this.preview) handle.publish();
    }
    // One contract for every region switch, whichever menu or button caused it.
    if (action.type === "region" && typeof window !== "undefined") {
      (this.eventWindow ?? window).dispatchEvent(new CustomEvent("omp:dock-region", { detail: { documentId: this.documentId, region: action.region, visible: action.visible } }));
    }
    if ((action.type === "open" || action.type === "reveal" || action.type === "agent-open" || action.type === "browser-page-open" && action.reveal) && typeof window !== "undefined") requestAnimationFrame(() => {
      (this.eventWindow ?? window).dispatchEvent(new CustomEvent("omp:dock-open", { detail: { documentId: this.documentId, panel: action.panel } }));
    });
  }

  setPin(groupId: string, mode: DockPinMode): void {
    const group = this.snapshot.layout.floats.find(item => item.id === groupId);
    if (!group || (mode === "workspace" && this.scope.project === null) || (group.pin?.mode ?? "none") === mode) return;
    if (this.modalPanel && group.panels.includes(this.modalPanel) && mode !== "none") this.modalPanel = null;
    this.state.pins = this.state.pins.filter(item => item.id !== group.id);
    if (mode === "none") {
      let base = this.layout;
      for (const panel of group.panels) if (isAgentPanelId(panel)) {
        const descriptor = this.snapshot.layout.agentPanels[panel];
        if (descriptor && !base.agentPanels[panel]) base = dockReducer(base, { type: "agent-open", panel, descriptor });
      }
      // Another chat's pages go home to that chat's layout instead of joining this one.
      for (const panel of group.panels) if (isFilePanelId(panel) && !base.fileViews[panel]) {
        const descriptor = this.snapshot.layout.fileViews[panel];
        if (descriptor) base = dockReducer(base, { type: "file-open", panel, descriptor });
      }
      const panels = group.panels.filter(panel => !isBrowserPagePanelId(panel) || this.snapshot.layout.browserPages[panel]?.sessionId === this.scope.session);
      for (const panel of panels) if (isBrowserPagePanelId(panel) && !base.browserPages[panel]) base = dockReducer(base, { type: "browser-page-open", panel, descriptor: this.snapshot.layout.browserPages[panel]!, reveal: false });
      let next = panels.length ? dockReducer(base, { type: "move", panels, target: { region: "float", groupId: group.id, rect: group.rect } }) : base;
      if (panels.includes(group.active)) next = dockReducer(next, { type: "activate", groupId: group.id, panel: group.active });
      this.save(this.scope, next);
    } else {
      const id = group.pin || this.windowManager ? group.id : `pin-${crypto.randomUUID()}`;
      const nativeToggle = (mode === "window" || mode === "topmost") && (group.pin?.mode === "window" || group.pin?.mode === "topmost");
      const returnMode = group.pin?.mode === "window" || group.pin?.mode === "topmost" ? group.pin.returnMode ?? "application" : group.pin?.mode ?? "none";
      this.state.pins = putPin(this.state.pins, { ...group, id, minimized: nativeToggle && group.minimized, maximized: nativeToggle && group.maximized,
        pin: { ...withPinnedInstances({ mode }, group.panels, this.snapshot.layout), mode, returnMode, coordinateVersion: 1, ...(this.owner ? { owner: scopeKey(this.scope) } : {}), ...(mode === "workspace" ? { workspace: pinWorkspace(this.scope) } : {}), ...(group.pin?.windowRect ? { windowRect: group.pin.windowRect } : {}) } });
    }
    this.windowManager?.setPin(this.windowId(groupId), mode);
    if (!this.preview) this.dirty = true;
    this.queue(); this.publish();
    if (mode === "workspace" || mode === "none") for (const panel of group.panels) {
      if (isFilePanelId(panel) && this.snapshot.layout.fileViews[panel]?.scope !== (mode === "workspace" ? "workspace" : "conversation")) {
        this.dispatch({ type: "file-state", panel, patch: { scope: mode === "workspace" ? "workspace" : "conversation" } });
      }
    }
  }

  setNativeState(groupId: string, state: { rect: DockRect; minimized: boolean; maximized: boolean }): void {
    if (this.windowManager) { this.windowManager.patch(this.windowId(groupId), { nativeRect: state.rect, minimized: state.minimized, maximized: state.maximized }); return; }
    const group = this.state.pins.find(item => item.id === groupId);
    if (!group?.pin) return;
    const next = { ...group, minimized: state.minimized, maximized: state.maximized, pin: { ...group.pin, windowRect: state.rect } };
    if (equal(group, next)) return;
    this.state.pins = this.state.pins.map(item => item === group ? next : item);
    if (!this.preview) this.dirty = true;
    this.queue(); this.publish();
  }

  private startingLayout(scope: DockScope, inherit = false): DockLayout {
    if (inherit && this.state.preferences.inherit && scope.project !== null) {
      const recent = this.state.recent.get(dockProjectKey(scope));
      if (recent) return instancePresetLayout(recent.layout);
    }
    const prefs = this.state.preferences;
    const projectDefault = scope.project === null ? undefined : prefs.projectDefaults[dockProjectKey(scope)];
    const preset = this.state.presets.find(item => item.id === projectDefault)
      ?? this.state.presets.find(item => item.id === prefs.appDefault)
      ?? this.state.presets[0]!;
    return cloneLayout(preset.layout);
  }

  switchScope(scope: DockScope, preview: boolean): void {
    const key = scopeKey(scope);
    if (this.preview === preview && scopeKey(this.scope) === key) { this.flush(); return; }
    this.modalPanel = null;
    // A scope change is a hard boundary: batched writes from the previous scope
    // land now, and entering preview never writes real state.
    if (!preview) this.flush();
    this.preview = preview;
    this.scope = { ...scope };
    if (this.owner && !scope.draft) this.state.pins = this.state.pins.map(group => group.pin && !group.pin.owner ? { ...group, pin: { ...group.pin, owner: key } } : group);
    if (!this.state.layouts.has(key) || (!scope.draft && !this.state.saved.has(key))) this.state.layouts.set(key, this.startingLayout(scope));
    this.flush();
    this.publish();
  }

  beginDraft(scope: DockScope): void {
    this.flush();
    this.modalPanel = null;
    const draft = { ...scope, draft: true };
    const key = scopeKey(draft);
    const layout = this.startingLayout(draft, true);
    this.state.layouts.set(key, layout);
    this.state.histories.delete(key);
    this.state.drafts.set(dockProjectKey(draft), key);
    this.scope = draft;
    this.publish();
  }

  adoptDraft(scope: DockScope, origin?: { scope: DockScope; preview: boolean }): void {
    const formal = { ...scope, draft: false };
    const state = origin ? (origin.preview ? this.demo : this.real) : this.state;
    const project = dockProjectKey(formal);
    const namespaceMatches = !origin || this.preview === origin.preview;
    const currentIsDraft = namespaceMatches && !!this.scope.draft && dockProjectKey(this.scope) === project && (!origin || scopeKey(this.scope) === scopeKey(origin.scope));
    const draftKey = origin ? scopeKey(origin.scope) : currentIsDraft ? scopeKey(this.scope) : state.drafts.get(project);
    if (!draftKey) return;
    const draft = state.layouts.get(draftKey);
    if (!draft) return;
    const key = scopeKey(formal);
    if (this.owner) state.pins = state.pins.map(group => group.pin?.owner === draftKey ? { ...group, pin: { ...group.pin, owner: key } } : group);
    const history = state.histories.get(draftKey);
    const adopted = cloneLayout(draft);
    state.layouts.set(key, adopted);
    state.saved.set(key, adopted);
    if (formal.project !== null) state.recent.set(project, { scopeKey: key, layout: adopted });
    if (state === this.real) this.dirty = true;
    if (history) state.histories.set(key, { undo: [...history.undo], redo: [...history.redo] });
    state.layouts.delete(draftKey);
    state.histories.delete(draftKey);
    state.drafts.delete(project);
    if (currentIsDraft) this.scope = formal;
    this.flush();
    this.publish();
  }

  deleteSession(scope: DockScope): void {
    const formal = { ...scope, draft: false };
    const key = scopeKey(formal);
    const state = this.state;
    state.saved.delete(key);
    state.layouts.delete(key);
    state.histories.delete(key);
    const project = dockProjectKey(formal);
    if (state.recent.get(project)?.scopeKey === key) state.recent.delete(project);
    if (scopeKey(this.scope) === key) state.layouts.set(key, this.startingLayout(formal));
    if (!this.preview) this.dirty = true;
    this.flush();
    this.publish();
  }

  undo(): void {
    const history = this.history();
    const entry = history.undo.pop();
    if (!entry) return;
    this.modalPanel = null;
    history.redo.push({ layout: this.layout, conversation: this.conversationWindow() });
    this.save(this.scope, preserveFileViews(entry.layout, this.layout));
    if (entry.conversation) this.windowManager?.patch(entry.conversation.id, entry.conversation);
    this.flush();
    this.publish();
  }

  redo(): void {
    const history = this.history();
    const entry = history.redo.pop();
    if (!entry) return;
    this.modalPanel = null;
    history.undo.push({ layout: this.layout, conversation: this.conversationWindow() });
    this.save(this.scope, preserveFileViews(entry.layout, this.layout));
    if (entry.conversation) this.windowManager?.patch(entry.conversation.id, entry.conversation);
    this.flush();
    this.publish();
  }

  updatePreferences(patch: Partial<DockPreferences>): void {
    const next = preferences({ ...this.state.preferences, ...patch }, this.state.presets);
    if (equal(next, this.state.preferences)) return;
    this.state.preferences = next;
    if (!this.preview) this.dirty = true;
    this.flush();
    for (const handle of this.handles) if (handle.preview === this.preview) handle.publish();
  }

  private putPreset(preset: DockPreset): void {
    const index = this.state.presets.findIndex(item => item.id === preset.id);
    this.state.presets = index < 0 ? [...this.state.presets, preset] : this.state.presets.map(item => item.id === preset.id ? preset : item);
    if (!this.preview) this.dirty = true;
    // Save/update changes the baseline, not the arrangement or its undo stack.
    const layout = dockReducer(this.layout, { type: "apply", layout: { ...this.layout, presetId: preset.id } });
    if (layout !== this.layout) this.commit(layout, false);
    else this.publish();
    // Presets are discrete edits, so they skip the batch window.
    this.flush();
  }

  savePreset(name: string): string {
    const title = name.trim();
    if (!title) return "";
    let id: string;
    do { id = `custom-${Date.now().toString(36)}-${++this.sequence}`; } while (this.state.presets.some(preset => preset.id === id));
    const layout = instancePresetLayout(this.layout);
    layout.presetId = id;
    this.putPreset({ id, name: title, layout });
    return id;
  }

  updatePreset(id: string): void {
    const preset = this.state.presets.find(item => item.id === id);
    if (!preset || preset.builtin) return;
    const layout = instancePresetLayout(this.layout);
    layout.presetId = id;
    this.putPreset({ ...preset, layout });
  }

  renamePreset(id: string, name: string): void {
    const preset = this.state.presets.find(item => item.id === id);
    if (!preset || preset.builtin || !name.trim() || preset.name === name.trim()) return;
    this.state.presets = this.state.presets.map(item => item.id === id ? { ...item, name: name.trim() } : item);
    if (!this.preview) this.dirty = true;
    this.flush();
    this.publish();
  }

  deletePreset(id: string): void {
    const preset = this.state.presets.find(item => item.id === id);
    if (!preset || preset.builtin) return;
    this.state.presets = this.state.presets.filter(item => item.id !== id);
    const prefs = this.state.preferences;
    this.state.preferences = { ...prefs, appDefault: prefs.appDefault === id ? "default" : prefs.appDefault, projectDefaults: Object.fromEntries(Object.entries(prefs.projectDefaults).map(([key, value]) => [key, value === id ? "default" : value])) };
    // Existing session layouts, including their now-deleted baseline ID, survive.
    if (!this.preview) this.dirty = true;
    this.flush();
    this.publish();
  }

  applyPreset(id: string): void {
    const preset = this.state.presets.find(item => item.id === id);
    if (preset) this.dispatch({ type: "apply", layout: applyInstancePreset(preset.layout, this.layout) });
  }

  resetPreset(): void {
    this.applyPreset(this.state.presets.some(preset => preset.id === this.layout.presetId) ? this.layout.presetId : "default");
  }

  resetFactory(): void { this.dispatch({ type: "apply", layout: applyInstancePreset(createDefaultLayout(), this.layout) }); }

  private migrate(): void {
    try {
      const keys: string[] = [];
      for (let index = 0; index < (this.storage?.length ?? 0); index++) {
        const key = this.storage?.key(index);
        if (key?.startsWith(LEGACY_PREFIX)) keys.push(key);
      }
      keys.sort();
      for (const key of keys) {
        const source = key.slice(LEGACY_PREFIX.length);
        const id = `legacy-${encodeURIComponent(source)}`;
        if (this.real.presets.some(preset => preset.id === id)) continue;
        const preset = legacyPreset(read(this.storage, key), source === "global" ? "全局" : source, id);
        if (preset) this.real.presets.push(preset);
      }
    } catch { /* Storage enumeration can be unavailable even when getItem works. */ }
  }
}
