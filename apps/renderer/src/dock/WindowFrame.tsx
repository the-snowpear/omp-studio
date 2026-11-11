import { useWindowOrder } from "./windowOrder";
import { useRef, type HTMLAttributes, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Icon, type IconName } from "../icons";
import { useI18n } from "../i18n";
import { beginDockResize } from "./gestures";
import type { DockRect } from "./types";
import type { WindowTint } from "./windowTint";
import "./dock.css";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** The same window chrome and eight resize handles host tools and conversations. */
export function WindowFrame({ title, icon, tint = "violet", titleContent, titleExtra, controls, maximizeButton, children, tabs, menu, rect, bounds, minWidth = 320, minHeight = 200, maximized = false, nativeKey, locked = false, order = 0, windowId, visible = true, preview = false, resizable = true, frameRef, frameProps, onTitleDrag, onTitleContextMenu, onTitleKeyDown, onRectChange, onMeasure, onControl, onClose, closeLabel }: {
  title: string; icon: IconName; titleContent?: ReactNode; titleExtra?: ReactNode; controls?: ReactNode; children: ReactNode; tabs?: ReactNode; menu?: ReactNode;
  tint?: WindowTint;
  rect: DockRect; bounds: DockRect; minWidth?: number; minHeight?: number; maximized?: boolean; nativeKey?: string | undefined; locked?: boolean; order?: number;
  windowId?: string; visible?: boolean;
  preview?: boolean; resizable?: boolean; maximizeButton?: ReactNode;
  frameRef?: RefObject<HTMLDivElement | null>; frameProps?: HTMLAttributes<HTMLDivElement>;
  onTitleDrag?: (event: PointerEvent<HTMLElement>) => void;
  onTitleContextMenu?: HTMLAttributes<HTMLElement>["onContextMenu"]; onTitleKeyDown?: HTMLAttributes<HTMLElement>["onKeyDown"];
  onRectChange: (rect: DockRect) => void; onMeasure?: () => void;
  onControl: (action: "minimize" | "maximize") => void; onClose: () => void; closeLabel?: string;
}) {
  const stacking = useWindowOrder(order, { id: windowId, visible: visible && !preview });
  const ownRef = useRef<HTMLDivElement>(null), frame = frameRef ?? ownRef;
  const { resolvedLanguage } = useI18n();
  const text = (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
  const resize = (event: PointerEvent<HTMLElement>, direction: string) => {
    const element = frame.current;
    if (!element || locked || maximized) return;
    let next = rect;
    const previous = { left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height };
    const minW = Math.min(minWidth, bounds.width), minH = Math.min(minHeight, bounds.height);
    beginDockResize(event, (dx, dy) => {
      const left = direction.includes("w") ? clamp(rect.x + dx, 0, rect.x + rect.width - minW) : rect.x;
      const top = direction.includes("n") ? clamp(rect.y + dy, 0, rect.y + rect.height - minH) : rect.y;
      const right = direction.includes("e") ? clamp(rect.x + rect.width + dx, rect.x + minW, bounds.width) : rect.x + rect.width;
      const bottom = direction.includes("s") ? clamp(rect.y + rect.height + dy, rect.y + minH, bounds.height) : rect.y + rect.height;
      next = { x: left, y: top, width: right - left, height: bottom - top };
      Object.assign(element.style, { left: `${bounds.x + next.x}px`, top: `${bounds.y + next.y}px`, width: `${next.width}px`, height: `${next.height}px` });
      onMeasure?.();
    }, () => onRectChange(next), () => { Object.assign(element.style, previous); onMeasure?.(); });
  };
  return <div {...frameProps} ref={frame} tabIndex={-1} role={frameProps?.role ?? "region"} aria-label={frameProps?.["aria-label"] ?? text(`${title} 浮窗`, `${title} floating window`)}
    className={`dock-float${nativeKey ? " dock-native-float" : ""}${maximized ? " is-maximized" : ""}${stacking.active ? " is-active-window" : ""}${frameProps?.className ? ` ${frameProps.className}` : ""}`}
    data-dock-order={stacking.index} data-dock-window={stacking.id} data-window-tint={tint}
    onPointerDownCapture={event => { frameProps?.onPointerDownCapture?.(event); if (!preview) stacking.raise(); }}
    onFocusCapture={event => { frameProps?.onFocusCapture?.(event); if (!preview) stacking.raise(); }}
    style={{ left: bounds.x + rect.x, top: bounds.y + rect.y, width: rect.width, height: rect.height, zIndex: 31 + stacking.index * 2, ...frameProps?.style }}>
    <header className="dock-float-titlebar" tabIndex={0} onPointerDown={onTitleDrag} onContextMenu={onTitleContextMenu} onKeyDown={onTitleKeyDown}
      onDoubleClick={event => { if (!(event.target as Element).closest("button:not([data-window-drag])")) onControl("maximize"); }}>
      <span className="dock-float-title">{titleContent ?? <><i className="dock-window-mark" aria-hidden="true"><Icon name={icon} extra="sm" /></i><span>{title}</span></>}{titleExtra}</span>
      {controls}
      <button type="button" className="dock-icon-button" aria-label={text("最小化浮窗", "Minimize window")} data-tip={text("最小化", "Minimize")} onClick={() => onControl("minimize")}><Icon name="minimize" extra="sm" /></button>
      {maximizeButton ?? <button type="button" className="dock-icon-button" aria-label={maximized ? text("还原浮窗", "Restore window") : text("最大化浮窗", "Maximize window")} data-tip={maximized ? text("还原", "Restore") : text("最大化", "Maximize")} onClick={() => onControl("maximize")}><Icon name={maximized ? "restore" : "maximize"} extra="sm" /></button>}
      <button type="button" className="dock-icon-button" aria-label={closeLabel ?? text("隐藏整个浮窗", "Hide window group")} data-tip={closeLabel ?? text("隐藏整组", "Hide group")} onClick={onClose}><Icon name="x" extra="sm" /></button>
    </header>
    {tabs}{children}{menu}
    {!nativeKey && !maximized && !locked && !preview && resizable && ["n", "e", "s", "w", "ne", "se", "sw", "nw"].map(direction => <div key={direction} className={`dock-float-resizer dock-float-resizer-${direction}`} onPointerDown={event => resize(event, direction)} aria-hidden="true" />)}
  </div>;
}
