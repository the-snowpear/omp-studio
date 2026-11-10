import { isFilePanelId } from "./types";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../icons";
import { useI18n } from "../i18n";
import { MenuItem } from "../menus";
import { formatShortcut } from "../keyboard/shortcuts";
import { usePreviewMode } from "../preview/PreviewContext";
import { useDock } from "./DockContext";
import { browserRevealTarget, locatePanel } from "./model";
import { closePanels } from "./panelChrome";
import { groupToolPanels } from "./toolGroups";
import { useSurfaceDocument, surfaceWindow, revealMainWindow } from "./SurfaceContext";
import type { DockFloat, DockPinMode } from "./types";
import { isBrowserPagePanelId, isInstancePanelId, isScopedPanelId, type AgentPanelId, type BrowserPagePanelId, type DockAction, type DockGroup, type DockLayout, type DockLocation, type DockPreset, type DockRegionId, type PanelId } from "./types";
import { useWindowFocus } from "./windowOrder";
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
export function locationDescription(layout: DockLayout, panel: PanelId, copy: Copy) {
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
  if ((location.region === "left" || location.region === "rail") && layout.cards[panel]!.collapsed) return `${label} · ${copy("折叠", "Collapsed")}`;
  if (location.region === "bottom" && !layout.bottom.expanded) return `${label} · ${copy("折叠", "Collapsed")}`;
  return label;
}

function MenuSection({ label, icon, children }: { label: string; icon: IconName; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="dock-menu-section">
    <button type="button" className="menu-item" role="menuitem" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <Icon name={icon} extra="sm" /><span>{label}</span><Icon name={open ? "chevron-u" : "chevron-d"} extra="sm" />
    </button>
    {open ? <div className="dock-menu-subsection" id={id} role="group" aria-label={label}>{children}</div> : null}
  </div>;
}
function MenuToggle({ label, checked, icon, onClick, kbd }: { label: string; checked: boolean; icon: IconName; onClick: () => void; kbd?: string | undefined }) {
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

function DockToolItems({ onClose, onPick, exclude }: { onClose?: (() => void) | undefined; onPick?: ((panel: PanelId) => void) | undefined; exclude?: readonly PanelId[] | undefined }) {
  const { layout, definitions, store, agentCatalog, scope } = useDock();
  const copy = useDockCopy();
  const available = definitions.filter(panel => panel.id !== "agent-detail" && !isInstancePanelId(panel.id) && !isScopedPanelId(panel.id) && !exclude?.includes(panel.id));
  const byId = new Map(available.map(panel => [panel.id, panel]));
  const entries = agentCatalog?.entries ?? [];
  const known = Object.entries(layout.agentPanels).filter(([, descriptor]) => !entries.some(entry => entry.agentId === descriptor.target.agentId));
  const groups = groupToolPanels(available.map(panel => panel.id));
  // 子 Agent 跟着「常用」里的 Agents 走，放在常用组末尾；常用整组都进过标签时
  // 仍兜底渲染一次，别让会话里的实例从菜单里消失。
  const agentSection = <MenuSection label={copy("子 Agent", "Subagents")} icon="bot">
    {entries.map(entry => <MenuItem key={entry.agentId} icon="message" title={`${entry.name} · ${entry.status} · ${entry.model}`} onClick={() => { agentCatalog?.open(entry.agentId); onClose?.(); }}>{entry.name}</MenuItem>)}
    {known.map(([id, descriptor]) => <MenuItem key={id} icon="message" onClick={() => { store.dispatch({ type: "agent-open", panel: id as AgentPanelId, descriptor }); onClose?.(); }}>{descriptor.target.displayName ?? descriptor.target.agentId}</MenuItem>)}
    {!entries.length && !known.length ? <MenuItem icon="bot" disabled>{copy("当前会话没有子 Agent", "No agents in this session")}</MenuItem> : null}
  </MenuSection>;
  // A page tab can sit in a hidden region or a minimized window; this finds it again.
  const pages = (Object.keys(layout.browserPages) as BrowserPagePanelId[]).filter(id => layout.browserPages[id]!.sessionId === scope.session && locatePanel(layout, id) && !exclude?.includes(id));
  const pageSection = pages.length ? <MenuSection label={copy("网页", "Web pages")} icon="globe">
    {pages.map(id => {
      const panel = definitions.find(item => item.id === id);
      const title = panel?.title ?? layout.browserPages[id]!.title ?? "Browser";
      const location = locationDescription(layout, id, copy);
      return <MenuItem key={id} icon="globe" hint={location} title={`${title} · ${location}`} onClick={() => { store.dispatch({ type: "open", panel: id }); store.dispatch({ type: "browser-page-focus", panel: id }); onClose?.(); }}>{title}</MenuItem>;
    })}
  </MenuSection> : null;
  // With pages open, "Browser" in a shared menu returns to the focused page instead of a start page.
  const browserTarget = onPick ? "browser" : browserRevealTarget(layout, scope.session);
  const common = groups.some(group => group.id === "common");
  return <>{groups.map(group => {
    const label = copy(group.label[0], group.label[1]);
    return <div className="dock-tool-group" key={group.id} data-tint={group.tint} role="group" aria-label={label}>
      <div className="dock-tool-group-label" aria-hidden="true">
        <span className="dock-tool-group-ic"><Icon name={group.icon} extra="sm" /></span>
        <span className="dock-tool-group-name">{label}</span>
        <span className="dock-tool-group-count">{group.panels.length}</span>
      </div>
      {group.panels.map(id => {
        const panel = byId.get(id);
        if (!panel) return null;
        const target = panel.id === "browser" ? browserTarget : panel.id;
        const location = locationDescription(layout, target, copy);
        return <MenuItem key={panel.id} icon={panel.icon} hint={location} title={`${panel.menuTitle ?? panel.title} · ${location}`} onClick={() => {
          // Callers that own a target group add the tool there; the shared menus keep
          // restoring the panel to its remembered slot.
          if (onPick) onPick(panel.id);
          else store.dispatch({ type: "open", panel: target });
          onClose?.();
        }}>{panel.menuTitle ?? panel.title}</MenuItem>;
      })}
      {group.id === "common" ? <>{pageSection}{agentSection}</> : null}
    </div>;
  })}
    {common ? null : <>{pageSection}{agentSection}</>}
  </>;
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
  const { marks } = usePreviewMode();
  const copy = useDockCopy();
  const [saving, setSaving] = useState(false);
  const current = presets.find(preset => preset.id === layout.presetId);
  const group = groupAt(layout, groupId);
  const run = (action: DockAction) => { store.dispatch(action); onClose?.(); };
  return <div className="dock-menu-content" data-dock-menu="view">
    <div className="menu-label dock-menu-heading">{copy("工作台布局", "Workbench layout")}{preview && marks ? <span className="chip amber xs demo-chip">{copy("演示", "Demo")}</span> : null}</div>
    <div className="menu-label">{copy("区域", "Regions")}</div>
    {(["left", "right", "bottom", "rail"] as const).map(region => {
      const state = regionState?.[region];
      const shown = state ? state.presented : region === "rail" ? layout.rail.mode !== "hidden" : layout[region].visible;
      const nextVisible = state ? !state.presented : region === "rail" ? layout.rail.mode === "hidden" : !layout[region].visible;
      return <MenuToggle key={region} icon={({ left: "layout", right: "panel", bottom: "panel-bottom", rail: "layers" } as const)[region]} label={regionName(region, copy)} checked={shown} kbd={region === "left" ? formatShortcut({ key: "B" }) : region === "bottom" ? formatShortcut({ key: "J" }) : region === "rail" ? formatShortcut({ key: "L", shift: true }) : undefined} onClick={() => run({ type: "region", region, visible: nextVisible })} />;
    })}
    <div className="menu-sep" />
    <MenuSection label={copy("工具", "Tools")} icon="wrench"><DockToolItems onClose={onClose} /></MenuSection>
    {group ? <MenuSection label={copy("当前组", "Current group")} icon="layers"><DockPanelMenu panels={group.panels} groupId={group.id} onClose={onClose} /></MenuSection> : <MenuItem icon="layers" disabled title={copy("使用卡片菜单，或右键标签与浮窗标题栏选择操作目标。", "Use a card menu, or right-click a tab or floating title bar to select a target.")}>{copy("当前组（未选择）", "Current group (none selected)")}</MenuItem>}
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

type PanelMenuProps = { panels: PanelId[]; groupId?: string | undefined; onClose?: (() => void) | undefined };

/** Actions are shared by cards, tabs and the tab menu's group subsection. */
export function DockPanelMenu({ panels, groupId, onClose, groupActions = false }: PanelMenuProps & { groupActions?: boolean }) {
  const { layout } = useDock();
  const copy = useDockCopy();
  const group = groupActions && panels[0] ? groupAt(layout, locatePanel(layout, panels[0])?.groupId) : undefined;
  return <div className="dock-menu-content" data-dock-menu="panel">
    <DockPanelActions panels={panels} groupId={groupId} onClose={onClose} />
    {group && <MenuSection label={copy("标签组", "Tab group")} icon="layers"><DockPanelActions panels={group.panels} groupId={group.id} onClose={onClose} /></MenuSection>}
  </div>;
}

function DockPanelActions({ panels, groupId, onClose }: PanelMenuProps) {
  const { layout, preferences, store, definitions } = useDock();
  const copy = useDockCopy();
  const first = panels[0];
  const source = first ? locatePanel(layout, first) : undefined;
  const group = groupAt(layout, groupId ?? source?.groupId);
  const wholeGroup = !!groupId && !!group && group.panels.length === panels.length && group.panels.every(panel => panels.includes(panel));
  const locked = preferences.locked;
  const lockReason = copy("布局已锁定；先解锁以移动、分组或调整尺寸。", "Layout locked; unlock to move, group or resize tools.");
  const run = (action: DockAction) => { store.dispatch(action); onClose?.(); };
  const move = (target: DockLocation & { split?: "before" | "after" }, selected = panels) => run({ type: "move", panels: selected, target: { ...target, ...(store.documentId ? { ownerId: store.documentId } : {}) } });
  const siblings = source?.region === "left" || source?.region === "rail" ? layout[source.region].panels : group?.panels ?? [];
  const position = first ? siblings.indexOf(first) : -1;
  const splitPanels = wholeGroup && group ? [group.active] : panels;
  const title = wholeGroup ? copy("整组操作", "Group actions") : definitions.find(panel => panel.id === first)?.title ?? copy("工具操作", "Tool actions");
  return <>
    <div className="menu-label">{title}</div>
    {/* The group menu is also the right region's add/hide entry. */}
    {wholeGroup ? <MenuSection label={copy("添加工具", "Add tool")} icon="plus"><DockToolItems onClose={onClose} /></MenuSection> : null}
    <MenuSection label={wholeGroup ? copy("整组移动到", "Move group to") : copy("移动到", "Move to")} icon="handoff">
      {(["left", "rail", "right", "bottom"] as const).filter(region => region !== "rail" || !panels.some(panel => definitions.find(definition => definition.id === panel)?.content)).map(region => {
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
      <MenuItem icon={layout.cards[first]!.collapsed ? "chevron-d" : "chevron-u"} onClick={() => run({ type: "card", panel: first, collapsed: !layout.cards[first]!.collapsed })}>{layout.cards[first]!.collapsed ? copy("展开卡片", "Expand card") : copy("折叠卡片", "Collapse card")}</MenuItem>
      <MenuItem icon="restore" disabled={locked || layout.cards[first]!.height === null} title={locked ? lockReason : undefined} onClick={() => run({ type: "card", panel: first, height: null })}>{copy("恢复自动高度", "Restore automatic height")}</MenuItem>
    </> : null}
    <div className="menu-sep" />
    {panels.some(panel => definitions.find(definition => definition.id === panel)?.content) ? <MenuItem icon="x" onClick={() => { closePanels(store, definitions, panels); onClose?.(); }}>{wholeGroup ? copy("关闭标签组", "Close tab group") : copy("关闭对话视图", "Close conversation view")}</MenuItem> : panels.some(isFilePanelId)
      ? <MenuItem icon="x" onClick={() => { closePanels(store, definitions, panels); onClose?.(); }}>{wholeGroup ? copy("关闭标签组", "Close tab group") : copy("关闭文件", "Close file")}</MenuItem>
      : panels.some(isBrowserPagePanelId)
      ? <MenuItem icon="x" onClick={() => { closePanels(store, definitions, panels); onClose?.(); }}>{wholeGroup ? panels.every(isBrowserPagePanelId) ? copy("关闭整组网页", "Close all pages in group") : copy("关闭网页并隐藏其余工具", "Close pages and hide other tools") : copy("关闭网页", "Close page")}</MenuItem>
      : <MenuItem icon="eye-off" disabled={panels.length === 0} onClick={() => run({ type: "hide", panels })}>{wholeGroup ? copy("隐藏整组", "Hide group") : copy("隐藏工具", "Hide tool")}</MenuItem>}
    {wholeGroup && source?.region === "right" ? <MenuItem icon="x" onClick={() => run({ type: "region", region: "right", visible: false })}>{copy("隐藏右侧栏", "Hide right sidebar")}</MenuItem> : null}
  </>;
}

function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
  const document = event.currentTarget.ownerDocument;
  if (event.defaultPrevented || (event.target as Element).matches("input, textarea")) return;
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
  event.preventDefault();
  event.stopPropagation();
  items[next]?.focus();
}

type PopupAnchor = { element: HTMLElement; fallback: HTMLElement | null; point?: { x: number; y: number } | undefined };

export function useDockPopup(label: string, role: "menu" | "dialog" = "menu", popupClassName = "", focusOnOpen = true) {
  const document = useSurfaceDocument(), window = surfaceWindow(document);
  const windows = useWindowFocus();
  const [anchor, setAnchor] = useState<PopupAnchor | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const openAt = (element: HTMLElement, point?: { x: number; y: number }) => setAnchor({ element, point, fallback: element.closest('[data-dock-focus-region]') });
  const close = () => {
    const activeWindow = windows?.getSnapshot().activeId;
    setAnchor(null);
    // A move/hide can remove the trigger (including a two-tab float's entire strip).
    requestAnimationFrame(() => {
      if (windows && windows.getSnapshot().activeId !== activeWindow) return;
      const target = [anchor?.element, anchor?.fallback].find(element => element?.isConnected && !element.closest('[hidden], [inert]'));
      target?.focus({ preventScroll: true });
    });
  };
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.element.getBoundingClientRect();
      const menu = popup.current;
      if (!menu) return;
      const left = anchor.point?.x ?? rect.right - menu.offsetWidth;
      const top = anchor.point?.y ?? rect.bottom + 4;
      setPosition({ left: Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8)), top: Math.max(8, Math.min(top, window.innerHeight - menu.offsetHeight - 8)) });
    };
    place();
    if (focusOnOpen) popup.current?.querySelector<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (popup.current) resize?.observe(popup.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { resize?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!anchor.element.contains(target) && !popup.current?.contains(target)) setAnchor(null);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside); };
  }, [anchor]);
  return {
    open: !!anchor, id, openAt, dismiss: () => setAnchor(null),
    render: (children: (close: () => void) => ReactNode) => anchor ? createPortal(<div ref={popup} id={id} className={`menu dock-menu-popover${popupClassName ? ` ${popupClassName}` : ""}`} role={role} aria-label={label} data-dock-menu="popup" style={position}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={event => {
        if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); } else menuKeys(event);
      }}>{children(close)}</div>, document.body) : null,
  };
}

/** One context popup per strip/window, not a listener and portal per tab. */
export function useDockContextMenu() {
  const copy = useDockCopy();
  const popup = useDockPopup(copy("停靠选项", "Dock options"));
  const [selection, setSelection] = useState<{ panels: PanelId[]; groupId?: string | undefined }>({ panels: [] });
  const open = (element: HTMLElement, panels: PanelId[], groupId?: string, point?: { x: number; y: number }) => {
    setSelection({ panels, groupId });
    const focus = element.matches('button, [tabindex]') ? element : element.querySelector<HTMLElement>('[role="tab"], button') ?? element;
    popup.openAt(focus, point);
  };
  return {
    onContextMenu: (event: MouseEvent<HTMLElement>, panels: PanelId[], groupId?: string) => {
      event.preventDefault(); event.stopPropagation();
      open(event.currentTarget, panels, groupId, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>, panels: PanelId[], groupId?: string) => {
      if (event.nativeEvent.isComposing || event.defaultPrevented || !(event.key === "ContextMenu" || event.key === "F10" && event.shiftKey)) return;
      event.preventDefault(); event.stopPropagation();
      open(event.currentTarget, panels, groupId);
    },
    menu: popup.render(close => <DockPanelMenu {...selection} groupActions={!selection.groupId} onClose={close} />),
  };
}

export function DockPopupButton({ label, icon, className, triggerContent, draggable = false, popupRole, popupClassName, onOpen, onOpenChange, children }: { label: string; icon: IconName; className?: string | undefined; triggerContent?: ReactNode; draggable?: boolean; popupRole?: "menu" | "dialog"; popupClassName?: string; onOpen?: () => void; onOpenChange?: (open: boolean) => void; children: (close: () => void) => ReactNode }) {
  const popup = useDockPopup(label, popupRole, popupClassName);
  useEffect(() => { onOpenChange?.(popup.open); }, [popup.open, onOpenChange]);
  return <>
    <button type="button" className={`${className ? `${className} dock-icon-button` : "icon-btn"} dock-menu-button${popup.open ? " open" : ""}`} data-window-drag={draggable ? "" : undefined} data-tip={label} aria-label={label} aria-haspopup={popupRole ?? "menu"} aria-expanded={popup.open} aria-controls={popup.open ? popup.id : undefined}
      onPointerDown={event => { if (!draggable) event.stopPropagation(); }} onClick={event => { event.stopPropagation(); if (popup.open) popup.dismiss(); else { onOpen?.(); popup.openAt(event.currentTarget); } }}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); onOpen?.(); popup.openAt(event.currentTarget); } }}>{triggerContent ?? <Icon name={icon} extra="sm" />}</button>
    {popup.render(children)}
  </>;
}

export function DockMenuButton({ panels, groupId }: { panels: PanelId[]; groupId?: string | undefined }) {
  const copy = useDockCopy();
  return <DockPopupButton label={copy("停靠选项", "Dock options")} icon="more">{close => <DockPanelMenu panels={panels} groupId={groupId} onClose={close} />}</DockPopupButton>;
}
export function DockPinButton({ group }: { group: DockFloat }) {
  const { store, scope } = useDock();
  const windows = useWindowFocus();
  return <WindowPinButton mode={group.pin?.mode ?? "none"} workspaceAvailable={scope.project !== null} onChange={mode => {
    store.setPin(group.id, mode);
    const next = store.getSnapshot().layout.floats.find(value => value.panels.includes(group.active));
    if (next) windows?.activate(`tool:${store.documentId ?? "standalone"}:${next.id}`, store.documentId ?? null);
  }} />;
}
export function WindowPinButton({ mode: selected, workspaceAvailable, onChange }: { mode: DockPinMode; workspaceAvailable: boolean; onChange: (mode: DockPinMode) => void }) {
  const { t } = useI18n();
  const native = selected === "window" || selected === "topmost";
  const choices: DockPinMode[] = ["none", "workspace", "application", "window", "topmost"];
  return <DockPopupButton className="dock-pin-button" label={t("dockPin.title")} icon="pin">{close => <>
    <div className="menu-label">{t("dockPin.title")}</div>
    {choices.map(mode => {
      const disabled = mode === "workspace" ? !workspaceAvailable : (mode === "window" || mode === "topmost") && !globalThis.ompStudioChrome?.prepareFloatWindow;
      const reason = disabled ? t(mode === "workspace" ? "dockPin.workspaceRequired" : "dockPin.desktopRequired") : undefined;
      return <button key={mode} type="button" className="menu-item" role="menuitemradio" aria-checked={selected === mode} disabled={disabled} data-tip={reason}
        onClick={() => { close(); if (native && mode !== "window" && mode !== "topmost" && !revealMainWindow(mode === "none")) return; onChange(mode); }}>
        <span>{t(`dockPin.${mode}`)}</span><span className="dock-menu-check">{selected === mode && <Icon name="check" extra="sm" />}</span>
      </button>;
    })}
  </>}</DockPopupButton>;
}
/** `leading` puts the caller's own entries above the tools (the window tab bar's 新建对话). */
export function DockToolsButton({ className, label, onPick, exclude, leading }: { className?: string | undefined; label?: string | undefined; onPick?: ((panel: PanelId) => void) | undefined; exclude?: readonly PanelId[] | undefined; leading?: ((close: () => void) => ReactNode) | undefined }) {
  const copy = useDockCopy();
  return <DockPopupButton className={className} label={label ?? copy("添加工具", "Add tool")} icon="plus">{close => <div className="dock-menu-content"><div className="menu-label">{onPick ? copy("新建标签", "New tab") : copy("打开或找回工具", "Open or restore a tool")}</div>{leading?.(close)}<DockToolItems onClose={close} onPick={onPick} exclude={exclude} /></div>}</DockPopupButton>;
}
