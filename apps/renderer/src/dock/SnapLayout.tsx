import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { useDockPopup } from "./DockMenus";
import { beginDockResize } from "./gestures";
import type { DockRect as Rect } from "./types";
import { snapTree, resizeSnapTree, snapCells, snapCellCount, snapDividers, SNAP_TEMPLATES, WINDOW_MINIMUM, type WindowSnapLayout, type SnapNode, type SnapTemplate } from "./snap";
import { focusWindowId, type WorkbenchWindow, type WorkbenchWindows } from "./windows";

const TEMPLATE_NAMES: Record<SnapTemplate, [string, string]> = {
  halves: ["左右各半", "Two equal columns"],
  "wide-left": ["左右 2:1", "Wide left column"],
  columns: ["三列", "Three columns"],
  "stack-left": ["左侧上下与右半", "Two stacked left and right"],
  "stack-right": ["左半与右侧上下", "Left and two stacked right"],
  quarters: ["四宫格", "Four quarters"],
};

export function WindowSnapButton({ manager, window: view, locked, onMaximize }: { manager: WorkbenchWindows; window: WorkbenchWindow; locked: boolean; onMaximize: () => void }) {
  const { resolvedLanguage } = useI18n();
  const text = (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
  const [keyboard, setKeyboard] = useState(false);
  const popup = useDockPopup(text("窗口吸附布局", "Window snap layouts"), "dialog", "cw-snap-picker", keyboard);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef(popup); current.current = popup;
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const fits = (template: SnapTemplate, cell: number) => {
    const candidate = manager.project(view.id, { template, cell });
    const size = manager.size(candidate.snap);
    return size.width <= manager.geometry.canvas.width && size.height <= manager.geometry.canvas.height;
  };
  const available = locked ? [] : SNAP_TEMPLATES.filter(template => Array.from({ length: snapCellCount(template) }, (_, cell) => cell).some(cell => fits(template, cell)));
  const leave = () => { clear(); if (popup.open && !keyboard) timer.current = setTimeout(() => current.current.dismiss(), 180); };
  const label = view.maximized ? text("还原浮窗", "Restore window") : text("最大化浮窗", "Maximize window");
  return <>
    <button type="button" className={`dock-icon-button cw-snap-button${popup.open ? " open" : ""}`} aria-label={label} aria-haspopup="dialog" aria-expanded={popup.open} aria-controls={popup.open ? popup.id : undefined} data-tip={label}
      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); clear(); popup.dismiss(); onMaximize(); }}
      onMouseEnter={event => {
        clear();
        if (!available.length) return;
        const button = event.currentTarget;
        timer.current = setTimeout(() => { setKeyboard(false); current.current.openAt(button); }, 300);
      }} onMouseLeave={leave}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.defaultPrevented || !event.key.startsWith("Arrow") || !available.length) return;
        event.preventDefault(); event.stopPropagation(); clear(); setKeyboard(true); popup.openAt(event.currentTarget);
      }}><Icon name={view.maximized ? "restore" : "maximize"} extra="sm" /></button>
    {popup.render(close => <div onMouseEnter={clear} onMouseLeave={leave} data-conversation-owner={view.content.documentId}>
      <div className="menu-label">{text("选择布局和位置", "Choose a layout and position")}</div>
      <div className="cw-snap-templates" role="menu" aria-label={text("吸附位置", "Snap positions")}>{available.map(template => {
        const name = TEMPLATE_NAMES[template][resolvedLanguage === "zh" ? 0 : 1];
        const cells = snapCells(template, snapTree(template), { width: 108, height: 72 });
        return <div className="cw-snap-template" role="group" aria-label={name} key={template}>
          <div className="cw-snap-template-cells">{cells.map((cell, index) => <button type="button" role="menuitem" className="cw-snap-cell" key={index} disabled={!fits(template, index)}
            aria-label={text(`${name} · 位置 ${index + 1}`, `${name} · Position ${index + 1}`)} style={{ left: cell.x, top: cell.y, width: cell.width, height: cell.height }}
            onClick={() => { close(); manager.snap(view.id, { template, cell: index }); }} />)}</div>
          <span>{name}</span>
        </div>;
      })}</div>
    </div>)}
  </>;
}

function paintSnap(manager: WorkbenchWindows, surface: HTMLElement, layout: WindowSnapLayout, tree: SnapNode, size: Pick<Rect, "width" | "height">, onMeasure: () => void) {
  const cells = snapCells(layout.template, tree, size);
  for (const [index, id] of Object.entries(layout.members)) {
    const record = manager.get(id);
    const frame = record ? surface.querySelector<HTMLElement>(`[data-dock-window="${focusWindowId(record)}"]`) : null, rect = cells[Number(index)]!;
    if (frame) Object.assign(frame.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  for (const divider of snapDividers(layout.template, tree, size)) {
    const node = surface.querySelector<HTMLElement>(`[data-snap-divider="${divider.path}"]`);
    if (node) Object.assign(node.style, { left: `${divider.rect.x}px`, top: `${divider.rect.y}px`, width: `${divider.rect.width}px`, height: `${divider.rect.height}px` });
  }
  const assist = surface.querySelector<HTMLElement>("[data-snap-assist-cell]");
  if (assist) {
    const rect = cells[Number(assist.dataset.snapAssistCell)]!;
    Object.assign(assist.style, { left: `${rect.x + 10}px`, top: `${rect.y + 10}px`, width: `${rect.width - 20}px`, height: `${rect.height - 20}px` });
  }
  onMeasure();
}

export function SnapDividers({ manager, layout, size, locked, onMeasure }: { manager: WorkbenchWindows; layout: WindowSnapLayout; size: Pick<Rect, "width" | "height">; locked: boolean; onMeasure: () => void }) {
  const { resolvedLanguage } = useI18n();
  const order = useSyncExternalStore(manager.focus.subscribe, manager.focus.getSnapshot).order;
  const zIndex = Math.max(31, ...Object.values(layout.members).map(id => { const record = manager.get(id); return 32 + Math.max(0, order.indexOf(record ? focusWindowId(record) : id)) * 2; }));
  const text = (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
  return <>{snapDividers(layout.template, layout.tree, size).map(divider => {
    const ratio = divider.ratio;
    const minimum = divider.axis === "column" ? WINDOW_MINIMUM.width / divider.area.width : WINDOW_MINIMUM.height / divider.area.height;
    const resize = (value: number) => resizeSnapTree(layout.tree, divider, value, manager.minimums(layout));
    return <div className={`cw-snap-divider cw-snap-divider-${divider.axis}`} key={divider.path} data-snap-divider={divider.path}
      role="separator" tabIndex={locked ? -1 : 0} aria-disabled={locked} aria-label={text("调整窗口分区", "Resize window partitions")} aria-orientation={divider.axis === "column" ? "vertical" : "horizontal"}
      aria-valuemin={Math.ceil(minimum * 100)} aria-valuemax={Math.floor((1 - minimum) * 100)} aria-valuenow={Math.round(ratio * 100)} style={{ left: divider.rect.x, top: divider.rect.y, width: divider.rect.width, height: divider.rect.height, zIndex }}
      onPointerDown={event => {
        if (locked) return;
        const surface = event.currentTarget.closest<HTMLElement>(".cw-snap-surface")!;
        let next = layout.tree;
        beginDockResize(event, (dx, dy) => {
          next = resize(ratio + (divider.axis === "column" ? dx / divider.area.width : dy / divider.area.height));
          paintSnap(manager, surface, layout, next, size, onMeasure);
        }, () => manager.resize(next), () => paintSnap(manager, surface, layout, layout.tree, size, onMeasure));
      }}
      onDoubleClick={() => { if (!locked) manager.resize(resize(snapDividers(layout.template, snapTree(layout.template), size).find(value => value.path === divider.path)?.ratio ?? 0.5)); }}
      onKeyDown={event => {
        if (locked || event.nativeEvent.isComposing || event.defaultPrevented) return;
        const negative = divider.axis === "column" ? "ArrowLeft" : "ArrowUp", positive = divider.axis === "column" ? "ArrowRight" : "ArrowDown";
        if (event.key !== negative && event.key !== positive && event.key !== "Home" && event.key !== "Enter") return;
        event.preventDefault(); event.stopPropagation();
        const value = event.key === "Home" || event.key === "Enter" ? (snapDividers(layout.template, snapTree(layout.template), size).find(value => value.path === divider.path)?.ratio ?? 0.5) : ratio + (event.key === positive ? 1 : -1) * (event.shiftKey ? 0.1 : 0.025);
        manager.resize(resize(value));
      }} />;
  })}</>;
}

export function SnapAssist({ manager, layout, cell, size }: { manager: WorkbenchWindows; layout: WindowSnapLayout; cell: number | null; size: Pick<Rect, "width" | "height"> }) {
  const { resolvedLanguage } = useI18n();
  const recent = manager.focus.recentIds();
  const candidates = manager.getSnapshot().records.filter(view => view.placement !== "native" && !Object.values(layout.members).includes(view.id)).sort((a, b) => {
    const index = (id: string) => { const position = recent.indexOf(id); return position < 0 ? recent.length : position; };
    return index(focusWindowId(a)) - index(focusWindowId(b));
  });
  if (cell === null || !candidates.length) return null;
  const rect = snapCells(layout.template, layout.tree, size)[cell]!;
  const text = (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); manager.dismissAssist(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".cw-snap-candidate")];
    const current = buttons.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[index]?.focus({ preventScroll: true });
  };
  return <section className="cw-snap-assist" role="region" aria-label={text("补齐窗口布局", "Fill window layout")} data-snap-assist-cell={cell}
    style={{ left: rect.x + 10, top: rect.y + 10, width: rect.width - 20, height: rect.height - 20 }} onKeyDown={keys}>
    <header><span>{text("选择窗口填入此处", "Choose a window for this position")}</span><button type="button" className="dock-icon-button" aria-label={text("关闭布局补齐", "Dismiss snap assist")} onClick={() => manager.dismissAssist()}><Icon name="x" extra="sm" /></button></header>
    <div className="cw-snap-candidates">{candidates.map(view => {
      return <button type="button" className="cw-snap-candidate" key={view.id} onClick={() => manager.snap(view.id, { template: layout.template, cell })}>
        <Icon name={view.content.kind === "conversation" ? "message" : "layout"} extra="sm" /><span><strong>{view.title}</strong><small>{view.placement === "main" ? text("主区", "Main area") : view.minimized ? text("已最小化", "Minimized") : ""}</small></span><Icon name="arrow-r" extra="sm" />
      </button>;
    })}</div>
  </section>;
}
