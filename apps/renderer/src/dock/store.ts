import type { LayoutMemory } from "../settings/appSettings";
import { builtInPresets, createDefaultLayout, dockReducer, normalizeLayout } from "./model";
import { PANEL_IDS, type DockAction, type DockLayout, type DockPreferences, type DockPreset, type DockScope, type DockSnapshot, type PanelId } from "./types";

const STORAGE_KEY = "omp.dock.v1";
const LEGACY_PREFIX = "omp.layoutMemory.";
const HISTORY_LIMIT = 20;
/** One write per interaction burst; page hide flushes anything still pending. */
const PERSIST_DELAY = 200;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cloneLayout = (layout: DockLayout): DockLayout => dockReducer(createDefaultLayout(), { type: "apply", layout });
const panelId = (value: unknown): value is PanelId => typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);

/** Shared by the project-default setting and inheritance; no display names or epochs. */
export function dockProjectKey(scope: Pick<DockScope, "target" | "project">): string {
  return JSON.stringify([scope.target, scope.project]);
}

function scopeKey(scope: DockScope): string {
  return JSON.stringify([scope.target, scope.project, scope.session, !!scope.draft]);
}

function defaultPreferences(): DockPreferences {
  return { snap: true, locked: false, inherit: false, appDefault: "default", projectDefaults: {} };
}

type History = { undo: DockLayout[]; redo: DockLayout[] };
type Recent = { scopeKey: string; layout: DockLayout };
type StoreState = {
  preferences: DockPreferences;
  presets: DockPreset[];
  layouts: Map<string, DockLayout>;
  saved: Map<string, DockLayout>;
  recent: Map<string, Recent>;
  histories: Map<string, History>;
  drafts: Map<string, string>;
};

function emptyState(): StoreState {
  return { preferences: defaultPreferences(), presets: builtInPresets(), layouts: new Map(), saved: new Map(), recent: new Map(), histories: new Map(), drafts: new Map() };
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
  let layout = createDefaultLayout();
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
  private readonly storage: Storage | null;
  private readonly listeners = new Set<() => void>();
  private readonly real: StoreState;
  private readonly demo: StoreState;
  private scope: DockScope = { target: "local", project: null, session: "initial", draft: true };
  private preview = false;
  private snapshot: DockSnapshot;
  private dirty = false;
  private sequence = 0;
  /** Pending debounced write; a drag resize dispatches per frame but stores once. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Lifecycle listeners exist only while a write is pending. */
  private unwatch: (() => void) | undefined;
  /** Storage refused even the lean payload: this session keeps everything in memory. */
  private blocked = false;

  constructor(storage?: Storage | null) {
    this.storage = storage === undefined ? browserStorage() : storage;
    this.real = emptyState();
    const stored = object(read(this.storage, STORAGE_KEY));
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

  getSnapshot = (): DockSnapshot => this.snapshot;

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
    return {
      layout, preferences: state.preferences, presets: state.presets, scope: this.scope, preview: this.preview,
      canUndo: !!history?.undo.length, canRedo: !!history?.redo.length,
      modified: !equal(layout, state.presets.find(preset => preset.id === layout.presetId)?.layout),
    };
  }

  private publish(): void {
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
    this.watch();
    if (this.timer !== undefined) return;
    this.timer = setTimeout(this.write, PERSIST_DELAY);
  }

  /** Synchronous write; never throws, even when storage is full or blocked. */
  flush(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    this.write();
  }

  private payload(slim: boolean): string {
    const current = scopeKey(this.scope);
    const sessions: Record<string, DockLayout> = slim
      ? Object.fromEntries(this.real.saved.has(current) ? [[current, this.real.saved.get(current)!]] : [])
      : Object.fromEntries(this.real.saved);
    return JSON.stringify({
      version: 1, migrated: true,
      preferences: this.real.preferences,
      presets: this.real.presets.filter(preset => !preset.builtin),
      sessions,
      recent: slim ? {} : Object.fromEntries(this.real.recent),
    });
  }

  private write = (): void => {
    this.timer = undefined;
    this.unwatch?.(); this.unwatch = undefined;
    if (this.preview || !this.dirty || this.blocked) return;
    if (!this.storage) { this.dirty = false; return; }
    try {
      this.storage.setItem(STORAGE_KEY, this.payload(false));
      this.dirty = false;
      return;
    } catch { /* Full or blocked: retry once with the layout that matters now. */ }
    try {
      this.storage.setItem(STORAGE_KEY, this.payload(true));
      this.dirty = false;
    } catch {
      // One degradation per session: keep working in memory, stop retrying.
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
    if (!scope.draft) {
      state.saved.set(key, layout);
      if (scope.project !== null) state.recent.set(dockProjectKey(scope), { scopeKey: key, layout });
      if (!this.preview) this.dirty = true;
    }
  }

  private commit(layout: DockLayout, undoable = true): void {
    if (layout === this.layout) return;
    if (undoable) {
      const history = this.history();
      history.undo.push(this.layout);
      if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
      history.redo = [];
    }
    this.save(this.scope, layout);
    this.queue();
    this.publish();
  }

  dispatch(action: DockAction): void {
    this.commit(dockReducer(this.layout, action, this.state.preferences.locked), action.type !== "activate" && action.type !== "raise");
    // One contract for every region switch, whichever menu or button caused it.
    if (action.type === "region" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("omp:dock-region", { detail: { region: action.region, visible: action.visible } }));
    }
    if (action.type === "open" && typeof window !== "undefined") requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("omp:dock-open", { detail: { panel: action.panel } }));
    });
  }

  private startingLayout(scope: DockScope, inherit = false): DockLayout {
    if (inherit && this.state.preferences.inherit && scope.project !== null) {
      const recent = this.state.recent.get(dockProjectKey(scope));
      if (recent) return cloneLayout(recent.layout);
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
    // A scope change is a hard boundary: batched writes from the previous scope
    // land now, and entering preview never writes real state.
    if (!preview) this.flush();
    this.preview = preview;
    this.scope = { ...scope };
    if (!this.state.layouts.has(key) || (!scope.draft && !this.state.saved.has(key))) this.state.layouts.set(key, this.startingLayout(scope));
    this.flush();
    this.publish();
  }

  beginDraft(scope: DockScope): void {
    this.flush();
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
    const layout = history.undo.pop();
    if (!layout) return;
    history.redo.push(this.layout);
    this.save(this.scope, layout);
    this.flush();
    this.publish();
  }

  redo(): void {
    const history = this.history();
    const layout = history.redo.pop();
    if (!layout) return;
    history.undo.push(this.layout);
    this.save(this.scope, layout);
    this.flush();
    this.publish();
  }

  updatePreferences(patch: Partial<DockPreferences>): void {
    const next = preferences({ ...this.state.preferences, ...patch }, this.state.presets);
    if (equal(next, this.state.preferences)) return;
    this.state.preferences = next;
    if (!this.preview) this.dirty = true;
    this.flush();
    this.publish();
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
    const layout = cloneLayout(this.layout);
    layout.presetId = id;
    this.putPreset({ id, name: title, layout });
    return id;
  }

  updatePreset(id: string): void {
    const preset = this.state.presets.find(item => item.id === id);
    if (!preset || preset.builtin) return;
    const layout = cloneLayout(this.layout);
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
    if (preset) this.dispatch({ type: "apply", layout: preset.layout });
  }

  resetPreset(): void {
    this.applyPreset(this.state.presets.some(preset => preset.id === this.layout.presetId) ? this.layout.presetId : "default");
  }

  resetFactory(): void { this.dispatch({ type: "apply", layout: createDefaultLayout() }); }

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
