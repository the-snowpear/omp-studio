import { Fragment } from "react";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../icons";
import { MenuItem, useRowMenuAnchor } from "../menus";
import { PLATFORM } from "../platform";
import { useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";
import { COMPUTER, driveDisplayName, formatSize, normalizeInput, pathSegments, samePath, TIER_VIEWS, usageTone, within, type BrowserView, type FsDrive, type FsEntry, type FsPlaces, type FsQuickKind } from "./model";
import type { FileBrowserState } from "./useFileBrowser";
import type { Copy } from "./FileBrowserViews";

const QUICK_ICON: Record<FsQuickKind, IconName> = { home: "home", desktop: "monitor", downloads: "download", documents: "doc", pictures: "image" };

/* ---------- 工具栏 ---------- */

export function Toolbar({ state, places, tier, view, copy, disabled, onPlacesMenu, onMore }: {
  state: FileBrowserState; places: FsPlaces | undefined; tier: number; view: BrowserView; copy: Copy; disabled: boolean;
  onPlacesMenu(anchor: HTMLElement): void; onMore(anchor: HTMLElement): void;
}) {
  const [editing, setEditing] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterInput = useRef<HTMLInputElement>(null);
  const current = state.current;
  const mod = PLATFORM === "darwin" ? "⌘" : "Ctrl";
  useEffect(() => { if (filterOpen) filterInput.current?.focus(); }, [filterOpen]);
  useEffect(() => { setEditing(false); }, [current]);
  const nav = (icon: IconName, label: string, run: () => void, off: boolean, kbd?: string) =>
    <button type="button" className="icon-btn" aria-label={label} data-tip={kbd ? `${label} · ${kbd}` : label} disabled={disabled || off} onClick={run}><Icon name={icon} /></button>;
  const showFilterInline = tier >= 1;
  return <div className="fb-toolbar" role="toolbar" aria-label={copy("文件浏览器工具栏", "File browser toolbar")}>
    <div className="fb-nav">
      {nav("arrow-l", copy("后退", "Back"), state.goBack, !state.back.length, "Alt ←")}
      {tier >= 1 ? nav("arrow-r", copy("前进", "Forward"), state.goForward, !state.forward.length, "Alt →") : null}
      {nav("arrow-u", copy("上一级", "Up"), state.goUp, current === undefined || current === COMPUTER, "Alt ↑")}
      {nav("refresh", copy("刷新", "Refresh"), state.refresh, current === undefined, "F5")}
    </div>
    {tier === 0 ? <button type="button" className="fb-places-trigger" disabled={disabled || !places} aria-haspopup="menu" onClick={event => onPlacesMenu(event.currentTarget)}>
      <Icon name="drive" extra="sm" /><span>{copy("位置", "Places")}</span><Icon name="chevron-d" extra="sm" />
    </button> : null}
    {places && current !== undefined && editing
      ? <PathInput initial={current === COMPUTER ? "" : current} places={places} copy={copy} onSubmit={value => { setEditing(false); state.go(value); }} onCancel={() => setEditing(false)} />
      : <Breadcrumb state={state} places={places} tier={tier} copy={copy} disabled={disabled} onEdit={() => setEditing(true)} />}
    {showFilterInline || filterOpen ? <label className={`fb-filter${state.filter ? " has-value" : ""}`}>
      <Icon name="search" extra="sm" />
      <input ref={filterInput} className="input" value={state.filter} disabled={disabled} placeholder={copy("筛选当前文件夹", "Filter this folder")}
        aria-label={copy("筛选当前文件夹", "Filter this folder")} spellCheck={false}
        onChange={event => state.setFilter(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); state.setFilter(""); if (!showFilterInline) setFilterOpen(false); } }}
        onBlur={() => { if (!showFilterInline && !state.filter) setFilterOpen(false); }} />
      {state.filter ? <button type="button" className="icon-btn" aria-label={copy("清除筛选", "Clear filter")} onClick={() => state.setFilter("")}><Icon name="x" extra="sm" /></button> : null}
    </label> : <button type="button" className="icon-btn" aria-label={copy("筛选", "Filter")} data-tip={`${copy("筛选", "Filter")} · ${mod} F`} disabled={disabled} onClick={() => setFilterOpen(true)}><Icon name="search" /></button>}
    {tier >= 1 ? <ViewSwitch tier={tier} view={view} explicit={state.explicitView} copy={copy} disabled={disabled} onChoose={state.chooseView} /> : null}
    <button type="button" className="icon-btn" aria-label={copy("更多操作", "More actions")} data-tip={copy("更多", "More")} aria-haspopup="menu" disabled={disabled} onClick={event => onMore(event.currentTarget)}><Icon name="more" /></button>
  </div>;
}

const VIEW_META: Record<BrowserView, { icon: IconName; zh: string; en: string }> = {
  tree: { icon: "file-tree", zh: "树", en: "Tree" }, list: { icon: "view-list", zh: "列表", en: "List" }, columns: { icon: "view-columns", zh: "分栏", en: "Columns" },
};
/** 「树 | 列表 | 分栏」：放不下的视图置灰并说明原因；当前视图是因宽度临时降级的，原选择保留下划线提示。 */
function ViewSwitch({ tier, view, explicit, copy, disabled, onChoose }: { tier: number; view: BrowserView; explicit: BrowserView | null; copy: Copy; disabled: boolean; onChoose(view: BrowserView): void }) {
  const allowed = TIER_VIEWS[tier] ?? ["tree"];
  return <div className="fb-view-switch" role="radiogroup" aria-label={copy("视图", "View")}>
    {(Object.keys(VIEW_META) as BrowserView[]).map(item => {
      const meta = VIEW_META[item], fits = allowed.includes(item);
      const tip = fits ? copy(meta.zh, meta.en) : copy(`${meta.zh}：窗口太窄，拉宽后可用`, `${meta.en}: widen the window to use it`);
      return <button key={item} type="button" role="radio" aria-checked={view === item} aria-label={copy(`${meta.zh}视图`, `${meta.en} view`)} data-tip={tip}
        className={`fb-view-btn${view === item ? " is-active" : ""}${explicit === item && view !== item ? " is-deferred" : ""}`}
        disabled={disabled || !fits} onClick={() => onChoose(item)}>
        <Icon name={meta.icon} extra="sm" />{tier >= 2 ? <span>{copy(meta.zh, meta.en)}</span> : null}
      </button>;
    })}
  </div>;
}

function Breadcrumb({ state, places, tier, copy, disabled, onEdit }: { state: FileBrowserState; places: FsPlaces | undefined; tier: number; copy: Copy; disabled: boolean; onEdit(): void }) {
  const [overflow, setOverflow] = useState<HTMLElement | null>(null);
  if (!places || state.current === undefined) return <div className="fb-crumbs is-empty" />;
  const segments = pathSegments(state.current, places);
  const keep = tier === 0 ? 2 : tier === 1 ? 4 : 7;
  const folded = segments.length > keep + 1 ? segments.slice(1, segments.length - keep) : [];
  const visible = folded.length ? [segments[0]!, ...segments.slice(segments.length - keep)] : segments;
  const project = state.currentState?.dir?.project;
  return <div className="fb-crumbs" onClick={event => { if (event.target === event.currentTarget && !disabled) onEdit(); }} data-tip={copy("点击空白处输入路径", "Click empty space to type a path")}>
    {visible.map((segment, index) => {
      const last = index === visible.length - 1;
      const isProjectRoot = project !== undefined && samePath(segment.path, project.root, places.separator);
      return <span key={segment.path || "computer"} className="fb-crumb-item">
        {index === 1 && folded.length ? <><button type="button" className="fb-crumb" aria-label={copy("更多上级目录", "More parent folders")} onClick={event => setOverflow(event.currentTarget)}>…</button><Icon name="chevron-r" extra="sm" /></> : null}
        <button type="button" className={`fb-crumb${last ? " is-current" : ""}${isProjectRoot ? " is-project" : ""}`} aria-current={last ? "location" : undefined} disabled={disabled}
          onClick={() => last ? onEdit() : state.go(segment.path, { select: segments[segments.indexOf(segment) + 1]?.path })}>
          {index === 0 ? <Icon name={places.platform === "win32" ? "monitor" : "drive"} extra="sm" /> : null}
          {isProjectRoot ? <Icon name="diamond" extra="sm" /> : null}
          <span className="ellipsis">{segment.label}</span>
        </button>
        {last ? null : <Icon name="chevron-r" extra="sm" />}
      </span>;
    })}
    {overflow ? <Popover anchor={overflow} onClose={() => setOverflow(null)} label={copy("上级目录", "Parent folders")}>
      {folded.map(segment => <MenuItem key={segment.path} icon="folder" onClick={() => { setOverflow(null); state.go(segment.path); }}>{segment.label}</MenuItem>)}
    </Popover> : null}
  </div>;
}

function PathInput({ initial, places, copy, onSubmit, onCancel }: { initial: string; places: FsPlaces; copy: Copy; onSubmit(path: string): void; onCancel(): void }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const example = places.platform === "win32" ? "D:\\Project、~\\Downloads" : "/Users/demo/Tools、~/Downloads";
  return <form className="fb-path" onSubmit={event => { event.preventDefault(); const next = normalizeInput(value, places); if (next) onSubmit(next); else onCancel(); }}>
    <Icon name="folder-open" extra="sm" />
    <input ref={input} className="input" value={value} spellCheck={false} aria-label={copy("路径", "Path")} placeholder={copy(`输入路径，例如 ${example}`, `Type a path, e.g. ${example}`)}
      onChange={event => setValue(event.target.value)} onBlur={onCancel}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } }} />
    <kbd aria-hidden="true">Enter</kbd>
  </form>;
}

/* ---------- 位置栏 ---------- */

export function PlacesList({ state, places, copy, onPick, compact = false }: { state: FileBrowserState; places: FsPlaces; copy: Copy; onPick?: () => void; compact?: boolean }) {
  const current = state.current ?? COMPUTER;
  const all: string[] = [...places.quick.map(item => item.path), ...places.projects.map(item => item.root), ...state.pins, ...places.drives.map(item => item.path)];
  // 「你在哪」= 包含当前位置的最深的那个位置。
  const active = all.filter(path => within(current, path, places.separator)).sort((a, b) => b.length - a.length)[0];
  const item = (key: string, path: string, icon: IconName, label: ReactNode, extra?: ReactNode, attrs: Record<string, unknown> = {}) => {
    const on = active !== undefined && samePath(active, path, places.separator);
    return <button key={key} type="button" className={`fb-place${on ? " is-active" : ""}`} aria-current={on ? "location" : undefined} title={path}
      onClick={() => { state.go(path); onPick?.(); }} {...attrs}>
      <Icon name={icon} extra="sm" /><span className="fb-place-label">{label}</span>{extra}
    </button>;
  };
  return <nav className={`fb-places-list${compact ? " is-compact" : ""}`} aria-label={copy("位置", "Places")}>
    <Section title={copy("快速访问", "Quick access")}>{places.quick.map(place => item(`q:${place.path}`, place.path, QUICK_ICON[place.kind], place.label))}</Section>
    {places.projects.length ? <Section title={copy("项目", "Projects")}>{places.projects.map(project => item(`p:${project.root}`, project.root, "diamond", <span className="ellipsis">{project.name}</span>, project.current ? <span className="fb-dot" data-tip={copy("当前对话的项目", "This chat's project")} aria-label={copy("当前项目", "current project")} /> : null))}</Section> : null}
    <Section title={copy("已固定", "Pinned")}>
      {state.pins.length ? state.pins.map(path => item(`f:${path}`, path, "pin", <span className="ellipsis">{path.split(/[\\/]/).filter(Boolean).pop() ?? path}</span>, <span role="button" tabIndex={-1} className="fb-place-x" aria-label={copy("取消固定", "Unpin")} data-tip={copy("取消固定", "Unpin")} onClick={event => { event.stopPropagation(); state.togglePin(path); }}><Icon name="x" extra="sm" /></span>))
        : <p className="fb-places-hint">{copy("右键文件夹 → 固定到位置栏", "Right-click a folder → Pin")}</p>}
    </Section>
    <Section title={places.computerLabel}>{places.drives.map(drive => item(`d:${drive.path}`, drive.path, "drive", <DriveLabel drive={drive} places={places} copy={copy} />, undefined, drive.ready ? {} : { "data-unready": true }))}</Section>
  </nav>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="fb-places-section"><h4>{title}</h4>{children}</section>;
}

function DriveLabel({ drive, places, copy }: { drive: FsDrive; places: FsPlaces; copy: Copy }) {
  const tone = usageTone(drive);
  const used = drive.total && drive.free !== undefined ? 1 - drive.free / drive.total : undefined;
  return <span className="fb-drive" data-tip={drive.ready && used !== undefined ? copy(`可用 ${formatSize(drive.free)}，共 ${formatSize(drive.total)}`, `${formatSize(drive.free)} free of ${formatSize(drive.total)}`) : undefined}>
    <span className="fb-drive-line">
      <span className="ellipsis">{driveDisplayName(drive, places.separator)}</span>
      <span className="fb-drive-free">{drive.ready ? used !== undefined ? copy(`${formatSize(drive.free)} 可用`, `${formatSize(drive.free)} free`) : "" : copy("未就绪", "Not ready")}</span>
    </span>
    {drive.ready && used !== undefined ? <span className="fb-usage" data-tone={tone} style={{ ["--used" as string]: `${Math.round(used * 100)}%` } as CSSProperties} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)} aria-label={copy("已用空间", "Used space")} /> : null}
  </span>;
}

export function PlacesSidebar({ state, places, copy }: { state: FileBrowserState; places: FsPlaces; copy: Copy }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, width: state.placesWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return <>
    <aside className="fb-places" style={{ width: state.placesWidth }}><PlacesList state={state} places={places} copy={copy} /></aside>
    <div className="fb-splitter" role="separator" aria-orientation="vertical" aria-label={copy("调整位置栏宽度", "Resize places")} aria-valuenow={state.placesWidth} aria-valuemin={160} aria-valuemax={280} tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={event => { if (drag.current) state.resizePlaces(drag.current.width + event.clientX - drag.current.x); }}
      onPointerUp={() => { drag.current = null; }}
      onDoubleClick={() => state.resizePlaces(200)}
      onKeyDown={event => { if (event.key === "ArrowLeft") state.resizePlaces(state.placesWidth - 16); if (event.key === "ArrowRight") state.resizePlaces(state.placesWidth + 16); }} />
  </>;
}

/* ---------- 状态栏 ---------- */

export function StatusBar({ state, copy, sourceLabel, demo }: { state: FileBrowserState; copy: Copy; sourceLabel: string | undefined; demo: boolean }) {
  const dir = state.currentState?.dir;
  const all = dir?.entries ?? [];
  const hiddenCount = all.filter(entry => entry.hidden).length;
  const picked = state.entries.filter(entry => state.selection.includes(entry.path));
  const bytes = picked.reduce((sum, entry) => sum + (entry.type === "file" ? entry.size ?? 0 : 0), 0);
  return <footer className="fb-status" role="status" aria-live="polite">
    <span className="fb-stat">{dir ? copy(`${state.entries.length} 项`, `${state.entries.length} items`) : "—"}</span>
    {picked.length ? <span className="fb-stat is-strong">{copy(`已选 ${picked.length} 项`, `${picked.length} selected`)}{bytes ? <em>{formatSize(bytes)}</em> : null}</span> : null}
    {dir ? <button type="button" className="fb-stat is-button" aria-pressed={state.showHidden} data-tip={state.showHidden ? copy("点击不显示隐藏文件", "Click to hide") : copy("点击显示隐藏文件", "Click to show")} onClick={state.toggleHidden}>
      <Icon name={state.showHidden ? "eye" : "eye-off"} extra="sm" />{state.showHidden ? copy("含隐藏文件", "Incl. hidden") : hiddenCount ? copy(`${hiddenCount} 个已隐藏`, `${hiddenCount} hidden`) : copy("隐藏文件：关", "Hidden files: off")}
    </button> : null}
    {dir?.truncated ? <span className="fb-chip" data-tone="warn" data-tip={copy("文件夹太大，只读取了前一部分；用筛选或路径栏缩小范围", "Large folder: only the first part was read")}><Icon name="alert" extra="sm" />{copy("仅显示前 5000 项", "First 5000 items")}</span> : null}
    <span className="fb-status-fill" />
    {dir?.project ? <span className="fb-stat is-project"><Icon name="diamond" extra="sm" />{dir.project.name}</span> : null}
    {sourceLabel ? <span className="fb-stat"><span className="fb-live" aria-hidden="true" />{sourceLabel}</span> : null}
    {demo ? <span className="chip xs">{copy("演示", "Demo")}</span> : null}
  </footer>;
}

/* ---------- 弹层：右键菜单 / 位置下拉 / 面包屑折叠 ---------- */

export function Popover({ anchor, point, onClose, label, children, className = "" }: { anchor?: HTMLElement | null; point?: { x: number; y: number } | null; onClose(): void; label: string; children: ReactNode; className?: string }) {
  const document = useSurfaceDocument(), window = surfaceWindow(document);
  // 锚点只在打开时量一次；每次渲染都换新对象会让定位 effect 无限重跑。
  const [contextPoint] = useState(() => point ?? (anchor ? (() => { const rect = anchor.getBoundingClientRect(); return { x: rect.left, y: rect.bottom + 4 }; })() : null));
  const { menuRef, anchor: placed } = useRowMenuAnchor(true, contextPoint, window);
  useEffect(() => {
    const onDown = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) onClose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); anchor?.focus(); } };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey, true); };
  }, [document, anchor, onClose, menuRef]);
  useEffect(() => { menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled), button:not(:disabled)')?.focus(); }, [menuRef]);
  return createPortal(<div ref={menuRef} className={`menu title-menu-popover fb-menu ${className}`} role="menu" aria-label={label} style={{ top: placed.top, left: placed.left }}
    onKeyDown={event => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLElement);
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }}
    onContextMenu={event => event.preventDefault()}>{children}</div>, document.body);
}

export interface MenuEntry { icon?: IconName; label: string; kbd?: string; disabled?: string | undefined; danger?: boolean; run(): void }
export type BrowserMenuEntry = MenuEntry | "sep" | { id: string; content: ReactNode };
export function MenuEntries({ entries, onClose }: { entries: readonly BrowserMenuEntry[]; onClose(): void }) {
  return <>{entries.map((entry, index) => entry === "sep" ? <div key={`sep-${index}`} className="menu-sep" /> : "content" in entry ? <Fragment key={entry.id}>{entry.content}</Fragment> : <span key={entry.label} className={entry.danger ? "fb-menu-danger" : undefined}>
    <MenuItem {...(entry.icon ? { icon: entry.icon } : {})} {...(entry.kbd ? { kbd: entry.kbd } : {})} disabled={Boolean(entry.disabled)} title={entry.disabled} onClick={() => { onClose(); entry.run(); }}>{entry.label}</MenuItem>
  </span>)}</>;
}

/* ---------- 移到回收站确认 ---------- */

export function TrashDialog({ items, places, copy, demo, onCancel, onConfirm }: { items: readonly FsEntry[]; places: FsPlaces; copy: Copy; demo: boolean; onCancel(): void; onConfirm(): void }) {
  const document = useSurfaceDocument(), window = surfaceWindow(document);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, window]);
  const projectRoot = items.find(item => places.projects.some(project => samePath(project.root, item.path, places.separator)));
  const bin = places.platform === "darwin" ? copy("废纸篓", "Trash") : copy("回收站", "Recycle Bin");
  const one = items.length === 1 ? items[0]! : undefined;
  return createPortal(<div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={onCancel}>
    <section className="modal create-project-modal create-branch-modal fb-trash-dialog" role="alertdialog" aria-modal="true" aria-labelledby="fbTrashTitle" onMouseDown={event => event.stopPropagation()}>
      <div className="create-project-head">
        <div>
          <span className="create-project-kicker">{copy("文件浏览器", "File browser")}</span>
          <h2 id="fbTrashTitle">{one ? copy(`将「${one.name}」移到${bin}？`, `Move "${one.name}" to the ${bin}?`) : copy(`将 ${items.length} 个项目移到${bin}？`, `Move ${items.length} items to the ${bin}?`)}</h2>
          <p className="create-branch-sub">{copy(`可以在${bin}里还原，不会永久删除。`, `You can restore it from the ${bin}; nothing is deleted permanently.`)}</p>
        </div>
        <button type="button" className="icon-btn" aria-label={copy("关闭", "Close")} onClick={onCancel}><Icon name="x" /></button>
      </div>
      <div className="create-project-body">
        <ul className="fb-trash-list">{items.slice(0, 6).map(item => <li key={item.path}><Icon name={item.type === "dir" ? "folder" : "file"} extra="sm" /><span className="ellipsis" title={item.path}>{item.path}</span></li>)}{items.length > 6 ? <li className="muted">{copy(`以及另外 ${items.length - 6} 项`, `and ${items.length - 6} more`)}</li> : null}</ul>
        {projectRoot ? <p className="fb-trash-warn" role="alert"><Icon name="alert" extra="sm" />{copy(`「${projectRoot.name}」是已注册项目的根目录，移走后该项目的对话将找不到文件。`, `"${projectRoot.name}" is a project root; its chats will lose their files.`)}</p> : null}
        {demo ? <p className="create-branch-hint">{copy("演示模式只改界面，不会动磁盘。", "Demo mode only changes the view.")}</p> : null}
      </div>
      <div className="create-project-foot">
        <button type="button" className="btn outline" onClick={onCancel}>{copy("取消", "Cancel")}</button>
        <button type="button" className="btn primary fb-danger" autoFocus onClick={onConfirm}><Icon name="trash" extra="sm" />{copy(`移到${bin}`, `Move to ${bin}`)}</button>
      </div>
    </section>
  </div>, document.body);
}
