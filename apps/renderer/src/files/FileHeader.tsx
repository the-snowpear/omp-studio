import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../icons";
import { MenuItem, useRowMenuAnchor } from "../menus";
import { surfaceWindow, useSurfaceDocument } from "../dock/SurfaceContext";
import { PLATFORM } from "../platform";
import type { FileViewMode } from "../dock/types";

export const MOD_KEY = PLATFORM === "darwin" ? "⌘" : "Ctrl";
export type FileMenuEntry =
  | { kind: "item"; id: string; label: string; icon?: IconName; run: () => void; disabled?: boolean | undefined; tip?: string | undefined; kbd?: string | undefined }
  | { kind: "label"; id: string; label: string }
  | { kind: "zoom"; id: string; value: number; onChange: (delta: number | null) => void }
  | { kind: "sep"; id: string };
export interface FileTool { id: string; icon: IconName; tip: string; run: () => void; active?: boolean; disabled?: boolean }
export interface FileModeOption { id: FileViewMode; label: string; icon: IconName }

/** Breadcrumb, state badges, view switch, tool icons, Save and the ⋯ menu. */
export function FileHeader({ path, badge, dirty, readOnly, demo, git, modes, mode, onMode, tools, save, menu, onCopyPath }: {
  path: string; badge: { badge: string; tone: string; label: string }; dirty: boolean; readOnly: boolean; demo: boolean;
  git: { additions: number; deletions: number } | null;
  modes: FileModeOption[] | null; mode: FileViewMode; onMode: (mode: FileViewMode) => void;
  tools: FileTool[]; save: { saving: boolean; disabled: boolean; run: () => void } | null;
  menu: FileMenuEntry[]; onCopyPath: () => void;
}) {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean), name = parts.pop() ?? path;
  return <header className="file-header">
    <div className="file-crumbs" data-tip={path}>
      <span className={`file-badge tone-${badge.tone}`} aria-label={badge.label}>{badge.badge}</span>
      {parts.length ? <span className="file-crumb-dirs"><span dir="ltr">{parts.map((part, index) => <span key={index}>{part}<i aria-hidden="true">/</i></span>)}</span></span> : null}
      <button type="button" className="file-crumb-name" aria-label={`复制路径 ${path}`} onClick={onCopyPath}>{name}</button>
      {dirty ? <span className="file-dirty-dot" role="status" aria-label="未保存" data-tip="有未保存的修改" /> : null}
      {readOnly ? <span className="file-tag" data-tip="此文件不可写"><Icon name="lock" extra="sm" />只读</span> : null}
      {git ? <span className="file-tag tone-git" data-tip="相对暂存区的工作区改动">已修改{git.additions ? <b className="add">+{git.additions}</b> : null}{git.deletions ? <b className="del">−{git.deletions}</b> : null}</span> : null}
      {demo ? <span className="file-tag">演示</span> : null}
    </div>
    <div className="file-header-actions">
      {modes && modes.length > 1 ? <span className="seg file-modes" role="radiogroup" aria-label="视图">{modes.map(option => <button key={option.id} type="button" role="radio" aria-checked={mode === option.id} className={mode === option.id ? "active" : ""} data-tip={option.label} onClick={() => onMode(option.id)}><Icon name={option.icon} extra="sm" /><span className="file-mode-label">{option.label}</span></button>)}</span> : null}
      {tools.map(tool => <button key={tool.id} type="button" className={`icon-btn file-tool${tool.active ? " is-active" : ""}`} aria-pressed={tool.active} aria-label={tool.tip} data-tip={tool.tip} disabled={tool.disabled} onClick={tool.run}><Icon name={tool.icon} extra="sm" /></button>)}
      {save ? <button type="button" className="file-save" disabled={save.disabled} onClick={save.run} data-tip={`保存（${MOD_KEY} S）`}>{save.saving ? <span className="file-spinner" aria-hidden="true" /> : <Icon name="save" extra="sm" />}{save.saving ? "保存中" : "保存"}</button> : null}
      <FileMoreMenu entries={menu} />
    </div>
  </header>;
}

function FileMoreMenu({ entries }: { entries: FileMenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const document = useSurfaceDocument(), window = surfaceWindow(document);
  const { buttonRef, menuRef, anchor } = useRowMenuAnchor(open, null, window);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (!menuRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const blur = () => setOpen(false);
    window.addEventListener("mousedown", close); window.addEventListener("keydown", key); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", key); window.removeEventListener("blur", blur); };
  }, [open, window]);
  const render = (entry: FileMenuEntry): ReactNode => {
    if (entry.kind === "sep") return <div key={entry.id} className="menu-sep" />;
    if (entry.kind === "label") return <div key={entry.id} className="file-menu-label">{entry.label}</div>;
    if (entry.kind === "zoom") return <div key={entry.id} className="file-menu-zoom"><Icon name="type" extra="sm" /><span>字号</span><span className="file-menu-zoom-ctl"><button type="button" aria-label="缩小字号" onClick={() => entry.onChange(-1)}>−</button><button type="button" className="value" data-tip="重置为默认" onClick={() => entry.onChange(null)}>{entry.value}</button><button type="button" aria-label="放大字号" onClick={() => entry.onChange(1)}>+</button></span></div>;
    return <MenuItem key={entry.id} {...(entry.icon ? { icon: entry.icon } : {})} {...(entry.kbd ? { kbd: entry.kbd } : {})} disabled={!!entry.disabled} title={entry.tip} onClick={() => { setOpen(false); entry.run(); }}>{entry.label}</MenuItem>;
  };
  return <>
    <button ref={buttonRef} type="button" className={`icon-btn file-tool${open ? " is-active" : ""}`} aria-label="更多操作" data-tip="更多" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><Icon name="more" extra="sm" /></button>
    {open ? createPortal(<div ref={menuRef} className="menu title-menu-popover file-more-menu" role="menu" style={{ top: anchor.top, left: anchor.left }}>{entries.map(render)}</div>, document.body) : null}
  </>;
}
