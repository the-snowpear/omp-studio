import { flattenTree, treeNavigationIndex, treeTypeahead } from "../sidebar/treeKeyboard";
import { VirtualFileRows } from "./VirtualFileRows";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { fileTypeOf, iconNameFor, isNoiseDir, isSensitive } from "../explorer-types";
import { fileBadge, fileKind } from "../files/fileTypes";
import { baseName, columnRoot, COMPUTER, driveDisplayName, within, formatModified, formatSize, nameProblem, parentPath, pathSegments, samePath, type FsEntry, type FsPeek, type FsPlaces, type SortKey } from "./model";
import type { FileBrowserState } from "./useFileBrowser";

export type Copy = (zh: string, en: string) => string;
export interface RowActions {
  /** 单击：选中（Ctrl / Cmd 多选、Shift 连选）。 */
  select(entry: FsEntry, event: { ctrl: boolean; shift: boolean }, list: readonly FsEntry[]): void;
  /** 双击 / Enter：目录进入，文件打开。 */
  activate(entry: FsEntry): void;
  /** 右键；`entry` 为 null 是空白处。 */
  context(entry: FsEntry | null, point: { x: number; y: number }): void;
  /** 行尾悬停按钮「@」；没有关联对话时不显示。 */
  addContext?: ((entry: FsEntry) => void) | undefined;
}

/** 列表行尾的悬停操作：@ 加入对话、⋯ 更多（菜单贴按钮下沿）。 */
function RowTools({ entry, list, actions, copy }: { entry: FsEntry; list: readonly FsEntry[]; actions: RowActions; copy: Copy }) {
  return <span className="fb-row-tools" onDoubleClick={event => event.stopPropagation()}>
    {actions.addContext ? <button type="button" className="icon-btn" aria-label={copy(`把 ${entry.name} 加入对话`, `Add ${entry.name} to chat`)} data-tip={copy("加入对话", "Add to chat")}
      onClick={event => { event.stopPropagation(); actions.addContext!(entry); }}><Icon name="at" extra="sm" /></button> : null}
    <button type="button" className="icon-btn" aria-label={copy(`${entry.name} 的更多操作`, `More actions for ${entry.name}`)} data-tip={copy("更多", "More")} aria-haspopup="menu"
      onClick={event => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); actions.select(entry, { ctrl: false, shift: false }, list); actions.context(entry, { x: rect.right - 220, y: rect.bottom + 4 }); }}><Icon name="more" extra="sm" /></button>
  </span>;
}
interface ViewProps { state: FileBrowserState; places: FsPlaces; actions: RowActions; copy: Copy; language: "zh" | "en" }

const isMod = (event: { ctrlKey: boolean; metaKey: boolean }) => event.ctrlKey || event.metaKey;

/* ---------- 共用：图标、名称、行内编辑 ---------- */

export function EntryIcon({ entry, open = false }: { entry: FsEntry; open?: boolean }) {
  if (entry.type === "dir") return <span className="fb-ico" data-kind="dir"><Icon name={entry.denied ? "lock" : open ? "folder-open" : "folder"} /></span>;
  const ftype = fileTypeOf(entry.name);
  return <span className="fb-ico" data-ftype={ftype ?? undefined} data-secret={isSensitive(entry.name) || undefined}><Icon name={iconNameFor(ftype, entry.name)} /></span>;
}

export function typeLabel(entry: FsEntry, copy: Copy): string {
  if (entry.type === "dir") return copy("文件夹", "Folder");
  if (!entry.name.includes(".") || entry.name.startsWith(".") && entry.name.indexOf(".", 1) < 0) return copy("文件", "File");
  return fileBadge(entry.name).label;
}

function NameCell({ entry, copy }: { entry: FsEntry; copy: Copy }) {
  return <span className="fb-name">
    <span className="ellipsis">{entry.name}</span>
    {entry.link ? <span className="fb-badge" data-tip={copy("快捷方式 / 链接", "Link")} aria-label={copy("链接", "link")}>↪</span> : null}
    {entry.denied ? <span className="fb-badge" data-tip={copy("没有访问权限", "Access denied")}><Icon name="lock" extra="sm" /></span> : null}
  </span>;
}

export function EditInput({ state, places, copy, language }: { state: FileBrowserState; places: FsPlaces; copy: Copy; language: "zh" | "en" }) {
  const edit = state.edit, input = useRef<HTMLInputElement>(null), handledRef = useRef(false);
  const editTarget = edit?.kind === "rename" ? edit.path : edit?.parent;
  useLayoutEffect(() => {
    handledRef.current = false;
    const element = input.current;
    if (!element) return;
    element.focus();
    // 重命名时只选中主名，不选扩展名（与系统文件管理器一致）。
    const dot = edit?.kind === "rename" ? element.value.lastIndexOf(".") : -1;
    element.setSelectionRange(0, dot > 0 ? dot : element.value.length);
  }, [edit?.kind, editTarget]);
  if (!edit) return null;
  return <span className="fb-edit" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <input ref={input} className="input" value={edit.draft} disabled={edit.busy} spellCheck={false}
      aria-label={edit.kind === "new" ? copy("新文件夹名称", "New folder name") : copy("新名称", "New name")}
      aria-invalid={Boolean(edit.error) || undefined}
      onChange={event => { handledRef.current = false; const { error: _cleared, ...rest } = edit; state.setEdit({ ...rest, draft: event.target.value }); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Enter") { event.preventDefault(); handledRef.current = true; void state.submitEdit(); }
        if (event.key === "Escape") { event.preventDefault(); handledRef.current = true; state.setEdit(undefined); }
      }}
      onBlur={() => {
        if (handledRef.current || edit.busy) return;
        const trimmed = edit.draft.trim();
        // 点走即确认；名称没变、为空或已经报错时点走等于取消。
        const unchanged = edit.kind === "rename" && trimmed === baseName(edit.path, places.separator);
        if (edit.error || unchanged || !trimmed) { handledRef.current = true; state.setEdit(undefined); return; }
        const problem = nameProblem(trimmed, places.platform, language);
        if (problem) { state.setEdit({ ...edit, error: problem }); return; }
        handledRef.current = true;
        void state.submitEdit();
      }} />
    {edit.busy ? <span className="spinner" aria-hidden="true" /> : null}
    {edit.error ? <span className="fb-edit-error" role="alert">{edit.error}</span> : null}
  </span>;
}

/** 视图之间共用的空态 / 错误态。 */
export function FolderStatus({ state, path, copy, onUp }: { state: FileBrowserState; path: string; copy: Copy; onUp?: (() => void) | undefined }) {
  const dir = state.dirState(path);
  if (!dir || dir.status === "loading" && !dir.dir) return <div className="fb-skeleton" aria-busy="true" aria-label={copy("正在读取", "Loading")}>{Array.from({ length: 7 }, (_, index) => <span key={index} style={{ ["--w" as string]: `${42 + (index * 37) % 46}%` } as CSSProperties} />)}</div>;
  if (dir.status === "error") return <div className="fb-state" role="status">
    <Icon name={/权限|denied|EACCES|EPERM/i.test(dir.error ?? "") ? "lock" : /未就绪|not ready/i.test(dir.error ?? "") ? "drive" : "alert-c"} />
    <strong>{dir.error}</strong>
    <span className="fb-state-actions">
      {onUp ? <button type="button" className="btn outline small" onClick={onUp}>{copy("返回上一级", "Go up")}</button> : null}
      <button type="button" className="btn outline small" onClick={() => state.load(path, true)}>{copy("重试", "Retry")}</button>
    </span>
  </div>;
  return null;
}

function emptyHint(state: FileBrowserState, copy: Copy): ReactNode {
  const all = state.currentState?.dir?.entries ?? [];
  if (state.filter.trim()) return <div className="fb-state"><Icon name="search" /><strong>{copy(`没有匹配「${state.filter.trim()}」的项目`, `Nothing matches "${state.filter.trim()}"`)}</strong></div>;
  if (all.length && !state.showHidden) return <div className="fb-state"><Icon name="eye-off" /><strong>{copy(`这里只有 ${all.length} 个隐藏项目`, `${all.length} hidden items only`)}</strong><span className="fb-state-actions"><button type="button" className="btn outline small" onClick={state.toggleHidden}>{copy("显示隐藏文件", "Show hidden files")}</button></span></div>;
  return <div className="fb-state"><Icon name="folder-open" /><strong>{copy("此文件夹为空", "This folder is empty")}</strong></div>;
}

/** 列表与分栏共用的键盘：↑↓ Home End 选择，Enter 打开，Backspace 上一级，F2 重命名，Delete 回收站，首字母跳转。 */
function useListKeys(entries: readonly FsEntry[], state: FileBrowserState, actions: RowActions, extra?: (event: KeyboardEvent<HTMLElement>, focused: FsEntry | undefined) => boolean) {
  const typed = useRef({ text: "", at: 0 });
  return (event: KeyboardEvent<HTMLElement>) => {
    if (state.edit || event.altKey || isMod(event)) return;
    const selected = state.selection[state.selection.length - 1];
    const index = entries.findIndex(entry => selected !== undefined && entry.path === selected);
    const focused = entries[index];
    if (extra?.(event, focused)) { event.preventDefault(); return; }
    const pick = (next: number) => { const entry = entries[Math.max(0, Math.min(entries.length - 1, next))]; if (entry) actions.select(entry, { ctrl: false, shift: event.shiftKey }, entries); };
    const destination = treeNavigationIndex(event.key, index, entries.length);
    if (destination !== undefined) { pick(destination); event.preventDefault(); return; }
    switch (event.key) {
      case "Enter": if (focused) actions.activate(focused); break;
      case "Backspace": state.goUp(); break;
      default:
        if (event.key.length === 1 && !isMod(event) && !event.altKey && /\S/.test(event.key)) {
          const now = Date.now();
          typed.current = { text: now - typed.current.at > 700 ? event.key.toLowerCase() : typed.current.text + event.key.toLowerCase(), at: now };
          const hit = treeTypeahead(entries, index, typed.current.text, entry => entry.name) ?? treeTypeahead(entries, index, event.key, entry => entry.name);
          if (hit) actions.select(hit, { ctrl: false, shift: false }, entries);
          break;
        }
        return;
    }
    event.preventDefault();
  };
}

function useScrollSelected(container: HTMLElement | null, selected: string | undefined) {
  useEffect(() => {
    if (!container || !selected) return;
    const row = [...container.querySelectorAll<HTMLElement>("[data-path]")].find(element => element.dataset.path === selected);
    row?.scrollIntoView?.({ block: "nearest" });
    if (row && container.contains(container.ownerDocument.activeElement)) row.focus({ preventScroll: true });
  }, [container, selected]);
}

/* ---------- 详细列表 ---------- */

const COLUMNS: readonly { key: SortKey; zh: string; en: string }[] = [
  { key: "name", zh: "名称", en: "Name" }, { key: "modified", zh: "修改时间", en: "Modified" }, { key: "type", zh: "类型", en: "Type" }, { key: "size", zh: "大小", en: "Size" },
];

export function ListView({ state, places, actions, copy, language }: ViewProps) {
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const entries = state.entries, current = state.current ?? COMPUTER;
  const selected = new Set(state.selection);
  const onKeyDown = useListKeys(entries, state, actions);
  useScrollSelected(body, state.selection[state.selection.length - 1]);
  const status = <FolderStatus state={state} path={current} copy={copy} onUp={current === COMPUTER ? undefined : state.goUp} />;
  const loaded = state.currentState?.dir !== undefined;
  const newRow = state.edit?.kind === "new" && samePath(state.edit.parent, current, places.separator);
  return <div className="fb-list" role="grid" aria-label={copy("文件列表", "File list")} aria-multiselectable="true">
    <div className="fb-list-head" role="row">
      {COLUMNS.map(column => <button type="button" role="columnheader" key={column.key} className={`fb-col fb-col-${column.key}`}
        aria-sort={state.sort.key === column.key ? state.sort.dir === 1 ? "ascending" : "descending" : "none"}
        onClick={() => state.changeSort(column.key)}>
        <span>{copy(column.zh, column.en)}</span>
        {state.sort.key === column.key ? <Icon name={state.sort.dir === 1 ? "chevron-u" : "chevron-d"} extra="sm" /> : null}
      </button>)}
    </div>
    <div ref={setBody} className="fb-list-body" tabIndex={entries.length ? -1 : 0} onKeyDown={onKeyDown}
      onContextMenu={event => { if (event.target === event.currentTarget) { event.preventDefault(); actions.context(null, { x: event.clientX, y: event.clientY }); } }}
      onMouseDown={event => { if (event.target === event.currentTarget) state.setSelection([]); }}>
      {!loaded ? status : <>
        {newRow ? <div className="fb-row is-editing" role="row"><span className="fb-cell fb-col-name"><span className="fb-ico" data-kind="dir"><Icon name="folder" /></span><EditInput state={state} places={places} copy={copy} language={language} /></span></div> : null}
        {state.currentState?.status === "error" ? status : entries.length === 0 && !newRow ? emptyHint(state, copy) : <VirtualFileRows entries={entries} selected={state.selection.at(-1)}>{entry => {
          const renaming = state.edit?.kind === "rename" && state.edit.path === entry.path;
          return <div key={entry.path} role="row" tabIndex={selected.has(entry.path) ? 0 : -1} data-path={entry.path}
            className={`fb-row${selected.has(entry.path) ? " is-selected" : ""}${renaming ? " is-editing" : ""}`}
            aria-selected={selected.has(entry.path)} data-hidden={entry.hidden || undefined} data-denied={entry.denied || undefined}
            data-noise={entry.type === "dir" && isNoiseDir(entry.name) || undefined}
            onClick={event => actions.select(entry, { ctrl: isMod(event), shift: event.shiftKey }, entries)}
            onDoubleClick={() => actions.activate(entry)}
            onContextMenu={(event: MouseEvent) => { event.preventDefault(); if (!selected.has(entry.path)) actions.select(entry, { ctrl: false, shift: false }, entries); actions.context(entry, { x: event.clientX, y: event.clientY }); }}>
            <span className="fb-cell fb-col-name" role="gridcell"><EntryIcon entry={entry} />{renaming ? <EditInput state={state} places={places} copy={copy} language={language} /> : <><NameCell entry={entry} copy={copy} />{current === COMPUTER ? null : <RowTools entry={entry} list={entries} actions={actions} copy={copy} />}</>}</span>
            <span className="fb-cell fb-col-modified" role="gridcell">{formatModified(entry.modified, Date.now(), language)}</span>
            <span className="fb-cell fb-col-type" role="gridcell">{current === COMPUTER ? copy("磁盘", "Drive") : typeLabel(entry, copy)}</span>
            <span className="fb-cell fb-col-size" role="gridcell">{entry.type === "file" ? formatSize(entry.size) : ""}</span>
          </div>;
        }}</VirtualFileRows>}
      </>}
    </div>
  </div>;
}

/* ---------- 单树 ---------- */

export function TreeView({ state, places, actions, copy, language }: ViewProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => { state.load(COMPUTER); }, [state.load]);
  const selected = new Set(state.selection);
  // 扁平化当前可见的树行，给键盘导航用。
  const flat = flattenTree(state.childrenOf(COMPUTER), entry => state.childrenOf(entry.path), state.isExpanded)
    .map(item => ({ entry: item.node, depth: item.depth, parent: item.parentPath ?? COMPUTER }));
  const list = flat.map(item => item.entry);
  const onKeyDown = useListKeys(list, state, actions, (event, focused) => {
    if (!focused) return false;
    const item = flat.find(value => value.entry === focused);
    if (event.key === "ArrowRight" && focused.type === "dir") { if (!state.isExpanded(focused.path)) state.toggleExpanded(focused.path); else { const child = flat[flat.indexOf(item!) + 1]; if (child && child.depth > item!.depth) actions.select(child.entry, { ctrl: false, shift: false }, list); } return true; }
    if (event.key === "ArrowLeft") { if (focused.type === "dir" && state.isExpanded(focused.path)) state.toggleExpanded(focused.path); else { const parent = flat.find(value => value.entry.path === item?.parent); if (parent) actions.select(parent.entry, { ctrl: false, shift: false }, list); } return true; }
    return false;
  });
  useScrollSelected(root, state.selection[state.selection.length - 1]);
  const rows: ReactNode[] = [];
  const render = (path: string, depth: number) => {
    const dir = state.dirState(path);
    if (path !== COMPUTER && (!dir || dir.status === "loading" && !dir.dir)) { rows.push(<div key={`${path}:loading`} className="tree-row muted" role="status" style={{ ["--depth-pad" as string]: `${depth * 14 + 6}px` } as CSSProperties}><span className="tw" /><span className="fi"><span className="spinner" aria-hidden="true" /></span><span className="fname">{copy("正在读取…", "Loading…")}</span></div>); return; }
    if (dir?.status === "error") { rows.push(<div key={`${path}:error`} className="tree-row muted fb-tree-error" role="status" style={{ ["--depth-pad" as string]: `${depth * 14 + 6}px` } as CSSProperties}><span className="tw" /><span className="fi"><Icon name="alert-c" /></span><span className="fname ellipsis">{dir.error}</span></div>); return; }
    const children = state.childrenOf(path);
    if (path !== COMPUTER && children.length === 0 && !(state.edit?.kind === "new" && samePath(state.edit.parent, path, places.separator))) rows.push(<div key={`${path}:empty`} className="tree-row muted" style={{ ["--depth-pad" as string]: `${depth * 14 + 6}px` } as CSSProperties}><span className="tw" /><span className="fname">{copy("（空）", "(empty)")}</span></div>);
    if (state.edit?.kind === "new" && samePath(state.edit.parent, path, places.separator)) rows.push(<div key={`${path}:new`} className="tree-row is-editing" style={{ ["--depth-pad" as string]: `${depth * 14 + 6}px` } as CSSProperties}><span className="tw" /><span className="fi"><Icon name="folder" /></span><EditInput state={state} places={places} copy={copy} language={language} /></div>);
    for (const entry of children) {
      const open = entry.type === "dir" && state.isExpanded(entry.path);
      const ftype = entry.type === "file" ? fileTypeOf(entry.name) : null;
      const renaming = state.edit?.kind === "rename" && state.edit.path === entry.path;
      const drive = path === COMPUTER ? places.drives.find(value => samePath(value.path, entry.path, places.separator)) : undefined;
      rows.push(<div key={entry.path} data-path={entry.path} className={`tree-row fb-tree-row${open ? " open" : ""}`}
        {...(entry.type === "dir" ? { "data-dir": entry.path } : { "data-file": entry.path })} data-ftype={ftype ?? undefined}
        data-noise={entry.hidden || entry.type === "dir" && isNoiseDir(entry.name) || undefined} data-denied={entry.denied || undefined}
        role="treeitem" aria-level={depth + 1} aria-expanded={entry.type === "dir" ? open : undefined} aria-selected={selected.has(entry.path)}
        tabIndex={selected.has(entry.path) ? 0 : -1} style={{ ["--depth-pad" as string]: `${depth * 14 + 6}px` } as CSSProperties}
        onClick={event => { actions.select(entry, { ctrl: isMod(event), shift: event.shiftKey }, list); if (entry.type === "dir" && !entry.denied && !isMod(event)) state.toggleExpanded(entry.path); }}
        onDoubleClick={() => { if (entry.type === "file") actions.activate(entry); }}
        onContextMenu={event => { event.preventDefault(); actions.select(entry, { ctrl: false, shift: false }, list); actions.context(entry, { x: event.clientX, y: event.clientY }); }}>
        <span className="tw">{entry.type === "dir" ? <Icon name="chevron-r" extra="sm" /> : null}</span>
        <span className="fi"><Icon name={drive ? "drive" : entry.type === "dir" ? entry.denied ? "lock" : open ? "folder-open" : "folder" : iconNameFor(ftype, entry.name)} /></span>
        {renaming ? <EditInput state={state} places={places} copy={copy} language={language} /> : <span className="fname ellipsis">{drive ? driveDisplayName(drive, places.separator) : entry.name}</span>}
        {entry.link ? <span className="fb-badge">↪</span> : null}
        {drive && !drive.ready ? <span className="fb-badge fb-muted">{copy("未就绪", "Not ready")}</span> : null}
      </div>);
      if (open) render(entry.path, depth + 1);
    }
  };
  render(COMPUTER, 0);
  return <div ref={setRoot} className="tree fb-tree" role="tree" aria-label={copy("文件树", "File tree")} tabIndex={-1} onKeyDown={onKeyDown}
    onContextMenu={event => { if (event.target === event.currentTarget) { event.preventDefault(); actions.context(null, { x: event.clientX, y: event.clientY }); } }}>
    {state.dirState(COMPUTER)?.dir ? rows : <FolderStatus state={state} path={COMPUTER} copy={copy} />}
  </div>;
}

/* ---------- 分栏 ---------- */

export function ColumnsView({ state, places, actions, copy, language, preview }: ViewProps & { preview: PreviewSlot }) {
  const scroller = useRef<HTMLDivElement>(null);
  useScrollSelected(scroller.current, state.selection.at(-1));
  const current = state.current ?? COMPUTER;
  const selectedCurrent = state.selection.some(path => samePath(path, current, places.separator));
  const root = columnRoot(selectedCurrent ? parentPath(current, places.separator) : current, places, state.pins);
  const chain = pathSegments(current, places).map(segment => segment.path).filter(path => root === COMPUTER || within(path, root, places.separator));
  const selected = state.selection.length === 1 ? state.entries.find(entry => entry.path === state.selection[0]) : undefined;
  const file = selected?.type === "file" ? selected : undefined;
  const chainKey = chain.join("\u0000");
  useEffect(() => { for (const path of chain) state.load(path); }, [chainKey, state.load]);
  const loadedKey = chain.map(path => state.dirState(path)?.status ?? "").join();
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [chainKey, loadedKey, file?.path]);
  const entries = state.entries;
  const onKeyDown = useListKeys(entries, state, actions, (event, focused) => {
    if (event.key === "ArrowLeft") { state.goUp(); return true; }
    if (event.key === "ArrowRight" && focused?.type === "dir") { actions.activate(focused); return true; }
    return false;
  });
  return <div ref={scroller} className="fb-columns" role="group" aria-label={copy("分栏视图", "Column view")}>
    {chain.map((dirPath, column) => {
      const last = column === chain.length - 1;
      const nextPath = chain[column + 1];
      const list = last ? entries : dirPath === COMPUTER ? state.dirState(COMPUTER)?.dir?.entries ?? [] : state.childrenOf(dirPath);
      const loaded = state.dirState(dirPath)?.dir !== undefined;
      const newRow = last && state.edit?.kind === "new" && samePath(state.edit.parent, dirPath, places.separator);
      return <div key={dirPath || "computer"} className={`fb-column${last ? " is-current" : ""}`} role="listbox" aria-label={dirPath || places.computerLabel}
        tabIndex={last && !list.length ? 0 : -1} onKeyDown={onKeyDown}
        onContextMenu={event => { if (event.target === event.currentTarget) { event.preventDefault(); if (!last) state.go(dirPath, { select: nextPath }); actions.context(null, { x: event.clientX, y: event.clientY }); } }}
        onMouseDown={event => { if (event.target === event.currentTarget && last) state.setSelection([]); }}>
        {!loaded || state.dirState(dirPath)?.status === "error" ? <FolderStatus state={state} path={dirPath} copy={copy} onUp={last && dirPath !== COMPUTER ? state.goUp : undefined} /> : <>
          {newRow ? <div className="fb-crow is-editing"><span className="fb-ico" data-kind="dir"><Icon name="folder" /></span><EditInput state={state} places={places} copy={copy} language={language} /></div> : null}
          {list.length === 0 && !newRow ? last ? emptyHint(state, copy) : null : <VirtualFileRows entries={list} selected={state.selection.at(-1)}>{entry => {
            const onPath = nextPath !== undefined && samePath(entry.path, nextPath, places.separator);
            const picked = state.selection.includes(entry.path);
            const renaming = state.edit?.kind === "rename" && state.edit.path === entry.path;
            const drive = dirPath === COMPUTER ? places.drives.find(value => samePath(value.path, entry.path, places.separator)) : undefined;
            return <div key={entry.path} role="option" data-path={entry.path} aria-selected={picked || onPath}
              tabIndex={picked ? 0 : -1} className={`fb-crow${onPath ? " is-trail" : ""}${picked ? " is-selected" : ""}${renaming ? " is-editing" : ""}`}
              data-hidden={entry.hidden || undefined} data-denied={entry.denied || undefined}
              onClick={event => {
                if (!last) { if (entry.type === "dir") state.go(entry.path, { select: entry.path }); else { state.go(dirPath, { select: entry.path }); } return; }
                if (entry.type === "dir" && !isMod(event) && !event.shiftKey && !entry.denied) state.go(entry.path, { select: entry.path });
                else actions.select(entry, { ctrl: isMod(event), shift: event.shiftKey }, list);
              }}
              onDoubleClick={() => { if (entry.type === "file") actions.activate(entry); }}
              onContextMenu={event => { event.preventDefault(); if (!last) state.go(dirPath, { select: entry.path }); else if (!picked) actions.select(entry, { ctrl: false, shift: false }, list); actions.context(entry, { x: event.clientX, y: event.clientY }); }}>
              {drive ? <span className="fb-ico" data-kind="drive"><Icon name="drive" /></span> : <EntryIcon entry={entry} open={onPath} />}
              {renaming ? <EditInput state={state} places={places} copy={copy} language={language} /> : drive ? <span className="fb-name"><span className="ellipsis">{driveDisplayName(drive, places.separator)}</span></span> : <NameCell entry={entry} copy={copy} />}
              {entry.type === "dir" ? <Icon name="chevron-r" extra="sm" /> : null}
            </div>;
          }}</VirtualFileRows>}
        </>}
      </div>;
    })}
    {file ? <div className="fb-column fb-preview-column" key={`preview:${file.path}`}>{preview(file)}</div> : null}
    <div className="fb-columns-tail" aria-hidden="true" />
  </div>;
}
export type PreviewSlot = (entry: FsEntry) => ReactNode;

/* ---------- 预览卡（分栏末列） ---------- */

export function PreviewCard({ entry, peek, copy, language, actions }: { entry: FsEntry; peek: FsPeek | "loading" | undefined; copy: Copy; language: "zh" | "en"; actions: { icon: IconName; label: string; primary?: boolean; disabled?: string | undefined; run(): void }[] }) {
  const kind = fileKind(entry.name);
  const ftype = fileTypeOf(entry.name);
  return <article className="fb-peek" aria-label={copy(`预览 ${entry.name}`, `Preview ${entry.name}`)}>
    <div className="fb-peek-visual" data-ftype={ftype ?? undefined} data-kind={kind}>
      {peek !== "loading" && peek?.image ? <img src={peek.image} alt="" /> : <Icon name={iconNameFor(ftype, entry.name)} />}
      <span className="fb-peek-badge">{fileBadge(entry.name).badge}</span>
    </div>
    <h3 className="fb-peek-name" title={entry.name}>{entry.name}</h3>
    <p className="fb-peek-meta">{typeLabel(entry, copy)}{entry.size !== undefined ? ` · ${formatSize(entry.size)}` : ""}</p>
    <dl className="fb-peek-facts">
      {entry.modified !== undefined ? <><dt>{copy("修改时间", "Modified")}</dt><dd>{formatModified(entry.modified, Date.now(), language)}</dd></> : null}
      <dt>{copy("位置", "Location")}</dt><dd className="fb-peek-path" title={entry.path}>{entry.path}</dd>
    </dl>
    {peek === "loading" ? <div className="fb-peek-text fb-skeleton" aria-busy="true">{Array.from({ length: 5 }, (_, index) => <span key={index} style={{ ["--w" as string]: `${50 + (index * 29) % 40}%` } as CSSProperties} />)}</div>
      : peek?.text ? <pre className="fb-peek-text">{peek.text.split("\n").slice(0, 40).join("\n")}</pre> : null}
    <div className="fb-peek-actions">
      {actions.map(action => <button key={action.label} type="button" className={`btn small ${action.primary ? "primary" : "outline"}`} disabled={Boolean(action.disabled)} data-tip={action.disabled} onClick={action.run}><Icon name={action.icon} extra="sm" />{action.label}</button>)}
    </div>
  </article>;
}
