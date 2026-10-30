import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { MenuItem } from "../menus";
import { formatShortcut } from "../keyboard/shortcuts";
import { useDock } from "./DockContext";
import { locatePanel } from "./model";
import type { DockAction, DockGroup, DockLayout, DockLocation, DockPreset, DockRegionId, PanelId } from "./types";
import "./menus.css";

export function useDockCopy() {
  const { resolvedLanguage } = useI18n();
  return (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
}
type Copy = ReturnType<typeof useDockCopy>;

export function dockPresetName(preset: DockPreset, copy: Copy) {
  if (!preset.builtin) return preset.name;
  if (preset.id === "default") return copy("默认", "Default");
  if (preset.id === "focus") return copy("专注", "Focus");
  if (preset.id === "debug") return copy("调试", "Debug");
  return preset.name;
}

function regionName(region: DockLocation["region"], copy: Copy) {
  return { left: copy("左侧栏", "Left sidebar"), rail: copy("对话工具区", "Conversation tools"), right: copy("右侧栏", "Right sidebar"), bottom: copy("底栏", "Bottom bar"), float: copy("浮窗", "Floating window") }[region];
}
function groupAt(layout: DockLayout, id?: string): DockGroup | undefined {
  return [...layout.right.groups, ...layout.bottom.groups, ...layout.floats].find(group => group.id === id);
}
function locationDescription(layout: DockLayout, panel: PanelId, copy: Copy) {
  const placed = locatePanel(layout, panel);
  const location = placed ?? layout.hidden[panel];
  if (!location) return copy("隐藏", "Hidden");
  let label = regionName(location.region, copy);
  if (location.region === "right" || location.region === "bottom") {
    const groups = layout[location.region].groups;
    if (groups.length > 1) {
      const index = groups.findIndex(group => group.id === location.groupId);
      label += location.region === "right" ? (index === 0 ? copy(" · 上方", " · Upper") : copy(" · 下方", " · Lower")) : (index === 0 ? copy(" · 左组", " · Left group") : copy(" · 右组", " · Right group"));
    }
  }
  if (!placed) return `${label} · ${copy("隐藏", "Hidden")}`;
  const hidden = location.region === "rail" ? layout.rail.mode === "hidden" : location.region !== "float" && !layout[location.region].visible;
  if (hidden) return `${label} · ${copy("区域隐藏", "Region hidden")}`;
  if (location.region === "float" && layout.floats.find(group => group.id === location.groupId)?.minimized) return `${label} · ${copy("最小化", "Minimized")}`;
  if ((location.region === "left" || location.region === "rail") && layout.cards[panel].collapsed) return `${label} · ${copy("折叠", "Collapsed")}`;
  if (location.region === "bottom" && !layout.bottom.expanded) return `${label} · ${copy("折叠", "Collapsed")}`;
  return label;
}

function MenuSection({ label, icon, children }: { label: string; icon: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="dock-menu-section">
    <button type="button" className="menu-item" role="menuitem" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <Icon name={icon} extra="sm" /><span>{label}</span><Icon name={open ? "chevron-u" : "chevron-d"} extra="sm" />
    </button>
    {open ? <div className="dock-menu-subsection" id={id} role="group" aria-label={label}>{children}</div> : null}
  </div>;
}
function MenuToggle({ label, checked, icon, onClick, kbd }: { label: string; checked: boolean; icon: string; onClick: () => void; kbd?: string | undefined }) {
  return <button type="button" className="menu-item" role="menuitemcheckbox" aria-checked={checked} onClick={onClick}>
    <Icon name={icon} extra="sm" /><span>{label}</span>{kbd ? <span className="kbd" aria-hidden="true">{kbd}</span> : null}<span className="dock-menu-check">{checked ? <Icon name="check" extra="sm" /> : null}</span>
  </button>;
}

/** Shared inline form: custom presets never use native prompt/confirm dialogs. */
export function DockPresetNameForm({ initialName = "", onSave, onCancel }: { initialName?: string; onSave: (name: string) => void; onCancel: () => void }) {
  const copy = useDockCopy();
  const [name, setName] = useState(initialName);
  const id = useId();
  return <form className="dock-preset-form" onSubmit={event => { event.preventDefault(); if (name.trim()) onSave(name.trim()); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    else event.stopPropagation();
  }}>
    <label htmlFor={id}>{copy("预设名称", "Preset name")}</label>
    <input id={id} className="input" autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)} />
    <div className="dock-preset-actions"><button type="submit" className="btn small" disabled={!name.trim()}>{copy("保存", "Save")}</button><button type="button" className="btn small outline" onClick={onCancel}>{copy("取消", "Cancel")}</button></div>
  </form>;
}

function DockToolItems({ onClose }: { onClose?: (() => void) | undefined }) {
  const { layout, definitions, store } = useDock();
  const copy = useDockCopy();
  return <>{definitions.map(panel => <MenuItem key={panel.id} icon={panel.icon} hint={locationDescription(layout, panel.id, copy)} title={`${panel.title} · ${locationDescription(layout, panel.id, copy)}`} onClick={() => { store.dispatch({ type: "open", panel: panel.id }); onClose?.(); }}>{panel.title}</MenuItem>)}</>;
}

/**
 * What a region toggle shows. `visible` is the persisted preference; `presented`
 * is what the layout solver actually put on screen. A narrow window can hold
 * `visible && !presented` — the region is preferred on but clipped, which is the
 * case where the menu used to render "checked" while nothing was shown.
 */
export type DockRegionToggleState = { visible: boolean; presented: boolean };

/** Contents only; the caller owns the View menu popover. */
export function DockViewMenu({ onClose, onSettings, groupId, regionState }: { onClose?: (() => void) | undefined; onSettings?: (() => void) | undefined; groupId?: string | undefined; regionState?: Partial<Record<DockRegionId, DockRegionToggleState>> | undefined }) {
  const { layout, preferences, presets, store, preview, modified, canUndo, canRedo } = useDock();
  const copy = useDockCopy();
  const [saving, setSaving] = useState(false);
  const current = presets.find(preset => preset.id === layout.presetId);
  const group = groupAt(layout, groupId);
  const run = (action: DockAction) => { store.dispatch(action); onClose?.(); };
  return <div className="dock-menu-content" data-dock-menu="view">
    <div className="menu-label dock-menu-heading">{copy("工作台布局", "Workbench layout")}{preview ? <span className="chip amber xs demo-chip">{copy("演示", "Demo")}</span> : null}</div>
    <div className="menu-label">{copy("区域", "Regions")}</div>
    {(["left", "right", "bottom", "rail"] as const).map(region => {
      const state = regionState?.[region];
      // Checked follows what is on screen, so the menu can never disagree with
      // the workspace. The toggle asks for the opposite of the presented state:
      // "off" opens it, "preferred on but clipped" re-presents it (a no-op store
      // commit still broadcasts the region action, which lets the shell take the
      // focus priority back), and "on screen" closes it.
      const shown = state ? state.presented : region === "rail" ? layout.rail.mode !== "hidden" : layout[region].visible;
      const nextVisible = state ? !state.presented : region === "rail" ? layout.rail.mode === "hidden" : !layout[region].visible;
      return <MenuToggle key={region} icon={{ left: "layout", right: "panel", bottom: "panel-bottom", rail: "layers" }[region]} label={regionName(region, copy)} checked={shown} kbd={region === "left" ? formatShortcut({ key: "B" }) : region === "bottom" ? formatShortcut({ key: "J" }) : region === "rail" ? formatShortcut({ key: "L", shift: true }) : undefined} onClick={() => run({ type: "region", region, visible: nextVisible })} />;
    })}
    <div className="menu-sep" />
    <MenuSection label={copy("工具", "Tools")} icon="wrench"><DockToolItems onClose={onClose} /></MenuSection>
    {group ? <MenuSection label={copy("当前组", "Current group")} icon="layers"><DockPanelMenu panels={group.panels} groupId={group.id} onClose={onClose} /></MenuSection> : <MenuItem icon="layers" disabled title={copy("请在卡片或标签组的更多菜单中选择操作目标。", "Choose a card or tab group's More menu to select a target.")}>{copy("当前组（未选择）", "Current group (none selected)")}</MenuItem>}
    <div className="menu-sep" />
    <MenuSection label={`${copy("预设", "Presets")} · ${current ? dockPresetName(current, copy) : copy("自定义", "Custom")}${modified ? ` · ${copy("已修改", "Modified")}` : ""}`} icon="layout">
      {presets.map(preset => <button type="button" key={preset.id} className="menu-item" role="menuitemradio" aria-checked={layout.presetId === preset.id} onClick={() => { store.applyPreset(preset.id); onClose?.(); }}><span>{dockPresetName(preset, copy)}</span>{layout.presetId === preset.id ? <Icon name="check" extra="sm" /> : null}</button>)}
      <div className="menu-sep" />
      {saving ? <DockPresetNameForm onSave={name => { store.savePreset(name); setSaving(false); onClose?.(); }} onCancel={() => setSaving(false)} /> : <MenuItem icon="save" onClick={() => setSaving(true)}>{copy("另存为预设…", "Save as preset…")}</MenuItem>}
      <MenuItem icon="refresh" onClick={() => { store.resetPreset(); onClose?.(); }}>{copy("恢复当前预设", "Restore current preset")}</MenuItem>
      <MenuItem icon="restore" onClick={() => { store.resetFactory(); onClose?.(); }}>{copy("恢复出厂布局", "Restore factory layout")}</MenuItem>
    </MenuSection>
    <div className="menu-sep" />
    <MenuItem icon="undo" disabled={!canUndo || preferences.locked} title={preferences.locked ? copy("先解锁布局以撤销结构和尺寸修改。", "Unlock the layout to undo structural and size changes.") : undefined} onClick={() => { store.undo(); onClose?.(); }}>{copy("撤销布局修改", "Undo layout change")}</MenuItem>
    <MenuItem icon="refresh" disabled={!canRedo || preferences.locked} title={preferences.locked ? copy("先解锁布局以重做结构和尺寸修改。", "Unlock the layout to redo structural and size changes.") : undefined} onClick={() => { store.redo(); onClose?.(); }}>{copy("重做布局修改", "Redo layout change")}</MenuItem>
    <MenuToggle label={copy("锁定布局", "Lock layout")} icon={preferences.locked ? "lock" : "unlock"} checked={preferences.locked} onClick={() => store.updatePreferences({ locked: !preferences.locked })} />
    <MenuToggle label={copy("停靠吸附", "Dock snapping")} icon="pin" checked={preferences.snap} onClick={() => store.updatePreferences({ snap: !preferences.snap })} />
    {onSettings ? <MenuItem icon="settings" onClick={() => { onClose?.(); onSettings(); }}>{copy("布局设置…", "Layout settings…")}</MenuItem> : null}
  </div>;
}

/** Shared by a single card/tab and a whole group's More menu. */
export function DockPanelMenu({ panels, groupId, onClose }: { panels: PanelId[]; groupId?: string | undefined; onClose?: (() => void) | undefined }) {
  const { layout, preferences, store, definitions } = useDock();
  const copy = useDockCopy();
  const first = panels[0];
  const source = first ? locatePanel(layout, first) : undefined;
  const group = groupAt(layout, groupId ?? source?.groupId);
  const wholeGroup = !!groupId && !!group && group.panels.length === panels.length && group.panels.every(panel => panels.includes(panel));
  const locked = preferences.locked;
  const lockReason = copy("布局已锁定；先解锁以移动、分组或调整尺寸。", "Layout locked; unlock to move, group or resize tools.");
  const run = (action: DockAction) => { store.dispatch(action); onClose?.(); };
  const move = (target: DockLocation & { split?: "before" | "after" }, selected = panels) => run({ type: "move", panels: selected, target });
  const siblings = source?.region === "left" || source?.region === "rail" ? layout[source.region].panels : group?.panels ?? [];
  const position = first ? siblings.indexOf(first) : -1;
  const splitPanels = wholeGroup && group ? [group.active] : panels;
  const title = wholeGroup ? copy("整组操作", "Group actions") : definitions.find(panel => panel.id === first)?.title ?? copy("工具操作", "Tool actions");
  return <div className="dock-menu-content" data-dock-menu="panel">
    <div className="menu-label">{title}</div>
    <MenuSection label={wholeGroup ? copy("整组移动到", "Move group to") : copy("移动到", "Move to")} icon="handoff">
      {(["left", "rail", "right", "bottom"] as const).map(region => {
        const groups = region === "right" || region === "bottom" ? layout[region].groups : [];
        return groups.length > 1 ? groups.map((targetGroup, index) => <MenuItem key={targetGroup.id} disabled={locked} title={locked ? lockReason : undefined} onClick={() => move({ region, groupId: targetGroup.id })}>{regionName(region, copy)} · {region === "right" ? (index === 0 ? copy("上方组", "Upper group") : copy("下方组", "Lower group")) : (index === 0 ? copy("左组", "Left group") : copy("右组", "Right group"))}</MenuItem>) : <MenuItem key={region} disabled={locked} title={locked ? lockReason : undefined} onClick={() => move({ region })}>{regionName(region, copy)}</MenuItem>;
      })}
      <MenuItem icon="external" disabled={locked} title={locked ? lockReason : undefined} onClick={() => move({ region: "float" })}>{wholeGroup ? copy("浮动整组", "Float group") : copy("浮动", "Float")}</MenuItem>
    </MenuSection>
    {!wholeGroup && panels.length === 1 ? <>
      <MenuItem icon="arrow-u" disabled={locked || position <= 0} title={locked ? lockReason : undefined} onClick={() => { if (source) move({ ...source, index: position - 1 }); }}>{copy("向前排列", "Move earlier")}</MenuItem>
      <MenuItem icon="arrow-d" disabled={locked || position < 0 || position >= siblings.length - 1} title={locked ? lockReason : undefined} onClick={() => { if (source) move({ ...source, index: position + 2 }); }}>{copy("向后排列", "Move later")}</MenuItem>
    </> : null}
    <MenuSection label={copy("拆分与合并", "Split and merge")} icon="split">
      {(["right", "bottom"] as const).map(region => {
        const groups = layout[region].groups;
        const targetGroup = groups.find(candidate => candidate.id === source?.groupId) ?? groups[0];
        const leavesSource = !targetGroup || targetGroup.panels.some(panel => !splitPanels.includes(panel));
        const available = groups.length === 1 && leavesSource;
        const reason = locked ? lockReason : groups.length >= 2 ? copy("此区域最多容纳两个标签组。", "This region supports at most two tab groups.") : !leavesSource ? copy("需在原组保留至少一个工具。", "Keep at least one tool in the original group.") : copy("先在此区域打开一个标签组。", "Open a tab group in this region first.");
        return <MenuItem key={region} icon={region === "right" ? "rows" : "columns"} disabled={locked || !available} title={locked || !available ? reason : undefined} onClick={() => move({ region, ...(targetGroup ? { groupId: targetGroup.id } : {}), split: "after" }, splitPanels)}>{wholeGroup ? copy("将当前标签拆到", "Split active tab into") : copy("拆到", "Split into")} {region === "right" ? copy("右栏第二组", "a second right group") : copy("底栏第二组", "a second bottom group")}</MenuItem>;
      })}
      {[...layout.right.groups.map(target => ({ region: "right" as const, target })), ...layout.bottom.groups.map(target => ({ region: "bottom" as const, target })), ...layout.floats.map(target => ({ region: "float" as const, target }))].filter(({ target }) => target.id !== source?.groupId).map(({ region, target }) => <MenuItem key={target.id} disabled={locked} title={locked ? lockReason : undefined} onClick={() => move({ region, groupId: target.id })}>{copy("合并到", "Merge into")} {regionName(region, copy)} · {definitions.find(panel => panel.id === target.active)?.title ?? target.active}</MenuItem>)}
    </MenuSection>
    {first && panels.length === 1 && (source?.region === "left" || source?.region === "rail") ? <>
      <div className="menu-sep" />
      <MenuItem icon={layout.cards[first].collapsed ? "chevron-d" : "chevron-u"} onClick={() => run({ type: "card", panel: first, collapsed: !layout.cards[first].collapsed })}>{layout.cards[first].collapsed ? copy("展开卡片", "Expand card") : copy("折叠卡片", "Collapse card")}</MenuItem>
      <MenuItem icon="restore" disabled={locked || layout.cards[first].height === null} title={locked ? lockReason : undefined} onClick={() => run({ type: "card", panel: first, height: null })}>{copy("恢复自动高度", "Restore automatic height")}</MenuItem>
    </> : null}
    <div className="menu-sep" />
    <MenuItem icon="eye-off" disabled={panels.length === 0} onClick={() => run({ type: "hide", panels })}>{wholeGroup ? copy("隐藏整组", "Hide group") : copy("隐藏工具", "Hide tool")}</MenuItem>
  </div>;
}

function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
  if (event.defaultPrevented || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
  event.preventDefault();
  event.stopPropagation();
  items[next]?.focus();
}

function DockPopupButton({ label, icon, children }: { label: string; icon: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const close = () => { setOpen(false); button.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = button.current?.getBoundingClientRect();
      const menu = popup.current;
      if (!anchor || !menu) return;
      setPosition({ left: Math.max(8, Math.min(anchor.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)), top: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - menu.offsetHeight - 8)) });
    };
    place();
    popup.current?.querySelector<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')?.focus();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (popup.current) resize?.observe(popup.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { resize?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside); };
  }, [open]);
  return <>
    <button ref={button} type="button" className={`icon-btn dock-menu-button${open ? " open" : ""}`} data-tip={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setOpen(!open); }} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); setOpen(true); } }}><Icon name={icon} extra="sm" /></button>
    {open ? createPortal(<div ref={popup} id={id} className="menu dock-menu-popover" role="menu" aria-label={label} data-dock-menu="popup" style={position} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); } else menuKeys(event);
    }}>{children(close)}</div>, document.body) : null}
  </>;
}

export function DockMenuButton({ panels, groupId }: { panels: PanelId[]; groupId?: string | undefined }) {
  const copy = useDockCopy();
  return <DockPopupButton label={copy("停靠选项", "Dock options")} icon="more">{close => <DockPanelMenu panels={panels} groupId={groupId} onClose={close} />}</DockPopupButton>;
}
export function DockToolsButton() {
  const copy = useDockCopy();
  return <DockPopupButton label={copy("添加工具", "Add tool")} icon="plus">{close => <div className="dock-menu-content"><div className="menu-label">{copy("打开或找回工具", "Open or restore a tool")}</div><DockToolItems onClose={close} /></div>}</DockPopupButton>;
}
