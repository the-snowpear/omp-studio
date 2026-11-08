import { isFilePanelId } from "./types";
import { WindowFrame } from "./WindowFrame";
import { MinimizedCapsule } from "./MinimizedCapsule";
import { WindowSnapButton } from "./SnapLayout";
import { snapCells } from "./snap";
import { floatTitle, workbenchBounds as readWorkbenchBounds } from "./workbenchGeometry";
import { useAllWindowed, useConversationDom, useConversationView, useConversationWorkspace } from "../conversationWorkspace/Context";
import {
  Fragment, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEventHandler, type PointerEvent as ReactPointerEvent,
  type ReactNode, type RefObject,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { translate, useI18n } from "../i18n";
import { PLATFORM } from "../platform";
import { transitionMs } from "../motionClock";
import { usePreviewMode } from "../preview/PreviewContext";
import { DockSlot, useDock, useDockEngine } from "./DockContext";
import { DockMenuButton, DockToolsButton, DockPinButton, useDockContextMenu } from "./DockMenus";
import { NativeFloat } from "./NativeFloat";
import { isNativeFloat } from "./pins";
import { useSurfaceDocument, surfaceWindow } from "./SurfaceContext";
import { ToastHost } from "../ToastHost";
import { DockMeterBadge, DockMeterRing, DockMeterSummary, usePanelMeter } from "./panelMeters";
import { beginDockDrag, beginDockResize } from "./gestures";
import { beforeConversationLayoutChange, afterConversationLayoutChange, CONVERSATION_LAYOUT_CHANGE } from "../conversation/conversationReflow";
import { clampFloat, locatePanel } from "./model";
import { dragPreview, sourceActive, useDragRegion, useDragSource, type DragSource } from "./dragPreview";
import { railTransitionClip } from "./railClip";
import { isAgentPanelId, isInstancePanelId, type DockAction, type DockFloat, type DockGroup, type DockRect, type PanelDefinition, type PanelId, type RailMode } from "./types";
import { PanelGlyph, closePanels, definitionFor, focusInstancePanel } from "./panelChrome";
import "./dock.css";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const POPUP = '[data-dock-menu], .menu, [role="menu"], [role="dialog"], dialog, .app-select-popup, [role="listbox"]';
const scopeKey = (scope: { target: string; project: string | null; session: string }, preview: boolean) => JSON.stringify([scope.target, scope.project, scope.session, preview]);
const minimumBody = (definition: PanelDefinition) => Math.max(definition.minHeight ?? 64, definition.id === "terminal" ? 240 : 0);
const initialBody = (definition: PanelDefinition) => Math.max(minimumBody(definition), definition.initialHeight ?? (definition.id === "browser" || definition.id === "computer" ? 320 : 280));
const usesNaturalHeight = (id: PanelId) => id !== "terminal" && id !== "browser" && id !== "computer" && id !== "agent-detail" && !isInstancePanelId(id);
function contextCardGeometry(host: HTMLElement) {
  const card = host.querySelector<HTMLElement>(".context-card");
  const rows = card?.querySelector<HTMLElement>(".context-card-rows");
  if (!card || !rows) return null;
  const pixels = (value: string) => Number.parseFloat(value) || 0;
  const css = getComputedStyle(card);
  let fixed = pixels(css.paddingTop) + pixels(css.paddingBottom);
  for (const child of [...card.children].filter(child => child !== rows)) {
    const style = getComputedStyle(child);
    fixed += child.getBoundingClientRect().height + pixels(style.marginTop) + pixels(style.marginBottom);
  }
  const content = [...rows.children].reduce((height, row) => {
    const style = getComputedStyle(row);
    return height + row.getBoundingClientRect().height + pixels(style.marginTop) + pixels(style.marginBottom);
  }, 0);
  return { minimum: Math.ceil(fixed), natural: Math.ceil(fixed + content) };
}
function useLabels() {
  const { resolvedLanguage } = useI18n();
  return (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
}
function visibleElement(element: HTMLElement) {
  return !!element.getClientRects().length && !element.closest('[hidden], [inert]') && getComputedStyle(element).visibility !== "hidden";
}
function reveal(element: HTMLElement | null) {
  element?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "instant" });
}

/** Auto cards have real content in another DOM branch. Read all intrinsic heights together,
 * then write placeholders together; never attach an observer to every individual card. */
function useAutomaticCardHeights(list: RefObject<HTMLDivElement | null>, panels: PanelId[], overlay = false) {
  const { document, window } = useConversationDom();
  const { hosts, definitions, layout } = useDock();
  const automatic = panels.filter(id => (overlay || !layout.cards[id]!.collapsed) && (layout.cards[id]!.height === null || id === "context") && usesNaturalHeight(id));
  const ids = automatic.map(id => `${id}:${layout.cards[id]!.height ?? "auto"}`).join(",");
  useLayoutEffect(() => {
    const root = list.current;
    if (!root || !automatic.length) return;
    let frame = 0;
    const observed = new Set<Element>();
    const entries = automatic.map(id => ({ id, host: hosts.get(id).element, definition: definitionFor(definitions, id) }));
    const measure = () => {
      frame = 0;
      if (document.body.classList.contains("dock-resizing") || document.body.classList.contains("dock-dragging")) return;
      const readings = entries.map(({ id, host, definition }) => {
        const slot = root.querySelector<HTMLElement>(`[data-dock-slot="${id}"]`);
        const children = [...host.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.hidden);
        for (const child of children) {
          if (!observed.has(child)) { observer?.observe(child); observed.add(child); }
        }
        const top = host.getBoundingClientRect().top;
        const context = id === "context" ? contextCardGeometry(host) : null;
        const natural = children.reduce((height, child) => Math.max(height, child.getBoundingClientRect().bottom - top, child.offsetTop + child.scrollHeight), 0);
        return { slot, height: context
          ? clamp(layout.cards[id]!.height ?? context.natural, Math.max(minimumBody(definition), context.minimum), context.natural)
          : clamp(Math.ceil(natural || minimumBody(definition)), minimumBody(definition), initialBody(definition)) };
      });
      for (const { slot, height } of readings) {
        if (slot && slot.style.height !== `${height}px`) slot.style.height = `${height}px`;
      }
      hosts.schedule();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    for (const { id, host } of entries) {
      if (layout.cards[id]!.height === null) host.dataset.dockAutoHeight = "true";
      observer?.observe(host);
      mutations.observe(host, { subtree: true, childList: true, characterData: true });
    }
    const syncAfterLayout = () => {
      if (document.documentElement.hasAttribute("data-dock-rail-transition")) measure();
    };
    window.addEventListener(CONVERSATION_LAYOUT_CHANGE, syncAfterLayout);
    schedule();
    return () => {
      window.removeEventListener(CONVERSATION_LAYOUT_CHANGE, syncAfterLayout);
      cancelAnimationFrame(frame); observer?.disconnect(); mutations.disconnect();
      for (const { id, host } of entries) { hosts.rememberScroll(id); delete host.dataset.dockAutoHeight; }
    };
  }, [hosts, definitions, ids, list]);
}

function useDockDrag() {
  const { store, hosts, definitions } = useDockEngine();
  return (event: ReactPointerEvent<HTMLElement>, panels: PanelId[], floatingId?: string) => {
    const doc = event.currentTarget.ownerDocument;
    const content = panels.length === 1 ? definitions.find(definition => definition.id === panels[0])?.content : undefined;
    if (doc === document && content) { content.drag(event); return; }
    if (doc === document) { beginDockDrag(event, store, panels, floatingId, hosts, definitions); return; }
    // Native windows only reorder their own tabs; returning to the app is explicit.
    const groupId = event.currentTarget.closest<HTMLElement>("[data-dock-float]")?.dataset.dockFloat;
    if (!groupId || preferencesLocked(store) || event.button !== 0) return;
    const start = event.clientX;
    const release = (up: PointerEvent) => {
      if (Math.abs(up.clientX - start) < 4) return;
      const tab = (up.target as Element).closest<HTMLElement>("[data-dock-tab]");
      const group = store.getSnapshot().layout.floats.find(item => item.id === groupId);
      if (tab && group) { const index = group.panels.indexOf(tab.dataset.dockTab as PanelId); if (index >= 0) store.dispatch({ type: "move", panels, target: { region: "float", groupId, index: index + (up.clientX > start ? 1 : 0) } }); }
    };
    doc.addEventListener("pointerup", release, { once: true });
  };
}
const preferencesLocked = (store: ReturnType<typeof useDockEngine>["store"]) => store.getSnapshot().preferences.locked;

/** Move the surrounding cards into their projected slots without saving a drag. */
function useCardReorder(list: RefObject<HTMLDivElement | null>, panels: PanelId[], sizes = "") {
  const { hosts } = useDockEngine();
  const source = useDragSource(hosts);
  const destination = useDragRegion(hosts);
  const previous = useRef<{ source: DragSource | null; positions: Map<PanelId, number> }>({ source: null, positions: new Map() });
  const animations = useRef(new Map<HTMLElement, Animation>());
  const frame = useRef(0);
  const ids = panels.join(",");
  useLayoutEffect(() => {
    const root = list.current;
    if (!root?.isConnected) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      for (const animation of animations.current.values()) animation.cancel();
      animations.current.clear();
      previous.current = { source: null, positions: new Map() };
      return;
    }
    const nodes = [...root.querySelectorAll<HTMLElement>(":scope > [data-dock-card]")];
    const readings = nodes.map(node => {
      const transform = getComputedStyle(node).transform;
      const offset = transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
      return { node, id: node.dataset.dockCard as PanelId, offset, top: node.getBoundingClientRect().top - offset + root.scrollTop };
    });
    const starting = source && source !== previous.current.source;
    const before = starting
      ? new Map(Object.entries(source.cards).map(([id, rect]) => [id as PanelId, rect!.y + root.scrollTop]))
      : previous.current.positions;
    const animate = !!source || !!previous.current.source;
    for (const animation of animations.current.values()) animation.cancel();
    animations.current.clear();
    const duration = transitionMs(root);
    if (animate && duration > 1) {
      for (const { node, id, offset, top } of readings) {
        const delta = (before.get(id) ?? top) + (starting ? 0 : offset) - top;
        if (Math.abs(delta) < 0.5 || source?.panels.includes(id) || typeof node.animate !== "function") continue;
        const animation = node.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration, easing: getComputedStyle(root).transitionTimingFunction });
        animations.current.set(node, animation);
        animation.onfinish = () => { if (animations.current.get(node) === animation) animations.current.delete(node); };
      }
    }
    previous.current = { source, positions: new Map(readings.map(({ id, top }) => [id, top])) };
    cancelAnimationFrame(frame.current);
    const follow = () => {
      hosts.flush();
      frame.current = animations.current.size ? requestAnimationFrame(follow) : 0;
    };
    follow();
  }, [hosts, ids, sizes, source, destination, list]);
  useLayoutEffect(() => () => {
    cancelAnimationFrame(frame.current);
    for (const animation of animations.current.values()) animation.cancel();
  }, []);
}

/** 手动拉伸时卡片底边最远停在工具区的可见底边。对话工具区是贴在对话列里的浮层、
 *  左栏工具区段也有固定高度；卡片长过它，底边和拖拽柄就落进裁剪区外，只能靠滚动
 *  找回来。返回的是正文（slot）还能长到的高度。 */
function resizeCeiling(card: HTMLElement, region: "left" | "rail"): number {
  const rack = card.closest<HTMLElement>(region === "rail" ? ".dock-rail-expanded" : ".dock-left-cards");
  const boundary = rack?.getBoundingClientRect().bottom;
  if (boundary === undefined) return window.innerHeight * 2;
  const rect = card.getBoundingClientRect();
  const slotHeight = card.querySelector<HTMLElement>(".dock-slot")?.getBoundingClientRect().height ?? 0;
  // 标题栏、拖拽条和边框不随正文变化，先从可用空间里扣掉。
  return Math.max(0, Math.floor(boundary - rect.top - (rect.height - slotHeight)));
}

function DockCard({ id, region }: { id: PanelId; region: "left" | "rail" }) {
  const { document, window } = useConversationDom();
  const drag = useDockDrag();
  const contextMenu = useDockContextMenu();
  const meter = usePanelMeter(id);
  const { store, definitions, layout, preferences } = useDock();
  const text = useLabels();
  const card = useRef<HTMLElement>(null);
  const toolbar = useRef<HTMLSpanElement>(null);
  const { hosts } = useDockEngine();
  const source = useDragSource(hosts);
  const destination = useDragRegion(hosts);
  useLayoutEffect(() => region === "left" ? hosts.toolbar(id, toolbar.current!) : undefined, [hosts, id, region]);
  const definition = definitionFor(definitions, id);
  const preference = layout.cards[id]!;
  const summary = preference.collapsed && definition.meter && (region === "rail" || meter?.kind === "status");
  const bodyId = useId();
  const transition = useRailTransition();
  const toggle = () => {
    focusInstancePanel(store, id);
    if (region === "rail") transition(() => ({ type: "card", panel: id, collapsed: !store.getSnapshot().layout.cards[id]!.collapsed }), "collapse");
    else store.dispatch({ type: "card", panel: id, collapsed: !preference.collapsed });
  };
  const resizeMinimum = () => {
    return Math.max(minimumBody(definition), id === "context" ? contextCardGeometry(hosts.get(id).element)?.minimum ?? 0 : 0);
  };
  const resize = (event: ReactPointerEvent<HTMLElement>) => {
    if (preferences.locked) return;
    const slot = card.current?.querySelector<HTMLElement>(".dock-slot");
    if (!slot) return;
    const previous = slot.style.height;
    const start = slot.getBoundingClientRect().height;
    const minimum = resizeMinimum();
    const ceiling = card.current ? resizeCeiling(card.current, region) : window.innerHeight * 2;
    // 已经超过可见底边的旧高度不再自动跳变：先允许顺手缩小，只在增长方向受工具区限制。
    const natural = id === "context" ? contextCardGeometry(hosts.get(id).element)?.natural : undefined;
    const maximum = natural === undefined ? Math.max(minimum, start, Math.min(window.innerHeight * 2, ceiling)) : Math.max(minimum, Math.min(natural, ceiling));
    let height = start;
    beginDockResize(event, (_dx, dy) => {
      height = Math.round(clamp(start + dy, minimum, maximum));
      slot.style.height = `${height}px`;
    }, () => store.dispatch({ type: "card", panel: id, height }), () => { slot.style.height = previous; });
  };
  return <section className={`dock-card${preference.collapsed ? " is-collapsed" : ""}${summary ? " has-meter-summary" : ""}${source?.panels.includes(id) ? ` dock-drag-source${destination !== region ? " is-drag-away" : ""}` : ""}`} data-dock-card={id} ref={card}
    style={region === "rail" && !isInstancePanelId(id) ? { viewTransitionName: `dock-rail-${id}` } : undefined}>
    <header className="dock-card-header" onPointerDown={event => drag(event, [id])}
      onContextMenu={region === "rail" ? event => contextMenu.onContextMenu(event, [id]) : undefined}
      onKeyDown={region === "rail" ? event => contextMenu.onKeyDown(event, [id]) : undefined}
      onClick={event => { if (!(event.target as Element).closest("button")) toggle(); }}>
      <button type="button" className="dock-card-title" data-dock-drag="" aria-expanded={!preference.collapsed} aria-controls={bodyId}
        aria-label={summary && meter ? `${definition.title} · ${meter.label}` : definition.title} aria-keyshortcuts={region === "rail" ? "Shift+F10" : undefined}
        onClick={toggle} data-tip={summary ? meter?.detail ?? definition.title : definition.detail ?? definition.title}>
        {region === "rail" ? <>
          <PanelGlyph definition={definition} /><span>{definition.title}</span>
          <Icon name={preference.collapsed ? "chevron-r" : "chevron-d"} extra="sm dock-card-chevron" />
          {summary && <DockMeterSummary meter={meter} />}
        </> : <>
          <Icon name={preference.collapsed ? "chevron-r" : "chevron-d"} extra="sm" />
          <PanelGlyph definition={definition} /><span>{definition.title}</span>
          {summary && <DockMeterSummary meter={meter} />}
        </>}
      </button>
      {region === "left" && <span className="dock-card-actions" ref={toolbar} />}
      {definition.close && <DockCloseButton definition={definition} />}
      {region === "rail" && <span className="dock-grip" aria-hidden="true">⠿</span>}
      {region === "left" && <DockMenuButton panels={[id]} />}
    </header>
    {contextMenu.menu}
    {!preference.collapsed && <div id={bodyId} className="dock-card-body">
      <DockSlot id={id} height={preference.height ?? (usesNaturalHeight(id) ? minimumBody(definition) : initialBody(definition))} />
    </div>}
    {!preference.collapsed && <div className="dock-card-resizer" role="separator" aria-orientation="horizontal"
      aria-label={text(`调整 ${definition.title} 高度；双击恢复自动高度`, `Resize ${definition.title}; double-click for automatic height`)}
      aria-disabled={preferences.locked} tabIndex={preferences.locked ? -1 : 0} onPointerDown={resize}
      onDoubleClick={() => { if (!preferences.locked) store.dispatch({ type: "card", panel: id, height: null }); }}
      onKeyDown={event => {
        if (preferences.locked || event.nativeEvent.isComposing || event.defaultPrevented) return;
        if (event.key === "Home") { event.preventDefault(); store.dispatch({ type: "card", panel: id, height: null }); }
        else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const current = card.current?.querySelector(".dock-slot")?.getBoundingClientRect().height ?? initialBody(definition);
          const ceiling = card.current ? Math.max(current, Math.min(window.innerHeight * 2, resizeCeiling(card.current, region))) : window.innerHeight * 2;
          const natural = id === "context" ? contextCardGeometry(hosts.get(id).element)?.natural : undefined;
          store.dispatch({ type: "card", panel: id, height: clamp(current + (event.key === "ArrowDown" ? 1 : -1) * (event.shiftKey ? 48 : 16), resizeMinimum(), Math.min(ceiling, natural ?? ceiling)) });
        }
      }} />}
  </section>;
}

export function DockCardRegion({ region, visible = true }: { region: "left" | "rail"; visible?: boolean }) {
  const { document, window } = useConversationDom();
  const { layout, preview, store, hosts } = useDock();
  const { marks } = usePreviewMode();
  const text = useLabels();
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => region === "rail" && list.current ? hosts.attachRailScroll(list.current) : undefined, [hosts, region]);
  const projected = useSyncExternalStore(dragPreview.subscribe, () => {
    const state = dragPreview.snapshot();
    return state?.hosts === hosts && state.cards?.region === region
      ? state.layout[region].panels : layout[region].panels;
  });
  const placement = useSyncExternalStore(dragPreview.subscribe, () => { const state = dragPreview.snapshot(); return state?.hosts === hosts && state.cards?.region === region ? state.cards : null; });
  const panels = visible ? projected : [];
  useAutomaticCardHeights(list, panels.filter(id => layout[region].panels.includes(id)));
  useCardReorder(list, panels, placement ? panels.map(id => placement.sizes[id]?.height ?? 0).join(",") : "");
  useEffect(() => {
    let frame = 0;
    const open = (event: Event) => {
      const id = (event as CustomEvent<{ panel: PanelId }>).detail.panel;
      if (!store.getSnapshot().layout[region].panels.includes(id)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => reveal(list.current?.querySelector<HTMLElement>(`[data-dock-card="${id}"]`) ?? null));
    };
    window.addEventListener("omp:dock-open", open);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("omp:dock-open", open); };
  }, [store, region]);
  return <div className={`dock-card-region dock-card-region-${region}`} hidden={!visible} data-dock-focus-region={region} tabIndex={-1}
    aria-label={region === "left" ? text("左侧工具", "Left tools") : text("对话工具区", "Conversation tools")}>
    {preview && marks && <span className="dock-demo">{text("演示", "Demo")}</span>}
    <div className="dock-card-list" ref={list} data-dock-cards={region} data-dock-empty={region}>
      {panels.map(id => layout[region].panels.includes(id) ? <DockCard id={id} region={region} key={id} />
        : <div key={id} className="dock-card dock-card-placeholder dock-drag-source" data-dock-card={id} style={{ height: placement!.sizes[id]!.height }} />)}
      {!panels.length && <div className="dock-empty"><span>{text("添加工具或拖动到这里", "Add a tool or drag it here")}</span><DockToolsButton /></div>}
    </div>
  </div>;
}

/** Ends a panel's subject (closes a web page). While the close waits its button spins and ignores clicks. */
function DockCloseButton({ definition, className = "dock-icon-button dock-card-close", tabIndex }: { definition: PanelDefinition; className?: string; tabIndex?: number }) {
  const close = definition.close!;
  return <button type="button" className={`${className}${close.pending ? " is-pending" : ""}`} tabIndex={tabIndex} aria-label={close.label} aria-disabled={close.pending || undefined}
    data-tip={close.pending ? close.pendingTip ?? close.tip : close.tip} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if (!close.pending) close.run(); }}>
    {close.pending ? <i className="dock-glyph-spinner" aria-hidden="true" /> : <Icon name="x" extra="sm" />}
  </button>;
}

/** `trailing` is the one per-region control that still belongs on the tab row
 * (today: the group picker when the right region cannot show both groups). */
function DockTabs({ group, region, expanded = true, trailing }: { group: DockGroup; region: "right" | "bottom" | "float"; expanded?: boolean; trailing?: ReactNode }) {
  const document = useSurfaceDocument();
  const drag = useDockDrag();
  const { store, definitions, preferences, hosts } = useDock();
  const source = useDragSource(hosts);
  const text = useLabels();
  const tabs = useRef<HTMLDivElement>(null);
  const menu = useDockContextMenu();
  const [gripNear, setGripNear] = useState(false);
  const [gripFocused, setGripFocused] = useState(false);
  const gripVisible = !preferences.locked && (gripNear || gripFocused);
  useLayoutEffect(() => {
    const strip = tabs.current;
    const fallback = strip?.closest<HTMLElement>('[data-dock-focus-region]');
    return () => {
      if (strip?.contains(document.activeElement)) requestAnimationFrame(() => {
        if (document.activeElement === document.body && fallback?.isConnected) fallback.focus({ preventScroll: true });
      });
    };
  }, []);
  const activate = (panel: PanelId, focus = false) => {
    store.dispatch({ type: "activate", groupId: group.id, panel });
    definitions.find(definition => definition.id === panel)?.content?.activate();
    focusInstancePanel(store, panel);
    if (region === "bottom" && !expanded) store.dispatch({ type: "bottomExpanded", expanded: true });
    if (focus) tabs.current?.querySelector<HTMLButtonElement>(`[data-dock-tab="${panel}"] [role="tab"]`)?.focus();
  };
  useLayoutEffect(() => {
    const strip = tabs.current;
    if (!strip) return;
    const sync = () => {
      const active = strip.querySelector<HTMLElement>(`[data-dock-tab="${group.active}"]`);
      if (!active) return;
      const view = strip.getBoundingClientRect(), item = active.getBoundingClientRect();
      strip.scrollLeft += item.left < view.left ? item.left - view.left : Math.max(0, item.right - view.right);
    };
    sync();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(strip);
    return () => observer?.disconnect();
  }, [group.active, group.panels.length]);
  const tabKeys = (event: ReactKeyboardEvent, panel: PanelId) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const index = group.panels.indexOf(panel);
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? group.panels.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + group.panels.length) % group.panels.length;
      activate(group.panels[next]!, true);
    } else if (event.key === "Delete") {
      event.preventDefault();
      // A page closes when its browser confirms; its tab stays and keeps focus until then.
      if (definitionFor(definitions, panel).close) { closePanels(store, definitions, [panel]); return; }
      const next = group.panels[index + 1] ?? group.panels[index - 1];
      if (next) activate(next, true);
      store.dispatch({ type: "hide", panels: [panel] });
    }
  };
  const add = (panel: PanelId) => {
    // The menu only offers tools this group does not own yet; keep the guard so
    // a stale menu (layout changed under it) activates instead of reordering.
    if (group.panels.includes(panel)) { activate(panel, true); return; }
    store.dispatch({ type: "move", panels: [panel], target: { region, groupId: group.id } });
  };
  return <div className={`dock-tab-strip${region !== "float" ? " has-reveal-grip" : ""}${region !== "float" && gripVisible ? " is-grip-visible" : ""}`} tabIndex={-1}
    onContextMenu={event => menu.onContextMenu(event, group.panels, group.id)} onKeyDown={event => menu.onKeyDown(event, group.panels, group.id)}
    onPointerMove={region !== "float" ? event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const near = !preferences.locked && event.clientY >= rect.top && event.clientY <= rect.bottom && x >= 0 && x <= (gripNear ? 28 : 12);
      if (near !== gripNear) setGripNear(near);
    } : undefined} onPointerLeave={() => setGripNear(false)}>
    {region !== "float" && <button type="button" className="dock-icon-button dock-group-grip" data-dock-drag="" disabled={preferences.locked}
      data-tip={text("拖动整个标签组", "Drag this group")} aria-label={text("拖动整个标签组", "Drag this group")}
      onFocus={event => setGripFocused(event.currentTarget.matches(':focus-visible'))} onBlur={() => setGripFocused(false)}
      onPointerDown={event => drag(event, group.panels)}><span aria-hidden="true">⠿</span></button>}
    <div className="dock-tabs" ref={tabs} role="tablist" aria-label={text("工具标签", "Tool tabs")}>
      {group.panels.map(id => {
        const definition = definitionFor(definitions, id);
        return <div key={id} className={`dock-tab${group.active === id ? " is-active" : ""}${source?.panels.includes(id) ? " dock-drag-source" : ""}`} data-dock-tab={id} role="presentation" onContextMenu={event => menu.onContextMenu(event, [id])}>
          <button type="button" className="dock-tab-label" role="tab" id={`dock-tab-${id}`} aria-selected={group.active === id} aria-controls={`dock-body-${group.id}`}
            tabIndex={group.active === id ? 0 : -1} data-dock-drag="" data-tip={definition.detail ?? definition.title} title={definition.detail ?? definition.title}
            onPointerDown={event => drag(event, [id])} onClick={() => activate(id)} onKeyDown={event => { menu.onKeyDown(event, [id]); tabKeys(event, id); }}>
            <PanelGlyph definition={definition} /><span>{definition.title}</span>
          </button>
          {definition.close ? <DockCloseButton definition={definition} className="dock-tab-close" tabIndex={group.active === id ? 0 : -1} /> : <button type="button" className="dock-tab-close" tabIndex={group.active === id ? 0 : -1} aria-label={text(`隐藏 ${definition.title}`, `Hide ${definition.title}`)}
            data-tip={text("隐藏工具", "Hide tool")} onClick={() => {
              const hadFocus = tabs.current?.contains(document.activeElement);
              const next = group.panels[group.panels.indexOf(id) + 1] ?? group.panels[group.panels.indexOf(id) - 1];
              if (hadFocus && group.active === id && next) activate(next, true);
              else if (hadFocus && group.active !== id) tabs.current?.querySelector<HTMLButtonElement>(`[data-dock-tab="${group.active}"] [role="tab"]`)?.focus();
              store.dispatch({ type: "hide", panels: [id] });
            }}><Icon name="x" extra="sm" /></button>}
        </div>;
      })}
    </div>
    {/* Detached windows keep their strip compact; the sidebar and bottom bar
        add tabs here. It sits right after the strip, outside the scroller: with
        a few tabs it hugs the last one, and once the strip fills it stays at the
        strip's right edge instead of scrolling away. */}
    {region !== "float" && <DockToolsButton className="dock-tab-add" label={text("新建标签", "New tab")} exclude={group.panels} onPick={add} />}
    <AppSelect className="dock-all-tabs" value={group.active} aria-label={text("全部标签", "All tabs")} data-tip={text("全部标签", "All tabs")}
      onChange={event => activate(event.target.value as PanelId, true)}>
      {group.panels.map(id => <option value={id} key={id}>{definitionFor(definitions, id).title}</option>)}
    </AppSelect>
    {trailing}
    {menu.menu}
  </div>;
}

export function DockGroupRegion({ region, visible, expanded = true }: { region: "right" | "bottom"; visible: boolean; expanded?: boolean }) {
  const { document, window } = useConversationDom();
  const { layout, store, definitions, preferences, preview, scope, hosts } = useDock();
  const source = useDragSource(hosts);
  const text = useLabels();
  const container = useRef<HTMLDivElement>(null);
  const groups = layout[region].groups;
  const [extent, setExtent] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const identity = scopeKey(scope, preview);
  useEffect(() => setSelected(null), [identity]);
  useEffect(() => {
    const open = (event: Event) => {
      const panel = (event as CustomEvent<{ panel: PanelId }>).detail.panel;
      const group = store.getSnapshot().layout[region].groups.find(item => item.panels.includes(panel));
      if (group) setSelected(group.id);
    };
    window.addEventListener("omp:dock-open", open);
    return () => window.removeEventListener("omp:dock-open", open);
  }, [store, region]);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root || !visible) return;
    const read = () => setExtent(region === "right" ? root.clientHeight : root.clientWidth);
    read();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(read);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, [visible, region]);
  const minimums = groups.map(group => region === "bottom" ? 280 : Math.max(160, minimumBody(definitionFor(definitions, group.active)) + 40));
  const constrained = groups.length === 2 && extent > 0 && extent < minimums.reduce((a, b) => a + b, 6);
  const chosen = groups.find(group => group.id === selected) ?? groups[0];
  const minimumRatio = extent ? Math.min(0.45, (minimums[0] ?? 120) / extent) : 0.2;
  const maximumRatio = extent ? Math.max(0.55, 1 - (minimums[1] ?? 120) / extent) : 0.8;
  const ratio = clamp(layout[region].ratio, minimumRatio, maximumRatio);
  const resize = (event: ReactPointerEvent<HTMLElement>) => {
    const root = container.current;
    if (!root || preferences.locked) return;
    const start = ratio;
    const size = region === "right" ? root.clientHeight : root.clientWidth;
    let next = start;
    beginDockResize(event, (dx, dy) => {
      next = clamp(start + (region === "right" ? dy : dx) / Math.max(1, size), minimumRatio, maximumRatio);
      root.style.setProperty("--dock-group-ratio", String(next));
    }, () => store.dispatch({ type: "resize", region, ratio: next }), () => root.style.setProperty("--dock-group-ratio", String(start)));
  };
  const groupPicker = constrained ? <AppSelect className="dock-group-picker" value={chosen?.id} aria-label={text("切换标签组（空间不足）", "Choose group (limited space)")}
    onChange={event => setSelected(event.target.value)}>{groups.map((group, index) => <option value={group.id} key={group.id}>
      {`${index + 1} · ${definitionFor(definitions, group.active).title}`}</option>)}</AppSelect> : null;
  return <section className={`dock-group-region dock-group-region-${region}${!expanded ? " is-folded" : ""}`} hidden={!visible}
    data-dock-focus-region={region} tabIndex={-1} aria-label={region === "right" ? text("右侧栏", "Right sidebar") : text("底栏", "Bottom panel")}>
    {/* The right region starts with its tab row. The bottom region keeps a
        floating toolbar because it overlays the tab strip; adding tools lives
        at the end of every strip, so the toolbar no longer repeats it. */}
    {region === "bottom" && <div className="dock-region-toolbar">
      {groupPicker}
      <button type="button" className="dock-icon-button" aria-expanded={expanded}
        aria-label={expanded ? text("折叠底栏正文", "Collapse bottom panel") : text("展开底栏正文", "Expand bottom panel")}
        data-tip={expanded ? text("折叠正文", "Collapse contents") : text("展开正文", "Expand contents")}
        onClick={() => store.dispatch({ type: "bottomExpanded", expanded: !expanded })}><Icon name={expanded ? "chevron-d" : "chevron-u"} extra="sm" /></button>
      <button type="button" className="dock-icon-button" aria-label={text("隐藏区域", "Hide region")} data-tip={text("隐藏区域", "Hide region")}
        onClick={() => store.dispatch({ type: "region", region: "bottom", visible: false })}><Icon name="x" extra="sm" /></button>
    </div>}
    <div className={`dock-groups${constrained ? " is-constrained" : ""}`} data-dock-groups={region} data-dock-empty={region}
      ref={container} style={{ "--dock-group-ratio": ratio } as CSSProperties}>
      {groups.map((group, index) => <Fragment key={group.id}>
        {index > 0 && !constrained && <div className="dock-group-separator" role="separator" tabIndex={preferences.locked ? -1 : 0}
          aria-orientation={region === "right" ? "horizontal" : "vertical"} aria-label={text("调整标签组比例", "Resize groups")}
          aria-valuemin={Math.round(minimumRatio * 100)} aria-valuemax={Math.round(maximumRatio * 100)} aria-valuenow={Math.round(ratio * 100)}
          aria-disabled={preferences.locked} onPointerDown={resize}
          onDoubleClick={() => { if (!preferences.locked) store.dispatch({ type: "resize", region, ratio: 0.5 }); }}
          onKeyDown={event => {
            if (preferences.locked || event.nativeEvent.isComposing || event.defaultPrevented) return;
            const negative = region === "right" ? "ArrowUp" : "ArrowLeft";
            const positive = region === "right" ? "ArrowDown" : "ArrowRight";
            if (event.key === "Home" || event.key === "Enter") { event.preventDefault(); store.dispatch({ type: "resize", region, ratio: 0.5 }); }
            else if (event.key === negative || event.key === positive) { event.preventDefault(); store.dispatch({ type: "resize", region, ratio: clamp(ratio + (event.key === positive ? 1 : -1) * (event.shiftKey ? 0.1 : 0.025), minimumRatio, maximumRatio) }); }
          }} />}
        <div className={`dock-group${source && group.panels.every(id => source.panels.includes(id)) ? " dock-drag-source" : ""}`} data-dock-group={group.id} data-dock-region={region} hidden={constrained && group !== chosen}>
          <DockTabs group={{ ...group, active: sourceActive(group, source) }} region={region} expanded={expanded} trailing={region === "right" ? groupPicker : null} />
          {expanded && (!constrained || group === chosen) && <div className="dock-group-body" role="tabpanel" id={`dock-body-${group.id}`} aria-labelledby={`dock-tab-${sourceActive(group, source)}`}>
            <DockSlot id={sourceActive(group, source)} />
          </div>}
        </div>
      </Fragment>)}
      {!groups.length && <div className="dock-empty"><span>{text("添加工具或拖动到这里", "Add a tool or drag it here")}</span><DockToolsButton /></div>}
    </div>
  </section>;
}

/** Tools use the whole conversation height, including the space beside the Composer. */
function useConversationSpace(anchor: RefObject<HTMLElement | null>) {
  const { document, window } = useConversationDom();
  const { hosts } = useDockEngine();
  const [space, setSpace] = useState({ width: 0, height: 0, bottom: 12, top: 8 });
  useLayoutEffect(() => {
    const conversation = anchor.current?.closest<HTMLElement>(".convo-wrap");
    if (!conversation) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const rect = conversation.getBoundingClientRect();
      const header = conversation.querySelector<HTMLElement>(":scope > .convo-head, :scope > .convo-topbar")?.getBoundingClientRect();
      const bottom = 12;
      const top = header && header.height > 0 ? header.bottom - rect.top + 8 : 8;
      const next = { width: rect.width, height: Math.max(0, rect.height - bottom - top), bottom, top };
      setSpace(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(read); };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    const observe = () => {
      observer?.observe(conversation);
      schedule();
    };
    const mutations = new MutationObserver(observe);
    mutations.observe(conversation, { childList: true });
    observe(); read();
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); };
  }, [anchor]);
  useLayoutEffect(() => hosts.flush(), [hosts, space.width, space.height, space.top, space.bottom]);
  return space;
}

let railTransition: ViewTransition | null = null;
let railTransitionTimer: number | undefined;
let pendingRailAction: (() => void) | null = null;
let railFoldBody: HTMLElement | null = null;
let clearRailClip: (() => void) | null = null;
let clearRailScope: (() => void) | null = null;
/** 阅读列在两种栏宽里的水平位置差；只用于把对话快照平移到新位置。 */
function conversationColumnLeft(document: Document): number | null {
  return document.querySelector<HTMLElement>(".convo-wrap > .convo-scroll > .convo-doc")?.getBoundingClientRect().left ?? null;
}
function useRailTransition() {
  const { document: scoped } = useConversationDom();
  const { store, hosts } = useDockEngine();
  return (requested: DockAction | (() => DockAction), motion: "compact" | "expanded" | "collapse" | "expand" | "hidden") => {
    const conversation = scoped.querySelector<HTMLElement>(".convo-wrap");
    const document = conversation?.ownerDocument ?? scoped;
    const window = surfaceWindow(document);
    railTransition?.skipTransition();
    clearRailClip?.(); clearRailClip = null;
    pendingRailAction?.();
    clearRailScope?.(); clearRailScope = null;
    pendingRailAction = null;
    railFoldBody?.removeAttribute("data-dock-rail-fold");
    railFoldBody = null;
    window.clearTimeout(railTransitionTimer);
    railTransition = null;
    const action = typeof requested === "function" ? requested() : requested;
    if (action.type === "card") motion = action.collapsed ? "collapse" : "expand";
    const root = document.documentElement;
    delete root.dataset.dockRailTransition;
    if (!document.startViewTransition || root.matches('[data-perf-tier~="L1"]')
      || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      store.dispatch(action);
      return;
    }
    root.dataset.dockRailTransition = motion;
    const scopeElements = [conversation, ...store.getSnapshot().layout.rail.panels.map(id => hosts.get(id).element)].filter((element): element is HTMLElement => element !== null);
    for (const element of scopeElements) element.dataset.dockRailTransitionActive = "";
    clearRailScope = () => {
      for (const element of scopeElements) delete element.dataset.dockRailTransitionActive;
      delete root.dataset.dockRailTransition;
      root.style.removeProperty("--dock-rail-shift");
    };
    const clip = action.type === "card" ? railTransitionClip(store.getSnapshot().layout.rail.panels, scoped, document) : null;
    clearRailClip = clip?.dispose ?? null;
    if (action.type === "card") {
      railFoldBody = hosts.get(action.panel).element;
      railFoldBody.dataset.dockRailFold = "";
    }
    const identity = scopeKey(store.getSnapshot().scope, store.getSnapshot().preview);
    let applied = false;
    const apply = () => {
      if (applied || identity !== scopeKey(store.getSnapshot().scope, store.getSnapshot().preview)) return;
      applied = true;
      pendingRailAction = null;
      const from = conversationColumnLeft(scoped);
      beforeConversationLayoutChange();
      flushSync(() => store.dispatch(action));
      // Mount retained panel contents before measuring their natural height.
      flushSync(() => hosts.flush());
      const to = conversationColumnLeft(scoped);
      // 对话列在两种宽度里各自居中，交叉淡入会错位成重影。把旧快照平移同样的距离，
      // 滑到新位置上再换新快照（见 dock.css 的 dock-rail-slide-out）。
      if (from !== null && to !== null && Math.abs(to - from) >= 0.5) root.style.setProperty("--dock-rail-shift", `${(to - from).toFixed(1)}px`);
      else root.style.removeProperty("--dock-rail-shift");
      afterConversationLayoutChange();
      hosts.flush();
    };
    pendingRailAction = apply;
    const transition = document.startViewTransition(() => {
      if (railTransition === transition) apply();
    });
    railTransition = transition;
    clip?.watch(transition);
    const clear = () => {
      if (railTransition !== transition) return;
      window.clearTimeout(railTransitionTimer);
      clip?.dispose(); clearRailClip = null;
      pendingRailAction = null;
      railFoldBody?.removeAttribute("data-dock-rail-fold");
      railFoldBody = null;
      railTransition = null;
      clearRailScope?.(); clearRailScope = null;
      delete root.dataset.dockRailTransition;
      root.style.removeProperty("--dock-rail-shift");
    };
    // Background pages can suspend snapshot capture; committing a layout must not wait for paint.
    railTransitionTimer = window.setTimeout(() => {
      if (railTransition !== transition || applied) return;
      transition.skipTransition();
      apply();
      clear();
    }, 100);
    void transition.ready.catch(() => {});
    void transition.finished.finally(clear).catch(() => {});
  };
}

function ExpandedRail() {
  const { layout, store, preferences } = useDock();
  const transition = useRailTransition();
  const text = useLabels();
  const rail = useRef<HTMLDivElement>(null);
  const space = useConversationSpace(rail);
  const resize = (event: ReactPointerEvent<HTMLElement>) => {
    if (preferences.locked) return;
    const root = rail.current?.closest<HTMLElement>(".adaptive-workbench");
    if (!root || !rail.current) return;
    const prior = root.style.getPropertyValue("--dock-rail-w");
    const start = rail.current.getBoundingClientRect().width;
    let width = start;
    beforeConversationLayoutChange();
    beginDockResize(event, dx => { width = Math.round(clamp(start - dx, 280, 480)); root.style.setProperty("--dock-rail-w", `${width}px`); afterConversationLayoutChange(); },
      () => { store.dispatch({ type: "resize", region: "rail", size: width }); },
      () => { if (prior) root.style.setProperty("--dock-rail-w", prior); else root.style.removeProperty("--dock-rail-w"); });
  };
  return <aside className="dock-rail-expanded" ref={rail} style={{ top: space.top, bottom: space.bottom }} aria-label={text("对话工具区", "Conversation tools")}>
    <div className="dock-rail-width-resizer" role="separator" aria-orientation="vertical" tabIndex={preferences.locked ? -1 : 0}
      aria-label={text("调整对话工具区宽度", "Resize conversation tools")} aria-valuemin={280} aria-valuemax={480} aria-valuenow={layout.rail.width}
      aria-disabled={preferences.locked} onPointerDown={resize}
      onDoubleClick={() => { if (!preferences.locked) store.dispatch({ type: "resize", region: "rail", size: 320 }); }}
      onKeyDown={event => {
        if (preferences.locked || event.nativeEvent.isComposing || event.defaultPrevented) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); store.dispatch({ type: "resize", region: "rail", size: clamp(layout.rail.width + (event.key === "ArrowLeft" ? 16 : -16), 280, 480) }); }
      }} />
    <div className="dock-region-toolbar dock-rail-toolbar"><span className="dock-toolbar-spacer" />
      <DockToolsButton />
      <button type="button" className="dock-icon-button" data-tip={text("切换为悬浮图标", "Switch to floating icons")} aria-label={text("切换为悬浮图标", "Switch to floating icons")}
        onClick={() => transition({ type: "railMode", mode: "compact" }, "compact")}><Icon name="layout" extra="sm" /></button>
      <button type="button" className="dock-icon-button" data-tip={text("隐藏对话工具区", "Hide conversation tools")} aria-label={text("隐藏对话工具区", "Hide conversation tools")}
        onClick={() => transition({ type: "railMode", mode: "hidden" }, "hidden")}><Icon name="x" extra="sm" /></button>
    </div>
    <DockCardRegion region="rail" />
  </aside>;
}

function CompactRail() {
  const { document, window } = useConversationDom();
  const drag = useDockDrag();
  const contextMenu = useDockContextMenu();
  const transition = useRailTransition();
  const { layout, store, definitions, hosts, preferences, preview } = useDock();
  const source = useDragSource(hosts);
  const { marks } = usePreviewMode();
  const text = useLabels();
  const root = useRef<HTMLDivElement>(null);
  const icons = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<PanelId | null>(null);
  const active = opened && layout.rail.panels.includes(opened) ? opened : null;
  const panels = useSyncExternalStore(dragPreview.subscribe, () => {
    const state = dragPreview.snapshot();
    return state?.hosts === hosts && state.cards?.region === "rail" && state.cards.icons ? state.layout.rail.panels : layout.rail.panels;
  });
  useCardReorder(icons, panels);
  const space = useConversationSpace(root);
  useAutomaticCardHeights(overlay, active ? [active] : [], true);
  const overlayId = useId();
  const close = (focus: boolean) => {
    setOpened(null);
    if (focus && active) root.current?.querySelector<HTMLButtonElement>(`[data-dock-rail-icon="${active}"]`)?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => { if (active) overlay.current?.focus({ preventScroll: true }); }, [active]);
  useLayoutEffect(() => {
    const open = (event: Event) => {
      const panel = (event as CustomEvent<{ panel: PanelId }>).detail.panel;
      if (store.getSnapshot().layout.rail.panels.includes(panel)) setOpened(panel);
    };
    window.addEventListener("omp:dock-open", open);
    return () => window.removeEventListener("omp:dock-open", open);
  }, [store]);
  useEffect(() => {
    if (!active) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || root.current?.contains(target) || hosts.get(active).element.contains(target) || target.closest(POPUP)) return;
      // Return to the source; the clicked control can still take focus normally.
      close(true);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || (event.target instanceof Element && event.target.closest(POPUP))) return;
      event.preventDefault(); close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", key); };
  }, [active, hosts]);
  return <div className="dock-rail-compact" ref={root} style={{ top: space.top, bottom: space.bottom }} data-dock-focus-region="rail" tabIndex={-1} aria-label={text("对话工具区", "Conversation tools")}>
    <div className="dock-region-toolbar dock-rail-toolbar"><span className="dock-toolbar-spacer" />
      <DockToolsButton />
      <button type="button" className="dock-icon-button" aria-label={text("切换为完整卡片列", "Switch to expanded cards")} data-tip={text("完整卡片列", "Expanded cards")}
        onClick={() => transition({ type: "railMode", mode: "expanded" }, "expanded")}><Icon name="columns" extra="sm" /></button>
      <button type="button" className="dock-icon-button" aria-label={text("隐藏对话工具区", "Hide conversation tools")} data-tip={text("隐藏", "Hide")}
        onClick={() => transition({ type: "railMode", mode: "hidden" }, "hidden")}><Icon name="x" extra="sm" /></button>
    </div>
    <div className="dock-rail-icons" data-dock-cards="rail" data-dock-empty="rail">
      {preview && marks && <span className="dock-demo">{text("演示", "Demo")}</span>}
      <div className="dock-rail-icon-list" ref={icons}>
        {panels.map(id => !layout.rail.panels.includes(id) ? <div key={id} className="dock-rail-icon dock-card-placeholder dock-drag-source" data-dock-card={id} /> : <RailIcon key={id} definition={definitionFor(definitions, id)} active={active === id} overlayId={overlayId}
          onPointerDown={event => drag(event, [id])} onClick={() => { focusInstancePanel(store, id); active === id ? close(true) : setOpened(id); }}
          onContextMenu={event => contextMenu.onContextMenu(event, [id])} onKeyDown={event => contextMenu.onKeyDown(event, [id])} />)}
      </div>
    </div>
    {active && <div className={`dock-rail-overlay${source?.panels.includes(active) ? " dock-drag-source" : ""}`} ref={overlay} id={overlayId} tabIndex={-1} role="region" aria-label={definitionFor(definitions, active).title}
      data-dock-cards="rail" style={{ width: Math.max(0, Math.min(layout.rail.width, space.width - 64)) }}>
      <header className="dock-card-header" onPointerDown={event => drag(event, [active])}
        onContextMenu={event => contextMenu.onContextMenu(event, [active])} onKeyDown={event => contextMenu.onKeyDown(event, [active])}>
        <span className="dock-overlay-title"><PanelGlyph definition={definitionFor(definitions, active)} /><span>{definitionFor(definitions, active).title}</span></span>
        {!preferences.locked && <span className="dock-grip" aria-hidden="true">⠿</span>}
        <button type="button" className="dock-icon-button" aria-label={text("收起工具", "Dismiss tool")} data-tip={text("收起", "Dismiss")} onClick={() => close(true)}><Icon name="x" extra="sm" /></button>
      </header>
      <div className="dock-group-body"><DockSlot id={active} height={layout.cards[active]!.height ?? initialBody(definitionFor(definitions, active))} /></div>
    </div>}
    {contextMenu.menu}
  </div>;
}

function RailIcon({ definition, active, overlayId, onPointerDown, onClick, onContextMenu, onKeyDown }: {
  definition: PanelDefinition; active: boolean; overlayId: string;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onClick: () => void;
  onContextMenu: MouseEventHandler<HTMLButtonElement>;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { hosts } = useDockEngine();
  const source = useDragSource(hosts);
  const destination = useDragRegion(hosts);
  const meter = usePanelMeter(definition.id);
  const label = definition.meter && meter ? `${definition.title} · ${meter.label}` : definition.title;
  return <button type="button" className={`dock-rail-icon${active ? " is-active" : ""}${definition.meter ? " has-meter" : ""}${source?.panels.includes(definition.id) ? ` dock-drag-source${destination !== "rail" ? " is-drag-away" : ""}` : ""}`}
    data-dock-drag="" data-dock-card={definition.id} data-dock-rail-icon={definition.id} data-tip={definition.meter ? meter?.detail ?? label : definition.detail ?? label} aria-label={label}
    style={isInstancePanelId(definition.id) ? undefined : { viewTransitionName: `dock-rail-${definition.id}` }} aria-expanded={active} aria-controls={active ? overlayId : undefined}
    onPointerDown={onPointerDown} onClick={onClick} onContextMenu={onContextMenu} onKeyDown={onKeyDown}>
    {definition.meter ? <DockMeterRing meter={meter} /> : null}{isAgentPanelId(definition.id) ? <><span className="dock-agent-abbr">{definition.compactLabel}</span><PanelGlyph definition={definition} /></> : <PanelGlyph definition={definition} size="" />}
    {definition.meter ? <DockMeterBadge meter={meter} /> : null}
  </button>;
}

export function DockRail({ mode }: { mode: RailMode }) {
  const { scope, preview } = useDock();
  if (mode === "hidden") return null;
  return mode === "expanded" ? <ExpandedRail /> : <CompactRail key={scopeKey(scope, preview)} />;
}
export function DockRailToggle() {
  const { layout } = useDock();
  const transition = useRailTransition();
  const text = useLabels();
  const visible = layout.rail.mode !== "hidden";
  return <button type="button" className={`dock-icon-button dock-rail-toggle${visible ? " is-active" : ""}`} data-dock-entry="rail"
    aria-label={text("对话工具区", "Conversation tools")} aria-pressed={visible} data-tip={text("对话工具区", "Conversation tools")}
    onClick={() => transition({ type: "region", region: "rail", visible: !visible }, visible ? "hidden" : layout.rail.lastMode)}><Icon name="tool-list" /></button>;
}

export function FloatWindow({ group: storedGroup, bounds, order, nativeKey }: { group: DockFloat; bounds: DockRect; order: number; nativeKey?: string }) {
  const { document, window } = useConversationDom();
  const drag = useDockDrag();
  const { store, definitions, preferences, hosts, modalPanel, conversationTitle } = useDock();
  const source = useDragSource(hosts);
  const group = { ...storedGroup, active: sourceActive(storedGroup, source) };
  const workspace = useConversationWorkspace();
  const manager = store.windowManager;
  const managed = manager?.get(store.windowId(group.id));
  const cell = manager?.cell(store.windowId(group.id));
  const snap = manager?.getSnapshot().snap;
  const snapped = !nativeKey && !group.maximized && cell !== undefined && !!snap;
  if (!nativeKey && manager && group.maximized) bounds = manager.geometry.canvas;
  if (snapped && workspace?.snapLayer) bounds = { x: 0, y: 0, width: workspace.snapLayer.clientWidth, height: workspace.snapLayer.clientHeight };
  const modal = !nativeKey && !!modalPanel && group.panels.includes(modalPanel);
  const text = useLabels();
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const open = (event: Event) => { if (group.panels.includes((event as CustomEvent).detail.panel)) frame.current?.focus({ preventScroll: true }); };
    window.addEventListener("omp:dock-open", open);
    return () => window.removeEventListener("omp:dock-open", open);
  }, [group.id, group.panels.join(",")]);
  const menu = useDockContextMenu();
  const tabbed = group.panels.length > 1;
  const minHeight = Math.max(200, minimumBody(definitionFor(definitions, group.active)) + 42 + (tabbed ? 36 : 0));
  const rect = snapped && snap && manager ? snapCells(snap.template, snap.tree, manager.size())[cell!]! : nativeKey || group.maximized ? { x: 0, y: 0, width: bounds.width, height: bounds.height } : clampFloat(group.rect, { width: bounds.width, height: bounds.height }, minHeight);
  const control = (action: "minimize" | "maximize") => { if (nativeKey) void globalThis.ompStudioChrome!.controlFloatWindow!({ key: nativeKey, action }); else store.dispatch({ type: "float", groupId: group.id, ...(action === "minimize" ? { minimized: true } : { maximized: !group.maximized }) }); };
  const dragTitle = (event: ReactPointerEvent<HTMLElement>) => {
    if (nativeKey) return;
    if (readWorkbenchBounds(globalThis.document)) { drag(event, group.panels, group.id); return; }
    if (event.button !== 0 || preferences.locked || group.maximized || (event.target as Element).closest("button")) return;
    let next = rect;
    beginDockResize(event, (dx, dy) => { next = clampFloat({ ...rect, x: rect.x + dx, y: rect.y + dy }, bounds, minHeight); if (frame.current) { frame.current.style.left = `${bounds.x + next.x}px`; frame.current.style.top = `${bounds.y + next.y}px`; } hosts.flush(); }, () => store.dispatch({ type: "float", groupId: group.id, rect: next }), () => { if (frame.current) { frame.current.style.left = `${bounds.x + rect.x}px`; frame.current.style.top = `${bounds.y + rect.y}px`; } hosts.flush(); });
  };
  const activeDefinition = definitionFor(definitions, group.active);
  const title = activeDefinition.content ? activeDefinition.title : floatTitle(activeDefinition.title, conversationTitle);
  const closesPages = group.panels.some(id => definitionFor(definitions, id).close);
  const containsConversation = group.panels.some(id => definitionFor(definitions, id).content);
  const content = <WindowFrame title={title} icon={definitionFor(definitions, group.active).icon}
    titleContent={definitionFor(definitions, group.active).glyph ? <><PanelGlyph definition={definitionFor(definitions, group.active)} /><span>{title}</span></> : undefined}
    {...(closesPages ? { closeLabel: group.panels.every(isFilePanelId) ? text("关闭文件", "Close file") : containsConversation ? text("关闭整个浮窗", "Close window group") : group.panels.length > 1 ? text("关闭网页并隐藏其余工具", "Close pages and hide other tools") : text("关闭网页", "Close page") } : {})} rect={rect} bounds={bounds} minHeight={minHeight} minWidth={manager ? 360 : 320} resizable={!snapped}
    maximizeButton={!nativeKey && managed && manager ? <WindowSnapButton manager={manager} window={managed} locked={preferences.locked} onMaximize={() => control("maximize")} /> : undefined}
    frameRef={frame} nativeKey={nativeKey} maximized={group.maximized} locked={preferences.locked} order={order} windowId={`tool:${store.documentId ?? "standalone"}:${group.id}`} visible={!group.minimized}
    onTitleDrag={dragTitle} onTitleContextMenu={event => menu.onContextMenu(event, group.panels, group.id)} onTitleKeyDown={event => menu.onKeyDown(event, group.panels, group.id)}
    onControl={control} onClose={() => closePanels(store, definitions, group.panels)}
    onRectChange={rect => store.dispatch({ type: "float", groupId: group.id, rect })} onMeasure={() => hosts.flush()}
    frameProps={{ role: modal ? "dialog" : "region", "aria-modal": modal || undefined, "aria-owns": modal ? "dock-context-viewer-content" : undefined,
      "aria-label": modal ? title : text(`${title} 浮窗`, `${title} floating window`),
      className: `${snapped ? "is-snapped " : ""}${source && group.panels.every(id => source.panels.includes(id)) ? "dock-drag-source" : ""}`,
      style: { ...(modal ? { zIndex: 81 } : {}), ...(snapped ? { position: "absolute" } : {}) },
      ...{ "data-conversation-owner": store.documentId, "data-dock-modal": modal ? "" : undefined, "data-dock-float": group.id, "data-dock-order": order, "data-dock-focus-region": `float-${group.id}`, "data-dock-group": group.id, "data-dock-region": "float", "data-dock-pin": group.pin?.mode, "data-workbench-surface": !group.pin ? "" : undefined } }}
    titleExtra={<>{group.panels.length > 1 && <span className="dock-count">{group.panels.length}</span>}{group.pin && <span className="dock-pin-status" data-tip={t(`dockPin.${group.pin.mode}`)} aria-label={t(`dockPin.${group.pin.mode}`)}><Icon name={group.pin.mode === "topmost" ? "pin" : group.pin.mode === "window" ? "external" : "pin"} extra="sm" /></span>}</>}
    controls={<DockPinButton group={group} />} tabs={tabbed && <DockTabs group={group} region="float" />} menu={menu.menu}>
    <div className="dock-group-body" id={`dock-body-${group.id}`} role={tabbed ? "tabpanel" : "region"} aria-labelledby={tabbed ? `dock-tab-${group.active}` : undefined} aria-label={tabbed ? undefined : title}><DockSlot id={group.active} /></div>
  </WindowFrame>;
  return snapped ? workspace?.snapLayer ? createPortal(content, workspace.snapLayer) : null : content;
}

/** The float frame, content host and its menus are separate portals. */
function DockModalFocus({ panel }: { panel: PanelId }) {
  const { store, hosts } = useDockEngine();
  const { resolvedLanguage } = useI18n();
  useLayoutEffect(() => {
    const doc = document;
    const win = doc.defaultView!;
    const origin = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    const frame = () => doc.querySelector<HTMLElement>("[data-dock-modal]");
    const host = hosts.get(panel).element;
    const allowed = (target: Element | null) => !!target && (!!target.closest("[data-dock-modal], [data-dock-menu='popup']") || host.contains(target));
    const first = () => frame()?.querySelector<HTMLElement>(FOCUSABLE) ?? frame();
    const focusFrame = () => first()?.focus({ preventScroll: true });
    doc.body.classList.add("dock-modal-active");
    hosts.flush();
    const request = win.requestAnimationFrame(() => { hosts.flush(); focusFrame(); });
    const onFocus = (event: FocusEvent) => {
      if (!allowed(event.target as Element | null)) focusFrame();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !doc.body.classList.contains("dock-dragging") && !doc.body.classList.contains("dock-resizing") && !doc.querySelector("[data-dock-menu='popup']")) {
        event.preventDefault(); event.stopImmediatePropagation();
        store.dispatch({ type: "hide", panels: [panel] });
        return;
      }
      if (event.key !== "Tab") return;
      const popup = doc.querySelector<HTMLElement>("[data-dock-menu='popup']");
      const roots = popup ? [popup] : [frame(), host].filter((node): node is HTMLElement => !!node);
      const items = roots.flatMap(root => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]).filter(visibleElement);
      if (!items.length) { event.preventDefault(); focusFrame(); return; }
      const current = items.indexOf(doc.activeElement as HTMLElement);
      if (event.shiftKey && current <= 0) { event.preventDefault(); items[items.length - 1]!.focus(); }
      else if (!event.shiftKey && (current < 0 || current === items.length - 1)) { event.preventDefault(); items[0]!.focus(); }
    };
    const onBubble = (event: KeyboardEvent) => {
      event.stopPropagation();
    };
    doc.addEventListener("focusin", onFocus, true);
    win.addEventListener("keydown", onKey, true);
    doc.addEventListener("keydown", onBubble);
    return () => {
      win.cancelAnimationFrame(request);
      doc.body.classList.remove("dock-modal-active");
      doc.removeEventListener("focusin", onFocus, true);
      win.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("keydown", onBubble);
      hosts.schedule();
      if (!locatePanel(store.getSnapshot().layout, panel)) {
        const entry = origin?.isConnected && origin !== doc.body && !origin.closest("[hidden], [inert]") ? origin
          : [...doc.querySelectorAll<HTMLElement>("button[aria-label]")].find(button => button.getAttribute("aria-label") === translate(resolvedLanguage, "shell.contextCompositionDetails") && visibleElement(button));
        entry?.focus({ preventScroll: true });
      }
    };
  }, [hosts, panel, store, resolvedLanguage]);
  return <div className="dock-modal-backdrop" aria-hidden="true" />;
}

export function DockFloatingLayer() {
  const scoped = useConversationDom();
  const document = globalThis.document, window = document.defaultView!;
  const { layout, store, preview, definitions, modalPanel, conversationTitle, scope, preferences } = useDock();
  const workspace = useConversationWorkspace();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [bounds, setBounds] = useState<DockRect | null>(null);
  const hasLocalFloats = layout.floats.some(group => !isNativeFloat(group) || !globalThis.ompStudioChrome?.prepareFloatWindow);
  useLayoutEffect(() => {
    if (!hasLocalFloats) return;
    let frame = 0;
    const watched = new WeakSet<Element>();
    const read = () => {
      frame = 0;
      const workbench = scoped.document.querySelector<HTMLElement>(".adaptive-workbench");
      const wb = workbench?.getBoundingClientRect();
      const shellNode = document.querySelector<HTMLElement>("[data-dock-workbench], .app-shell");
      const canvas = workspace?.slots.bottomReveal;
      const fallback = canvas?.getBoundingClientRect();
      const rect = readWorkbenchBounds(document) ?? fallback;
      for (const node of [workbench, shellNode, canvas]) if (node && !watched.has(node)) { observer?.observe(node); watched.add(node); }
      if (rect?.width && rect.height) {
        const previous = wb?.width ? wb : fallback;
        if (previous?.width && previous.height) store.migrateFloatCoordinates(previous, rect);
        setBounds(old => old && old.x === rect.x && old.y === rect.y && old.width === rect.width && old.height === rect.height ? old : { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(read); };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(document.body);
    const mutations = new MutationObserver(records => {
      if (records.some(record => record.target.nodeType === 1 && (record.target as Element).matches("body, #root, .app, .app-shell, [data-dock-workbench], .cw-canvas, .adaptive-workbench, .app-rail"))) schedule();
    });
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "inert"] });
    window.addEventListener("resize", schedule); document.addEventListener("scroll", schedule, true); read();
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); document.removeEventListener("scroll", schedule, true); };
  }, [hasLocalFloats, workspace?.slots.bottomReveal, layout.floatCoordinateVersion, scopeKey(scope, preview)]);
  useEffect(() => {
    const raise = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target;
      const direct = target.closest<HTMLElement>("[data-dock-float]")?.dataset.dockFloat;
      const panel = target.closest<HTMLElement>("[data-panel]")?.dataset.panel as PanelId | undefined;
      const floats = store.getSnapshot().layout.floats;
      const id = direct ?? (panel ? floats.find(group => group.panels.includes(panel))?.id : undefined);
      if (id && floats.at(-1)?.id !== id) store.dispatch({ type: "raise", groupId: id });
    };
    document.addEventListener("pointerdown", raise, true); document.addEventListener("focusin", raise, true);
    return () => { document.removeEventListener("pointerdown", raise, true); document.removeEventListener("focusin", raise, true); };
  }, [store]);
  const minimizedPins = useAllWindowed() ? [] : layout.floats.filter(group => group.pin && !isNativeFloat(group) && group.minimized);
  return <>{createPortal(<div className="dock-floating-layer">{modalPanel && <DockModalFocus panel={modalPanel} />}{layout.floats.map((group, order) => {
    const managed = store.windowManager?.get(store.windowId(group.id));
    if (managed?.content.kind === "conversation") return null;
    if (managed && managed.placement !== "native" && !store.windowManager!.visible(managed)) return null;
    if (isNativeFloat(group) && globalThis.ompStudioChrome?.prepareFloatWindow) return <NativeFloat key={`${preview}:${group.id}`} group={group} namespace={preview ? "preview" : "real"} onError={message => setError(`${t("dockPin.failed")}：${message}`)} />;
    return bounds && !group.minimized ? <FloatWindow key={group.id} group={group} order={order} bounds={bounds} /> : null;
  })}
    {!!minimizedPins.length && <div className="dock-pinned-capsules" role="group" aria-label={t("dockPin.minimized")}>{minimizedPins.map(group => <MinimizedCapsule key={group.id} owner={store.windowManager ?? store} capsuleId={`pin:${preview}:${group.id}`} locked={preferences.locked} onClick={() => store.dispatch({ type: "open", panel: group.active })}><Icon name="pin" extra="sm" /><span className="dock-capsule-title">{floatTitle(definitionFor(definitions, group.active).title, conversationTitle)}</span><Icon name="restore" extra="sm" /></MinimizedCapsule>)}</div>}
  </div>, document.body)}<ToastHost message={error} icon="alert" onDismiss={() => setError(null)} /></>;
}

export function DockCapsules() {
  const { layout, store, definitions, conversationTitle, scope, preview, preferences } = useDock();
  const text = useLabels();
  const view = useConversationView();
  const root = useRef<HTMLDivElement>(null);
  const space = useConversationSpace(root);
  // In window mode the window tab bar lists minimized tools instead.
  const minimized = useAllWindowed() || (view && !view.visible) ? [] : layout.floats.filter(group => group.minimized && !group.pin && store.windowManager?.get(store.windowId(group.id))?.content.kind !== "conversation");
  const capacity = Math.max(1, Math.floor(Math.max(0, space.width - 64) / 184)) * 2;
  const overflow = minimized.length > capacity;
  const displayed = overflow ? minimized.slice(0, Math.max(0, capacity - 1)) : minimized;
  const restore = (group: DockFloat) => store.dispatch({ type: "open", panel: group.active });
  return <div className="dock-capsules" ref={root} style={{ bottom: space.bottom, maxHeight: Math.max(32, Math.min(88, space.height)) }} hidden={!minimized.length}
    role="group" aria-label={text("已最小化的工具", "Minimized tools")}>
    {displayed.map(group => {
      const definition = definitionFor(definitions, group.active);
      const title = floatTitle(definition.title, conversationTitle);
      return <MinimizedCapsule key={group.id} owner={store.windowManager ?? store} capsuleId={`tool:${scopeKey(scope, preview)}:${group.id}`} locked={preferences.locked} data-tip={title} onClick={() => restore(group)}
        aria-label={text(`还原 ${title}${group.panels.length > 1 ? `（${group.panels.length} 个工具）` : ""}`, `Restore ${title}${group.panels.length > 1 ? ` (${group.panels.length} tools)` : ""}`)}>
        <PanelGlyph definition={definition} /><span className="dock-capsule-title">{title}</span>
        {group.panels.length > 1 && <span className="dock-count">{group.panels.length}</span>}<Icon name="restore" extra="sm" />
      </MinimizedCapsule>;
    })}
    {overflow && <AppSelect className="dock-capsule-overflow" value="" placeholder={text(`全部浮窗（${minimized.length}）`, `All windows (${minimized.length})`)}
      aria-label={text("还原最小化浮窗", "Restore minimized window")} onChange={event => {
        const group = minimized.find(item => item.id === event.target.value); if (group) restore(group);
      }}>{minimized.map(group => <option key={group.id} value={group.id}>{floatTitle(definitionFor(definitions, group.active).title, conversationTitle)}{group.panels.length > 1 ? ` (${group.panels.length})` : ""}</option>)}</AppSelect>}
  </div>;
}

/** Hosts live at the end of the document, so focus navigation follows their visual slots. */
export function DockKeyboard() {
  const { document, window } = useConversationDom();
  const { store } = useDock();
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(POPUP)) return;
      const modifier = PLATFORM === "darwin" ? event.metaKey : event.ctrlKey;
      if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === "l") {
        if (target?.closest('input, textarea, [contenteditable="true"], .cm-editor, .xterm')) return;
        event.preventDefault();
        store.dispatch({ type: "region", region: "rail", visible: store.getSnapshot().layout.rail.mode === "hidden" });
        return;
      }
      if (event.key !== "F6" || event.ctrlKey || event.metaKey || event.altKey) return;
      const workbench = document.querySelector<HTMLElement>(".adaptive-workbench");
      if (!workbench || workbench.hidden) return;
      const candidates = [...workbench.querySelectorAll<HTMLElement>('[data-dock-focus-region], .convo-wrap, .sidebar-nav, .sidebar-projects, #sbProjects'), ...document.querySelectorAll<HTMLElement>('.dock-float[data-dock-focus-region]')]
        .filter(visibleElement);
      // Remove nested candidates: compact rail stays a distinct region from the conversation.
      const regions = candidates.filter((element, index) => candidates.indexOf(element) === index && !candidates.some(other => other !== element && other.contains(element) && !other.classList.contains("convo-wrap")));
      const boxes = new Map(regions.map(element => [element, element.getBoundingClientRect()]));
      const priority = (element: HTMLElement) => {
        const id = element.dataset.dockFocusRegion;
        if (element.closest(".dock-float")) return 5;
        if (id === "bottom") return 4;
        if (id === "right") return 3;
        if (id === "rail") return 2;
        if (element.classList.contains("convo-wrap")) return 1;
        return 0;
      };
      regions.sort((a, b) => priority(a) - priority(b) || boxes.get(a)!.top - boxes.get(b)!.top || boxes.get(a)!.left - boxes.get(b)!.left);
      if (!regions.length) return;
      const host = target?.closest<HTMLElement>("[data-panel]");
      const origin = host ? document.querySelector<HTMLElement>(`[data-dock-slot="${host.dataset.panel}"]`) : target;
      let index = regions.findIndex(region => origin && region.contains(origin));
      // The conversation also contains its overlay rail; choose the innermost match.
      if (origin) for (let i = 0; i < regions.length; i++) if (regions[i]!.contains(origin) && (index < 0 || regions[index]!.contains(regions[i]!))) index = i;
      if (index < 0 && event.shiftKey) index = 0;
      const next = regions[(index + (event.shiftKey ? -1 : 1) + regions.length) % regions.length]!;
      event.preventDefault();
      const first = [...next.querySelectorAll<HTMLElement>(FOCUSABLE)].find(element => visibleElement(element) && (!next.classList.contains("convo-wrap") || !element.closest('[data-dock-focus-region]')));
      if (first) first.focus({ preventScroll: true });
      else { if (!next.hasAttribute("tabindex")) next.tabIndex = -1; next.focus({ preventScroll: true }); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [store]);
  return null;
}
