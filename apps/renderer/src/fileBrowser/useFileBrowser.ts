import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hostErrorMessage } from "../hostError";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { baseName, COMPUTER, driveDisplayName, nameProblem, parentPath, samePath, sortEntries, visibleEntries, within, type BrowserView, type FileBrowserSource, type FsDirectory, type FsEntry, type FsPlaces, type SortState } from "./model";

export interface DirState { readonly status: "loading" | "ready" | "error"; readonly dir?: FsDirectory; readonly error?: string }
export type EditState = { readonly kind: "rename"; readonly path: string; readonly draft: string; readonly error?: string; readonly busy?: boolean }
  | { readonly kind: "new"; readonly parent: string; readonly draft: string; readonly error?: string; readonly busy?: boolean };
export interface Notice { readonly tone: "ok" | "error"; readonly text: string; readonly key: number }

/** 每个面板实例自己的记忆：位置、显式视图、排序、隐藏文件、位置栏宽度。只是界面便利，读写失败就当没有。 */
interface Memory { path?: string; view?: BrowserView | null; sort?: SortState; hidden?: boolean; places?: number }
const MEMORY_KEY = "omp.fileBrowser.v1";
const PINS_KEY = "omp.fileBrowser.pins.v1";
const MAX_CACHED_DIRS = 128;

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

export function useFileBrowser(source: FileBrowserSource | null, memoryId: string, pinScope: string, workspaceId?: string) {
  const { resolvedLanguage } = useI18n();
  const { preview, marks } = usePreviewMode();
  const showWriteNotice = !preview || marks;
  const langRef = useRef(resolvedLanguage);
  langRef.current = resolvedLanguage;
  const copy = (zh: string, en: string) => langRef.current === "zh" ? zh : en;
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
  const [edit, setEditState] = useState<EditState>();
  const [confirmTrash, setConfirmTrash] = useState<readonly FsEntry[]>();
  const [notice, setNotice] = useState<Notice>();
  const [pins, setPins] = useState<readonly string[]>(() => readStore<string[]>(PINS_KEY)[pinScope] ?? []);
  const requested = useRef(new Map<string, symbol>());
  const submittingEdit = useRef(false);
  const trashing = useRef(false);
  const editRef = useRef<EditState | undefined>(undefined);
  editRef.current = edit;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const revealed = useRef(false);
  const [revision, setRevision] = useState(0);
  const [placesRevision, setPlacesRevision] = useState(0);
  const current = path ?? places?.home;
  const currentRef = useRef(current); currentRef.current = current;
  const sep = places?.separator ?? "\\";
  const keyOf = useCallback((value: string) => sep === "\\" ? value.toLowerCase() : value, [sep]);

  const setEdit = useCallback((next: EditState | undefined) => {
    if (!next) submittingEdit.current = false;
    editRef.current = next;
    setEditState(next);
  }, []);

  const pruneDirs = useCallback((next: Map<string, DirState>): Map<string, DirState> => {
    if (next.size <= MAX_CACHED_DIRS) return next;
    const activeKey = currentRef.current !== undefined ? keyOf(currentRef.current) : undefined;
    const rootKey = keyOf(COMPUTER);
    const keep = expandedRef.current;
    for (const candidate of next.keys()) {
      if (next.size <= MAX_CACHED_DIRS) break;
      if (candidate === rootKey || candidate === activeKey) continue;
      if (keep.has(candidate) && next.size <= MAX_CACHED_DIRS * 2) continue;
      next.delete(candidate);
      requested.current.delete(candidate);
    }
    return next;
  }, [keyOf]);

  useEffect(() => { setPins(readStore<string[]>(PINS_KEY)[pinScope] ?? []); }, [pinScope]);
  useEffect(() => {
    setPlaces(undefined); setPlacesError(undefined); setDirs(new Map()); requested.current.clear();
    if (!source) return;
    let live = true;
    source.places().then(value => { if (live) setPlaces(value); }, error => { if (live) setPlacesError(hostErrorMessage(error, copy("操作失败", "Operation failed"))); });
    return () => { live = false; };
  }, [source, placesRevision]);

  const metaSnapshot = useRef({ language: resolvedLanguage, workspaceId });
  useEffect(() => {
    const previous = metaSnapshot.current;
    metaSnapshot.current = { language: resolvedLanguage, workspaceId };
    if (previous.language === resolvedLanguage && previous.workspaceId === workspaceId) return;
    if (!source || !places) return;
    let live = true;
    void source.places().then(value => {
      if (!live) return;
      setPlaces(value);
      const rootKey = keyOf(COMPUTER);
      if (dirsRef.current.has(rootKey)) {
        setDirs(prior => {
          if (!prior.has(rootKey)) return prior;
          const next = new Map(prior);
          next.set(rootKey, {
            status: "ready",
            dir: { path: COMPUTER, entries: value.drives.map(drive => ({ name: driveDisplayName(drive, value.separator), path: drive.path, type: "dir" as const, denied: !drive.ready })) },
          });
          return next;
        });
      }
    }, () => { /* Keep existing places on transient background refresh error. */ });
    return () => { live = false; };
  }, [resolvedLanguage, workspaceId, source, !!places, keyOf]);

  useEffect(() => { requested.current.clear(); setDirs(new Map()); }, [showHidden]);

  const load = useCallback((target: string, force = false) => {
    if (!source) return;
    const key = keyOf(target);
    if (!force && requested.current.has(key)) return;
    const ticket = Symbol();
    requested.current.set(key, ticket);
    setDirs(previous => {
      const existing = previous.get(key);
      const next = new Map(previous);
      next.delete(key);
      next.set(key, { status: "loading", ...(existing?.dir ? { dir: existing.dir } : {}) });
      return pruneDirs(next);
    });
    source.list(target, showHidden).then(
      dir => {
        if (requested.current.get(key) !== ticket) return;
        const canonical = keyOf(dir.path);
        requested.current.set(canonical, ticket);
        if (canonical !== key) setExpanded(previous => { const next = new Set(previous); next.delete(key); return next; });
        setDirs(previous => {
          const next = new Map(previous);
          next.delete(key);
          next.set(key, { status: "ready", dir });
          if (canonical !== key) next.delete(canonical);
          next.set(canonical, { status: "ready", dir });
          return pruneDirs(next);
        });
        if (currentRef.current === target && dir.path !== target) { revealed.current = false; setPathState(dir.path); writeStore<Memory>(MEMORY_KEY, memoryId, { ...readStore<Memory>(MEMORY_KEY)[memoryId], path: dir.path }); }
      },
      error => {
        if (requested.current.get(key) === ticket) {
          setDirs(previous => {
            const next = new Map(previous);
            next.delete(key);
            next.set(key, { status: "error", error: hostErrorMessage(error, copy("操作失败", "Operation failed")) });
            return pruneDirs(next);
          });
        }
      },
    );
  }, [source, keyOf, showHidden, memoryId, pruneDirs]);
  const dirState = useCallback((target: string): DirState | undefined => dirs.get(keyOf(target)), [dirs, keyOf]);

  // 第一次拿到位置时落到记忆的位置，没有就去主目录。
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

  // 打开面板时落在记忆的位置：树要把它的祖先展开，分栏也要有它们的列表。
  useEffect(() => { revealed.current = false; }, [source, showHidden]);
  useEffect(() => { if (places && current !== undefined && !revealed.current) { revealed.current = true; revealInTree(current); } }, [places, current, revealInTree]);

  /** `reveal: false` 用于树里点选：只让面包屑跟上，不再替用户展开。 */
  const go = useCallback((requestedTarget: string, options: { select?: string | undefined; record?: boolean; reveal?: boolean } = {}) => {
    const target = dirs.get(keyOf(requestedTarget))?.dir?.path ?? requestedTarget;
    const moved = current === undefined || !samePath(current, target, sep);
    if (current !== undefined && options.record !== false && moved) { setBack(stack => [...stack.slice(-63), current]); setForward([]); }
    setPathState(target); setEdit(undefined);
    if (moved) setFilter("");
    setSelection(options.select ? [options.select] : []);
    persist({ path: target });
    load(target);
    if (options.reveal !== false) revealInTree(target);
  }, [current, sep, persist, load, revealInTree, dirs, keyOf, setEdit]);
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
    setRevision(value => value + 1);
    if (!places) { setPlacesRevision(value => value + 1); return; }
    if (current === undefined) return;
    void source?.places().then(value => { setPlaces(value); setPlacesError(undefined); }, error => setPlacesError(hostErrorMessage(error, copy("无法读取位置", "Couldn't read places"))));
    requested.current.clear();
    load(current, true);
    for (const key of expanded) { const dir = dirs.get(key)?.dir; if (dir) load(dir.path, true); }
  }, [current, expanded, dirs, load, places, source]);

  const toggleExpanded = useCallback((target: string) => {
    const key = keyOf(target), opening = !expanded.has(key);
    const canonical = dirs.get(key)?.dir?.path;
    if (opening && canonical && !samePath(canonical, target, sep)) { go(canonical); return; }
    if (opening) load(target);
    setExpanded(previous => { const next = new Set(previous); if (opening) next.add(key); else next.delete(key); return next; });
  }, [keyOf, load, expanded, dirs, sep, go]);

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
  const childrenOf = useCallback((target: string) => sortEntries(visibleEntries(dirState(target)?.dir?.entries ?? [], showHidden, current !== undefined && samePath(target, current, sep) ? filter : ""), sort), [dirState, showHidden, sort, current, sep, filter]);

  /* ---------- 写操作（新建 / 重命名 / 回收站） ---------- */
  const reloadAround = useCallback((target: string) => { requested.current.delete(keyOf(target)); load(target, true); }, [keyOf, load]);
  const submitEdit = useCallback(async () => {
    const activeEdit = editRef.current;
    if (!activeEdit || !source || activeEdit.busy || submittingEdit.current) return;
    const name = activeEdit.draft.trim();
    const language: "zh" | "en" = resolvedLanguage === "zh" ? "zh" : "en";
    if (activeEdit.kind === "rename" && name === baseName(activeEdit.path, sep)) {
      setEdit(undefined);
      return;
    }
    const problem = nameProblem(name, places?.platform ?? "win32", language);
    if (problem) {
      setEdit({ ...activeEdit, error: problem });
      return;
    }
    submittingEdit.current = true;
    const { error: _clearedError, ...cleanEdit } = activeEdit;
    setEdit({ ...cleanEdit, draft: name, busy: true });
    try {
      if (activeEdit.kind === "new") {
        const targetParent = activeEdit.parent;
        const created = await source.createFolder(targetParent, name);
        reloadAround(targetParent);
        if (currentRef.current !== undefined && samePath(currentRef.current, targetParent, sep)) {
          setSelection([created]);
        }
        if (showWriteNotice) notify("ok", copy(`已新建文件夹「${name}」`, `Created folder "${name}"`));
      } else {
        const oldPath = activeEdit.path;
        const oldKey = keyOf(oldPath);
        const parent = parentPath(oldPath, sep);
        const renamed = await source.rename(oldPath, name);
        const newKey = keyOf(renamed);
        const expandedToReload: string[] = [];
        for (const expKey of expandedRef.current) {
          if (within(expKey, oldKey, sep)) {
            const cachedDirPath = dirsRef.current.get(expKey)?.dir?.path;
            const suffix = cachedDirPath ? cachedDirPath.slice(oldPath.length) : expKey.slice(oldKey.length);
            expandedToReload.push(renamed + suffix);
          }
        }
        for (const reqKey of [...requested.current.keys()]) {
          if (within(reqKey, oldKey, sep)) requested.current.delete(reqKey);
        }
        setDirs(previous => {
          let changed = false;
          const next = new Map<string, DirState>();
          for (const [k, state] of previous) {
            if (within(k, oldKey, sep)) {
              changed = true;
              if (state.dir) {
                const remappedPath = renamed + state.dir.path.slice(oldPath.length);
                next.set(keyOf(remappedPath), {
                  ...state,
                  dir: {
                    ...state.dir,
                    path: remappedPath,
                    entries: state.dir.entries.map(entry => within(entry.path, oldPath, sep) ? { ...entry, path: renamed + entry.path.slice(oldPath.length) } : entry),
                  },
                });
              }
            } else {
              next.set(k, state);
            }
          }
          return changed ? pruneDirs(next) : previous;
        });
        reloadAround(parent);
        const latestCurrent = currentRef.current;
        if (latestCurrent !== undefined && (samePath(latestCurrent, parent, sep) || within(latestCurrent, oldPath, sep))) {
          setSelection([renamed]);
        }
        setPins(previous => { const next = previous.map(item => within(item, oldPath, sep) ? renamed + item.slice(oldPath.length) : item); writeStore(PINS_KEY, pinScope, next); return next; });
        if (latestCurrent !== undefined && within(latestCurrent, oldPath, sep)) {
          const nextPath = renamed + latestCurrent.slice(oldPath.length);
          setPathState(nextPath);
          persist({ path: nextPath });
        }
        setExpanded(previous => new Set([...previous].map(item => within(item, oldKey, sep) ? newKey + item.slice(oldKey.length) : item)));
        for (const targetToReload of expandedToReload) reloadAround(targetToReload);
        if (showWriteNotice) notify("ok", copy(`已重命名为「${name}」`, `Renamed to "${name}"`));
      }
      const currentEdit = editRef.current;
      const stillSameEdit = activeEdit.kind === "new"
        ? currentEdit?.kind === "new" && currentEdit.parent === activeEdit.parent
        : currentEdit?.kind === "rename" && currentEdit.path === activeEdit.path;
      if (stillSameEdit) {
        setEdit(undefined);
      }
    } catch (error) {
      const currentEdit = editRef.current;
      const stillSameEdit = activeEdit.kind === "new"
        ? currentEdit?.kind === "new" && currentEdit.parent === activeEdit.parent
        : currentEdit?.kind === "rename" && currentEdit.path === activeEdit.path;
      if (stillSameEdit) {
        setEdit({ ...activeEdit, draft: name, busy: false, error: hostErrorMessage(error, copy("操作失败", "Operation failed")) });
      }
    } finally {
      submittingEdit.current = false;
    }
  }, [source, sep, places?.platform, pinScope, reloadAround, notify, persist, keyOf, resolvedLanguage, showWriteNotice, pruneDirs, setEdit]);
  const runTrash = useCallback(async () => {
    if (!confirmTrash || !source || trashing.current) return;
    trashing.current = true;
    const items = confirmTrash;
    setConfirmTrash(undefined);
    try {
      await source.trashItems(items.map(item => item.path));
      const deletedKeys = items.map(item => keyOf(item.path));
      for (const reqKey of [...requested.current.keys()]) {
        if (deletedKeys.some(delKey => within(reqKey, delKey, sep))) requested.current.delete(reqKey);
      }
      setDirs(previous => {
        let changed = false;
        const next = new Map<string, DirState>();
        for (const [k, state] of previous) {
          if (deletedKeys.some(delKey => within(k, delKey, sep))) changed = true;
          else next.set(k, state);
        }
        return changed ? next : previous;
      });
      setExpanded(previous => {
        const next = new Set([...previous].filter(expKey => !deletedKeys.some(delKey => within(expKey, delKey, sep))));
        return next.size === previous.size ? previous : next;
      });
      setSelection([]);
      const latestCurrent = currentRef.current;
      if (latestCurrent !== undefined) {
        const deletedAncestors = items.filter(item => within(latestCurrent, item.path, sep)).sort((a, b) => a.path.length - b.path.length);
        if (deletedAncestors.length > 0) go(parentPath(deletedAncestors[0]!.path, sep), { record: false });
      }
      if (showWriteNotice) notify("ok", copy(items.length === 1 ? `已将「${items[0]!.name}」移到回收站` : `已将 ${items.length} 项移到回收站`, `Moved ${items.length} item(s) to the trash`));
    } catch (error) { notify("error", hostErrorMessage(error, copy("操作失败", "Operation failed"))); }
    finally {
      trashing.current = false;
      for (const parent of new Set(items.map(item => parentPath(item.path, sep)))) reloadAround(parent);
    }
  }, [confirmTrash, source, sep, reloadAround, go, notify, resolvedLanguage, showWriteNotice, keyOf]);

  const findEntry = useCallback((target: string): FsEntry | undefined => {
    const inCurrent = currentState?.dir?.entries.find(entry => samePath(entry.path, target, sep));
    if (inCurrent) return inCurrent;
    const parentEntries = dirs.get(keyOf(parentPath(target, sep)))?.dir?.entries;
    const inParent = parentEntries?.find(entry => samePath(entry.path, target, sep));
    if (inParent) return inParent;
    for (const value of dirs.values()) {
      const hit = value.dir?.entries.find(entry => samePath(entry.path, target, sep));
      if (hit) return hit;
    }
    return undefined;
  }, [currentState, dirs, keyOf, sep]);

  return {
    revision, findEntry, places, placesError, current, currentState, entries, dirState, childrenOf, load,
    back, forward, go, goBack, goForward, goUp, refresh,
    selection, setSelection, sort, changeSort, showHidden, toggleHidden, filter, setFilter,
    explicitView, chooseView, placesWidth, resizePlaces,
    expanded, toggleExpanded, isExpanded: (target: string) => expanded.has(keyOf(target)),
    pins, togglePin, isPinned: (target: string) => pins.some(item => samePath(item, target, sep)),
    edit, setEdit, submitEdit, confirmTrash, setConfirmTrash, runTrash, notice, notify,
  };
}
export type FileBrowserState = ReturnType<typeof useFileBrowser>;
