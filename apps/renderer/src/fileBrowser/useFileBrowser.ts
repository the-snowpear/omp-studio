import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COMPUTER, parentPath, samePath, sortEntries, visibleEntries, within, type BrowserView, type FileBrowserSource, type FsDirectory, type FsEntry, type FsPlaces, type SortState } from "./model";

export interface DirState { readonly status: "loading" | "ready" | "error"; readonly dir?: FsDirectory; readonly error?: string }
export type EditState = { readonly kind: "rename"; readonly path: string; readonly draft: string; readonly error?: string; readonly busy?: boolean }
  | { readonly kind: "new"; readonly parent: string; readonly draft: string; readonly error?: string; readonly busy?: boolean };
export interface Notice { readonly tone: "ok" | "error"; readonly text: string; readonly key: number }

/** 每个面板实例自己的记忆：位置、显式视图、排序、隐藏文件、位置栏宽度。只是界面便利，读写失败就当没有。 */
interface Memory { path?: string; view?: BrowserView | null; sort?: SortState; hidden?: boolean; places?: number }
const MEMORY_KEY = "omp.fileBrowser.v1";
const PINS_KEY = "omp.fileBrowser.pins.v1";
function readStore<T>(key: string): Record<string, T> {
  try { const value = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown; return value && typeof value === "object" ? value as Record<string, T> : {}; } catch { return {}; }
}
function writeStore<T>(key: string, id: string, value: T | undefined) {
  try {
    const all = readStore<T>(key);
    if (value === undefined) delete all[id]; else all[id] = value;
    const ids = Object.keys(all);
    for (const stale of ids.slice(0, Math.max(0, ids.length - 48))) delete all[stale];
    localStorage.setItem(key, JSON.stringify(all));
  } catch { /* storage unavailable: memory is a convenience */ }
}

const DEFAULT_SORT: SortState = { key: "name", dir: 1 };

export function useFileBrowser(source: FileBrowserSource | null, memoryId: string, pinScope: string) {
  const memory = useMemo(() => readStore<Memory>(MEMORY_KEY)[memoryId] ?? {}, [memoryId]);
  const [places, setPlaces] = useState<FsPlaces>();
  const [placesError, setPlacesError] = useState<string>();
  const [path, setPathState] = useState<string | undefined>(memory.path);
  const [back, setBack] = useState<string[]>([]);
  const [forward, setForward] = useState<string[]>([]);
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirState>>(() => new Map());
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [sort, setSort] = useState<SortState>(memory.sort ?? DEFAULT_SORT);
  const [showHidden, setShowHidden] = useState(memory.hidden ?? false);
  const [explicitView, setExplicitView] = useState<BrowserView | null>(memory.view ?? null);
  const [placesWidth, setPlacesWidth] = useState(memory.places ?? 200);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [edit, setEdit] = useState<EditState>();
  const [confirmTrash, setConfirmTrash] = useState<readonly FsEntry[]>();
  const [notice, setNotice] = useState<Notice>();
  const [pins, setPins] = useState<readonly string[]>(() => readStore<string[]>(PINS_KEY)[pinScope] ?? []);
  const requested = useRef(new Set<string>());
  const sep = places?.separator ?? "\\";
  const keyOf = useCallback((value: string) => sep === "\\" ? value.toLowerCase() : value, [sep]);

  useEffect(() => { setPins(readStore<string[]>(PINS_KEY)[pinScope] ?? []); }, [pinScope]);
  useEffect(() => {
    setPlaces(undefined); setPlacesError(undefined); setDirs(new Map()); requested.current.clear();
    if (!source) return;
    let live = true;
    source.places().then(value => { if (live) setPlaces(value); }, error => { if (live) setPlacesError(error instanceof Error ? error.message : String(error)); });
    return () => { live = false; };
  }, [source]);

  const load = useCallback((target: string, force = false) => {
    if (!source) return;
    const key = keyOf(target);
    if (!force && requested.current.has(key)) return;
    requested.current.add(key);
    setDirs(previous => new Map(previous).set(key, { status: "loading", ...(previous.get(key)?.dir ? { dir: previous.get(key)!.dir! } : {}) }));
    source.list(target).then(
      dir => setDirs(previous => new Map(previous).set(key, { status: "ready", dir })),
      error => setDirs(previous => new Map(previous).set(key, { status: "error", error: error instanceof Error ? error.message : String(error) })),
    );
  }, [source, keyOf]);
  const dirState = useCallback((target: string): DirState | undefined => dirs.get(keyOf(target)), [dirs, keyOf]);

  // 第一次拿到位置时落到记忆的位置，没有就去主目录。
  const current = path ?? places?.home;
  useEffect(() => { if (places && current !== undefined) load(current); }, [places, current, load]);

  const notify = useCallback((tone: Notice["tone"], text: string) => setNotice({ tone, text, key: Date.now() }), []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(undefined), 3200); return () => clearTimeout(timer); }, [notice]);

  const persist = useCallback((patch: Partial<Memory>) => { writeStore<Memory>(MEMORY_KEY, memoryId, { ...readStore<Memory>(MEMORY_KEY)[memoryId], ...patch }); }, [memoryId]);

  /** 树视图里把当前位置的祖先全部展开，切过去时直接看到自己在哪。 */
  const revealInTree = useCallback((target: string) => {
    if (!places) return;
    const chain: string[] = [];
    for (let item = target; item !== COMPUTER && chain.length < 64; item = parentPath(item, places.separator)) chain.push(item);
    for (const item of chain) load(item);
    setExpanded(previous => { const next = new Set(previous); for (const item of chain) next.add(keyOf(item)); return next; });
  }, [places, keyOf, load]);

  /** `reveal: false` 用于树里点选：只让面包屑跟上，不再替用户展开。 */
  const go = useCallback((target: string, options: { select?: string | undefined; record?: boolean; reveal?: boolean } = {}) => {
    const moved = current === undefined || !samePath(current, target, sep);
    if (current !== undefined && options.record !== false && moved) { setBack(stack => [...stack.slice(-63), current]); setForward([]); }
    setPathState(target); setEdit(undefined);
    if (moved) setFilter("");
    setSelection(options.select ? [options.select] : []);
    persist({ path: target });
    load(target);
    if (options.reveal !== false) revealInTree(target);
  }, [current, sep, persist, load, revealInTree]);
  const goBack = useCallback(() => {
    const target = back[back.length - 1];
    if (target === undefined || current === undefined) return;
    setBack(stack => stack.slice(0, -1)); setForward(stack => [current, ...stack]);
    go(target, { record: false, select: current });
  }, [back, current, go]);
  const goForward = useCallback(() => {
    const [target, ...rest] = forward;
    if (target === undefined || current === undefined) return;
    setForward(rest); setBack(stack => [...stack, current]);
    go(target, { record: false });
  }, [forward, current, go]);
  const goUp = useCallback(() => { if (current !== undefined && current !== COMPUTER) go(parentPath(current, sep), { select: current }); }, [current, sep, go]);
  const refresh = useCallback(() => {
    if (current === undefined) return;
    requested.current.clear();
    load(current, true);
    for (const key of expanded) { const dir = dirs.get(key)?.dir; if (dir) load(dir.path, true); }
  }, [current, expanded, dirs, load]);

  const toggleExpanded = useCallback((target: string) => {
    const key = keyOf(target), opening = !expanded.has(key);
    if (opening) load(target);
    setExpanded(previous => { const next = new Set(previous); if (opening) next.add(key); else next.delete(key); return next; });
  }, [keyOf, load, expanded]);

  const chooseView = useCallback((view: BrowserView) => { setExplicitView(view); persist({ view }); if (view === "tree" && current !== undefined) revealInTree(current); }, [persist, current, revealInTree]);
  const changeSort = useCallback((key: SortState["key"]) => setSort(previous => { const next: SortState = previous.key === key ? { key, dir: previous.dir === 1 ? -1 : 1 } : { key, dir: key === "modified" || key === "size" ? -1 : 1 }; persist({ sort: next }); return next; }), [persist]);
  const toggleHidden = useCallback(() => setShowHidden(value => { persist({ hidden: !value }); return !value; }), [persist]);
  const resizePlaces = useCallback((width: number) => { const next = Math.round(Math.min(280, Math.max(160, width))); setPlacesWidth(next); persist({ places: next }); }, [persist]);

  const togglePin = useCallback((target: string) => setPins(previous => {
    const next = previous.some(item => samePath(item, target, sep)) ? previous.filter(item => !samePath(item, target, sep)) : [...previous, target];
    writeStore(PINS_KEY, pinScope, next);
    return next;
  }), [pinScope, sep]);

  const currentState = current === undefined ? undefined : dirState(current);
  const entries = useMemo(() => sortEntries(visibleEntries(currentState?.dir?.entries ?? [], showHidden, filter), sort), [currentState, showHidden, filter, sort]);
  const childrenOf = useCallback((target: string) => sortEntries(visibleEntries(dirState(target)?.dir?.entries ?? [], showHidden, ""), sort), [dirState, showHidden, sort]);

  /* ---------- 写操作（新建 / 重命名 / 回收站） ---------- */
  const reloadAround = useCallback((target: string) => { requested.current.delete(keyOf(target)); load(target, true); }, [keyOf, load]);
  const submitEdit = useCallback(async (problem?: string) => {
    if (!edit || !source || edit.busy) return;
    if (problem) { setEdit({ ...edit, error: problem }); return; }
    const name = edit.draft.trim();
    setEdit({ ...edit, busy: true });
    try {
      if (edit.kind === "new") {
        const created = await source.createFolder(edit.parent, name);
        reloadAround(edit.parent); setSelection([created]); notify("ok", `已新建文件夹「${name}」`);
      } else {
        const parent = parentPath(edit.path, sep);
        const renamed = await source.rename(edit.path, name);
        reloadAround(parent); setSelection([renamed]);
        setPins(previous => { const next = previous.map(item => within(item, edit.path, sep) ? renamed + item.slice(edit.path.length) : item); writeStore(PINS_KEY, pinScope, next); return next; });
        if (current !== undefined && within(current, edit.path, sep)) setPathState(renamed + current.slice(edit.path.length));
        notify("ok", `已重命名为「${name}」`);
      }
      setEdit(undefined);
    } catch (error) {
      setEdit({ ...edit, busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }, [edit, source, sep, current, pinScope, reloadAround, notify]);
  const runTrash = useCallback(async () => {
    if (!confirmTrash || !source) return;
    const items = confirmTrash;
    setConfirmTrash(undefined);
    try {
      await source.trashItems(items.map(item => item.path));
      for (const parent of new Set(items.map(item => parentPath(item.path, sep)))) reloadAround(parent);
      setSelection([]);
      if (current !== undefined && items.some(item => within(current, item.path, sep))) go(parentPath(items[0]!.path, sep), { record: false });
      notify("ok", items.length === 1 ? `已将「${items[0]!.name}」移到回收站` : `已将 ${items.length} 项移到回收站`);
    } catch (error) { notify("error", error instanceof Error ? error.message : String(error)); }
  }, [confirmTrash, source, sep, current, reloadAround, go, notify]);

  return {
    places, placesError, current, currentState, entries, dirState, childrenOf, load,
    back, forward, go, goBack, goForward, goUp, refresh,
    selection, setSelection, sort, changeSort, showHidden, toggleHidden, filter, setFilter,
    explicitView, chooseView, placesWidth, resizePlaces,
    expanded, toggleExpanded, isExpanded: (target: string) => expanded.has(keyOf(target)),
    pins, togglePin, isPinned: (target: string) => pins.some(item => samePath(item, target, sep)),
    edit, setEdit, submitEdit, confirmTrash, setConfirmTrash, runTrash, notice, notify,
  };
}
export type FileBrowserState = ReturnType<typeof useFileBrowser>;
