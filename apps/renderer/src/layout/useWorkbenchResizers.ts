import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDockEngine } from "../dock/DockContext";
import { beforeConversationLayoutChange } from "../conversation/conversationReflow";
import { CONVERSATION_MIN_WIDTH, panelSize, SIDE_PANEL_LIMITS } from "./workbenchLayout";
import { clampBottomHeight, BOTTOM_PANEL_MAX, BOTTOM_PANEL_MIN } from "../workbench/BottomPanelChrome";

function panelResizeBounds(handle: HTMLElement) {
  const root = handle.closest<HTMLElement>(".conversation-workspace, .adaptive-workbench") ?? handle.ownerDocument.documentElement;
  const area = handle.closest<HTMLElement>(".cw-workbench, #workbench") ?? root;
  const max = root.dataset.layoutOverlay === "side" ? Math.max(0, root.clientWidth - 24) : Math.max(SIDE_PANEL_LIMITS.min, area.clientWidth - CONVERSATION_MIN_WIDTH);
  const min = Math.min(SIDE_PANEL_LIMITS.min, max);
  handle.setAttribute("aria-valuemin", String(min));
  handle.setAttribute("aria-valuemax", String(max));
  return { root, area, min, max };
}

export function useWorkbenchResizers({ sideOpen, panelWidth, onResizePanel, bottomOpen, onBottomOpenChange, bottomHeight, onResizeBottom }: { sideOpen: boolean; panelWidth: number; onResizePanel(width: number): void; bottomOpen: boolean; onBottomOpenChange(open: boolean): void; bottomHeight: number; onResizeBottom(height: number): void }) {
  const dock = useDockEngine();
  const [bottomResizing, setBottomResizing] = useState(false);
  const panelResizerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const handle = panelResizerRef.current;
    if (!handle || !sideOpen) return;
    const { root, area } = panelResizeBounds(handle);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { panelResizeBounds(handle); });
    observer?.observe(root);
    if (area !== root) observer?.observe(area);
    return () => observer?.disconnect();
  }, [sideOpen, panelWidth]);
  // 右侧面板拖拽调宽：照左栏 sidebar-resizer 的模式，pointer capture 期间直接写
  // 元素宽度与 --panel-w（收起动画的 margin 偏移量依赖该变量），松手后提交 state。
  // 上限取当前工具区的可用宽度，给主对话保留最小阅读宽度。
  const onPanelResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dock.store.getSnapshot().preferences.locked) return;
    if (!sideOpen) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const document = handle.ownerDocument;
    document.getSelection()?.removeAllRanges();
    const panel = handle.closest(".side-panel");
    if (!(panel instanceof HTMLElement)) return;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const { root, min, max } = panelResizeBounds(handle);
    beforeConversationLayoutChange();
    handle.classList.add("dragging");
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    let latest = startWidth;
    const apply = (width: number) => {
      latest = width;
      root.style.setProperty("--panel-w", `${width}px`);
      handle.setAttribute("aria-valuenow", String(Math.round(width)));
    };
    const move = (next: PointerEvent) => {
      next.preventDefault();
      // 面板贴右缘：指针左移变宽、右移变窄。
      apply(Math.min(max, Math.max(min, startWidth - (next.clientX - startX))));
    };
    const up = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("is-resizing");
      document.body.style.cursor = "";
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onResizePanel(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const onPanelResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = event.currentTarget.closest(".side-panel")?.getBoundingClientRect().width ?? panelWidth;
    const { min, max } = panelResizeBounds(event.currentTarget);
    const step = event.shiftKey ? 32 : 16;
    const value = event.key === "ArrowLeft" ? current + step : event.key === "ArrowRight" ? current - step : event.key === "Home" ? min : event.key === "End" ? max : undefined;
    if (value === undefined) return;
    event.preventDefault();
    beforeConversationLayoutChange();
    onResizePanel(panelSize(value, { ...SIDE_PANEL_LIMITS, min, max }));
  };
  // 底栏拖拽调高：照右侧 sp-resizer。收起时拖动先展开；拖动期间关掉 height
  // 过渡（.resizing），否则每一步都在追光标。夹取 120–480，对齐 ver1。
  const onBottomResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dock.store.getSnapshot().preferences.locked) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const document = handle.ownerDocument;
    document.getSelection()?.removeAllRanges();
    const panel = handle.closest(".bottom-panel");
    if (!(panel instanceof HTMLElement)) return;
    if (!bottomOpen) onBottomOpenChange(true);
    setBottomResizing(true);
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const root = handle.closest<HTMLElement>(".conversation-workspace, .adaptive-workbench") ?? document.documentElement;
    beforeConversationLayoutChange();
    document.body.classList.add("is-resizing");
    document.body.style.cursor = "row-resize";
    let latest = startHeight;
    const apply = (height: number) => {
      latest = clampBottomHeight(height);
      panel.style.height = `${latest}px`;
      root.style.setProperty("--bottom-panel-h", `${latest}px`);
      handle.setAttribute("aria-valuenow", String(latest));
    };
    const move = (next: PointerEvent) => {
      next.preventDefault();
      apply(startHeight - (next.clientY - startY));
    };
    const up = () => {
      handle.classList.remove("dragging");
      panel.classList.remove("resizing");
      setBottomResizing(false);
      panel.style.height = "";
      document.body.classList.remove("is-resizing");
      document.body.style.cursor = "";
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onResizeBottom(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const onBottomResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 60 : 20;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onBottomOpenChange(true);
      onResizeBottom(clampBottomHeight(bottomHeight + step));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onResizeBottom(clampBottomHeight(bottomHeight - step));
    } else if (event.key === "Home") {
      event.preventDefault();
      onBottomOpenChange(true);
      onResizeBottom(BOTTOM_PANEL_MAX);
    } else if (event.key === "End") {
      event.preventDefault();
      onResizeBottom(BOTTOM_PANEL_MIN);
    }
  };
  return { bottomResizing, panelResizerRef, onPanelResizePointerDown, onPanelResizeKeyDown, onBottomResizePointerDown, onBottomResizeKeyDown };
}
