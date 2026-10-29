import {
  Fragment, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { PLATFORM } from "../platform";
import { DockSlot, useDock } from "./DockContext";
import { DockMenuButton, DockToolsButton } from "./DockMenus";
import { beginDockDrag, beginDockResize } from "./gestures";
import { beforeConversationLayoutChange, afterConversationLayoutChange } from "../conversation/conversationReflow";
import { clampFloat } from "./model";
import type { DockFloat, DockGroup, DockRect, PanelDefinition, PanelId, RailMode } from "./types";
import "./dock.css";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const POPUP = '[data-dock-menu], .menu, [role="menu"], [role="dialog"], dialog, .app-select-popup, [role="listbox"]';
const scopeKey = (scope: { target: string; project: string | null; session: string }, preview: boolean) => JSON.stringify([scope.target, scope.project, scope.session, preview]);
const definitionFor = (definitions: readonly PanelDefinition[], id: PanelId) => definitions.find(item => item.id === id) ?? { id, title: id, icon: "box" };
const minimumBody = (definition: PanelDefinition) => Math.max(definition.minHeight ?? 64, definition.id === "terminal" ? 240 : 0);
const initialBody = (definition: PanelDefinition) => Math.max(minimumBody(definition), definition.initialHeight ?? (definition.id === "browser" || definition.id === "computer" ? 320 : 280));
const usesNaturalHeight = (id: PanelId) => id !== "terminal" && id !== "browser" && id !== "computer";
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
function useAutomaticCardHeights(list: RefObject<HTMLDivElement | null>, panels: PanelId[]) {
  const { hosts, definitions, layout } = useDock();
  const automatic = panels.filter(id => !layout.cards[id].collapsed && layout.cards[id].height === null && usesNaturalHeight(id));
  const ids = automatic.join(",");
  useLayoutEffect(() => {
    const root = list.current;
    if (!root || !automatic.length) return;
    let frame = 0;
    const observed = new Set<Element>();
    const entries = automatic.map(id => ({ id, host: hosts.get(id).element, definition: definitionFor(definitions, id) }));
    const measure = () => {
      frame = 0;
      if (document.body.classList.contains("dock-resizing")) return;
      const readings = entries.map(({ id, host, definition }) => {
        const slot = root.querySelector<HTMLElement>(`[data-dock-slot="${id}"]`);
        const children = [...host.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.hidden);
        for (const child of children) {
          if (!observed.has(child)) { observer?.observe(child); observed.add(child); }
        }
        const top = host.getBoundingClientRect().top;
        const natural = children.reduce((height, child) => Math.max(height, child.getBoundingClientRect().bottom - top, child.offsetTop + child.scrollHeight), 0);
        return { slot, height: clamp(Math.ceil(natural || minimumBody(definition)), minimumBody(definition), initialBody(definition)) };
      });
      for (const { slot, height } of readings) {
        if (slot && slot.style.height !== `${height}px`) slot.style.height = `${height}px`;
      }
      hosts.schedule();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    for (const { host } of entries) {
      host.dataset.dockAutoHeight = "true";
      observer?.observe(host);
      mutations.observe(host, { subtree: true, childList: true, characterData: true });
    }
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect(); mutations.disconnect();
      for (const { host } of entries) delete host.dataset.dockAutoHeight;
    };
  }, [hosts, definitions, ids, list]);
}

function DockCard({ id }: { id: PanelId }) {
  const { store, definitions, layout, preferences } = useDock();
  const text = useLabels();
  const card = useRef<HTMLElement>(null);
  const definition = definitionFor(definitions, id);
  const preference = layout.cards[id];
  const bodyId = useId();
  const toggle = () => store.dispatch({ type: "card", panel: id, collapsed: !preference.collapsed });
  const resize = (event: ReactPointerEvent<HTMLElement>) => {
    if (preferences.locked) return;
    const slot = card.current?.querySelector<HTMLElement>(".dock-slot");
    if (!slot) return;
    const previous = slot.style.height;
    const start = slot.getBoundingClientRect().height;
    const maximum = Math.max(minimumBody(definition), window.innerHeight * 2);
    let height = start;
    beginDockResize(event, (_dx, dy) => {
      height = Math.round(clamp(start + dy, minimumBody(definition), maximum));
      slot.style.height = `${height}px`;
    }, () => store.dispatch({ type: "card", panel: id, height }), () => { slot.style.height = previous; });
  };
  return <section className={`dock-card${preference.collapsed ? " is-collapsed" : ""}`} data-dock-card={id} ref={card}>
    <header className="dock-card-header" onPointerDown={event => beginDockDrag(event, store, [id])}
      onClick={event => { if (!(event.target as Element).closest("button")) toggle(); }}>
      <button type="button" className="dock-card-title" data-dock-drag="" aria-expanded={!preference.collapsed} aria-controls={bodyId}
        onClick={toggle} data-tip={definition.title}>
        <Icon name={preference.collapsed ? "chevron-r" : "chevron-d"} extra="sm" />
        <Icon name={definition.icon} extra="sm" /><span>{definition.title}</span>
      </button>
      <span className="dock-grip" aria-hidden="true">⠿</span>
      <DockMenuButton panels={[id]} />
    </header>
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
          store.dispatch({ type: "card", panel: id, height: Math.max(minimumBody(definition), current + (event.key === "ArrowDown" ? 1 : -1) * (event.shiftKey ? 48 : 16)) });
        }
      }} />}
  </section>;
}

export function DockCardRegion({ region, visible = true }: { region: "left" | "rail"; visible?: boolean }) {
  const { layout, preview, store } = useDock();
  const text = useLabels();
  const list = useRef<HTMLDivElement>(null);
  const panels = visible ? layout[region].panels : [];
  useAutomaticCardHeights(list, panels);
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
    {preview && <span className="dock-demo">{text("演示", "Demo")}</span>}
    <div className="dock-card-list" ref={list} data-dock-cards={region} data-dock-empty={region}>
      {panels.map(id => <DockCard id={id} key={id} />)}
      {!panels.length && <div className="dock-empty"><span>{text("添加工具或拖动到这里", "Add a tool or drag it here")}</span><DockToolsButton /></div>}
    </div>
  </div>;
}

function DockTabs({ group, region, expanded = true }: { group: DockGroup; region: "right" | "bottom" | "float"; expanded?: boolean }) {
  const { store, definitions, preferences } = useDock();
  const text = useLabels();
  const tabs = useRef<HTMLDivElement>(null);
  const activate = (panel: PanelId, focus = false) => {
    store.dispatch({ type: "activate", groupId: group.id, panel });
    if (region === "bottom" && !expanded) store.dispatch({ type: "bottomExpanded", expanded: true });
    if (focus) tabs.current?.querySelector<HTMLButtonElement>(`[data-dock-tab="${panel}"] [role="tab"]`)?.focus();
  };
  useLayoutEffect(() => { reveal(tabs.current?.querySelector<HTMLElement>(`[data-dock-tab="${group.active}"]`) ?? null); }, [group.active, group.panels.length]);
  const tabKeys = (event: ReactKeyboardEvent, panel: PanelId) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const index = group.panels.indexOf(panel);
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? group.panels.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + group.panels.length) % group.panels.length;
      activate(group.panels[next]!, true);
    } else if (event.key === "Delete") {
      event.preventDefault();
      const next = group.panels[index + 1] ?? group.panels[index - 1];
      if (next) activate(next, true);
      store.dispatch({ type: "hide", panels: [panel] });
    }
  };
  return <div className="dock-tab-strip">
    <button type="button" className="dock-icon-button dock-group-grip" data-dock-drag="" disabled={preferences.locked}
      data-tip={text("拖动整个标签组", "Drag this group")} aria-label={text("拖动整个标签组", "Drag this group")}
      onPointerDown={event => beginDockDrag(event, store, group.panels, region === "float" ? group.id : undefined)}><span aria-hidden="true">⠿</span></button>
    <div className="dock-tabs" ref={tabs} role="tablist" aria-label={text("工具标签", "Tool tabs")}>
      {group.panels.map(id => {
        const definition = definitionFor(definitions, id);
        return <div key={id} className={`dock-tab${group.active === id ? " is-active" : ""}`} data-dock-tab={id} role="presentation">
          <button type="button" role="tab" id={`dock-tab-${id}`} aria-selected={group.active === id} aria-controls={`dock-body-${group.id}`}
            tabIndex={group.active === id ? 0 : -1} data-dock-drag="" data-tip={definition.title}
            onPointerDown={event => beginDockDrag(event, store, [id])} onClick={() => activate(id)} onKeyDown={event => tabKeys(event, id)}>
            <Icon name={definition.icon} extra="sm" /><span>{definition.title}</span>
          </button>
          <span className="dock-tab-menu"><DockMenuButton panels={[id]} /></span>
          <button type="button" className="dock-tab-close" tabIndex={group.active === id ? 0 : -1} aria-label={text(`隐藏 ${definition.title}`, `Hide ${definition.title}`)}
            data-tip={text("隐藏工具", "Hide tool")} onClick={() => {
              const hadFocus = tabs.current?.contains(document.activeElement);
              const next = group.panels[group.panels.indexOf(id) + 1] ?? group.panels[group.panels.indexOf(id) - 1];
              if (hadFocus && group.active === id && next) activate(next, true);
              else if (hadFocus && group.active !== id) tabs.current?.querySelector<HTMLButtonElement>(`[data-dock-tab="${group.active}"] [role="tab"]`)?.focus();
              store.dispatch({ type: "hide", panels: [id] });
            }}><Icon name="x" extra="sm" /></button>
        </div>;
      })}
    </div>
    <AppSelect className="dock-all-tabs" value={group.active} aria-label={text("全部标签", "All tabs")} data-tip={text("全部标签", "All tabs")}
      onChange={event => activate(event.target.value as PanelId, true)}>
      {group.panels.map(id => <option value={id} key={id}>{definitionFor(definitions, id).title}</option>)}
    </AppSelect>
    <DockMenuButton panels={group.panels} groupId={group.id} />
  </div>;
}

export function DockGroupRegion({ region, visible, expanded = true }: { region: "right" | "bottom"; visible: boolean; expanded?: boolean }) {
  const { layout, store, definitions, preferences, preview, scope } = useDock();
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
  return <section className={`dock-group-region dock-group-region-${region}${!expanded ? " is-folded" : ""}`} hidden={!visible}
    data-dock-focus-region={region} tabIndex={-1} aria-label={region === "right" ? text("右侧栏", "Right sidebar") : text("底栏", "Bottom panel")}>
    <div className="dock-region-toolbar">
      <span className="dock-region-label">{region === "right" ? text("右侧栏", "Right sidebar") : text("底栏", "Bottom panel")}</span>
      {preview && <span className="dock-demo">{text("演示", "Demo")}</span>}
      {constrained && <AppSelect className="dock-group-picker" value={chosen?.id} aria-label={text("切换标签组（空间不足）", "Choose group (limited space)")}
        onChange={event => setSelected(event.target.value)}>{groups.map((group, index) => <option value={group.id} key={group.id}>
          {`${index + 1} · ${definitionFor(definitions, group.active).title}`}</option>)}</AppSelect>}
      <span className="dock-toolbar-spacer" /><DockToolsButton />
      {region === "bottom" && <button type="button" className="dock-icon-button" aria-expanded={expanded}
        aria-label={expanded ? text("折叠底栏正文", "Collapse bottom panel") : text("展开底栏正文", "Expand bottom panel")}
        data-tip={expanded ? text("折叠正文", "Collapse contents") : text("展开正文", "Expand contents")}
        onClick={() => store.dispatch({ type: "bottomExpanded", expanded: !expanded })}><Icon name={expanded ? "chevron-d" : "chevron-u"} extra="sm" /></button>}
      <button type="button" className="dock-icon-button" aria-label={text("隐藏区域", "Hide region")} data-tip={text("隐藏区域", "Hide region")}
        onClick={() => store.dispatch({ type: "region", region, visible: false })}><Icon name="x" extra="sm" /></button>
    </div>
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
        <div className="dock-group" data-dock-group={group.id} data-dock-region={region} hidden={constrained && group !== chosen}>
          <DockTabs group={group} region={region} expanded={expanded} />
          {expanded && (!constrained || group === chosen) && <div className="dock-group-body" role="tabpanel" id={`dock-body-${group.id}`} aria-labelledby={`dock-tab-${group.active}`}>
            <DockSlot id={group.active} />
          </div>}
        </div>
      </Fragment>)}
      {!groups.length && <div className="dock-empty"><span>{text("添加工具或拖动到这里", "Add a tool or drag it here")}</span><DockToolsButton /></div>}
    </div>
  </section>;
}

/** Both overlay surfaces use the actual Composer top, including queues and growing input. */
function useConversationSpace(anchor: RefObject<HTMLElement | null>) {
  const [space, setSpace] = useState({ width: 0, height: 0, bottom: 12, top: 8 });
  useLayoutEffect(() => {
    const conversation = anchor.current?.closest<HTMLElement>(".convo-wrap");
    if (!conversation) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const rect = conversation.getBoundingClientRect();
      const composer = conversation.querySelector<HTMLElement>(":scope > .composer-region")?.getBoundingClientRect();
      const header = conversation.querySelector<HTMLElement>(":scope > .convo-head, :scope > .convo-topbar")?.getBoundingClientRect();
      const bottom = composer && composer.height > 0 ? clamp(rect.bottom - composer.top + 8, 8, rect.height) : 12;
      const top = header && header.height > 0 ? header.bottom - rect.top + 8 : 8;
      const next = { width: rect.width, height: Math.max(0, rect.height - bottom - top), bottom, top };
      setSpace(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(read); };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    const observe = () => {
      observer?.observe(conversation);
      const composer = conversation.querySelector(":scope > .composer-region");
      if (composer) observer?.observe(composer);
      schedule();
    };
    const mutations = new MutationObserver(observe);
    mutations.observe(conversation, { childList: true });
    observe(); read();
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); };
  }, [anchor]);
  return space;
}

function ExpandedRail() {
  const { layout, store, preferences } = useDock();
  const text = useLabels();
  const rail = useRef<HTMLDivElement>(null);
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
  return <aside className="dock-rail-expanded" ref={rail} aria-label={text("对话工具区", "Conversation tools")}>
    <div className="dock-rail-width-resizer" role="separator" aria-orientation="vertical" tabIndex={preferences.locked ? -1 : 0}
      aria-label={text("调整对话工具区宽度", "Resize conversation tools")} aria-valuemin={280} aria-valuemax={480} aria-valuenow={layout.rail.width}
      aria-disabled={preferences.locked} onPointerDown={resize}
      onDoubleClick={() => { if (!preferences.locked) store.dispatch({ type: "resize", region: "rail", size: 320 }); }}
      onKeyDown={event => {
        if (preferences.locked || event.nativeEvent.isComposing || event.defaultPrevented) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); store.dispatch({ type: "resize", region: "rail", size: clamp(layout.rail.width + (event.key === "ArrowLeft" ? 16 : -16), 280, 480) }); }
      }} />
    <div className="dock-region-toolbar"><span className="dock-region-label">{text("对话工具区", "Conversation tools")}</span><span className="dock-toolbar-spacer" />
      <DockToolsButton />
      <button type="button" className="dock-icon-button" data-tip={text("切换为悬浮图标", "Switch to floating icons")} aria-label={text("切换为悬浮图标", "Switch to floating icons")}
        onClick={() => store.dispatch({ type: "railMode", mode: "compact" })}><Icon name="layout" extra="sm" /></button>
      <button type="button" className="dock-icon-button" data-tip={text("隐藏对话工具区", "Hide conversation tools")} aria-label={text("隐藏对话工具区", "Hide conversation tools")}
        onClick={() => store.dispatch({ type: "railMode", mode: "hidden" })}><Icon name="x" extra="sm" /></button>
    </div>
    <DockCardRegion region="rail" />
  </aside>;
}

function CompactRail() {
  const { layout, store, definitions, hosts, preferences, preview } = useDock();
  const text = useLabels();
  const root = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<PanelId | null>(null);
  const active = opened && layout.rail.panels.includes(opened) ? opened : null;
  const space = useConversationSpace(root);
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
    <div className="dock-rail-icons" data-dock-cards="rail" data-dock-empty="rail">
      {preview && <span className="dock-demo">{text("演示", "Demo")}</span>}
      <div className="dock-rail-icon-list">
        {layout.rail.panels.map(id => {
          const definition = definitionFor(definitions, id);
          return <button type="button" key={id} className={`dock-rail-icon${active === id ? " is-active" : ""}`}
            data-dock-drag="" data-dock-card={id} data-dock-rail-icon={id} data-tip={definition.title} aria-label={definition.title}
            aria-expanded={active === id} aria-controls={active === id ? overlayId : undefined}
            onPointerDown={event => beginDockDrag(event, store, [id])} onClick={() => active === id ? close(true) : setOpened(id)}><Icon name={definition.icon} /></button>;
        })}
      </div>
      <div className="dock-rail-icon-actions"><DockToolsButton />
        <button type="button" className="dock-icon-button" aria-label={text("切换为完整卡片列", "Switch to expanded cards")} data-tip={text("完整卡片列", "Expanded cards")}
          onClick={() => store.dispatch({ type: "railMode", mode: "expanded" })}><Icon name="columns" extra="sm" /></button>
        <button type="button" className="dock-icon-button" aria-label={text("隐藏对话工具区", "Hide conversation tools")} data-tip={text("隐藏", "Hide")}
          onClick={() => store.dispatch({ type: "railMode", mode: "hidden" })}><Icon name="x" extra="sm" /></button>
      </div>
    </div>
    {active && <div className="dock-rail-overlay" ref={overlay} id={overlayId} tabIndex={-1} role="region" aria-label={definitionFor(definitions, active).title}
      data-dock-cards="rail" style={{ width: Math.max(0, Math.min(layout.rail.width, space.width - 64)) }}>
      <header className="dock-card-header" onPointerDown={event => beginDockDrag(event, store, [active])}>
        <span className="dock-overlay-title"><Icon name={definitionFor(definitions, active).icon} extra="sm" /><span>{definitionFor(definitions, active).title}</span></span>
        {!preferences.locked && <span className="dock-grip" aria-hidden="true">⠿</span>}
        <DockMenuButton panels={[active]} />
        <button type="button" className="dock-icon-button" aria-label={text("收起工具", "Dismiss tool")} data-tip={text("收起", "Dismiss")} onClick={() => close(true)}><Icon name="x" extra="sm" /></button>
      </header>
      <div className="dock-group-body"><DockSlot id={active} /></div>
    </div>}
  </div>;
}

export function DockRail({ mode }: { mode: RailMode }) {
  const { scope, preview } = useDock();
  if (mode === "hidden") return null;
  return mode === "expanded" ? <ExpandedRail /> : <CompactRail key={scopeKey(scope, preview)} />;
}
export function DockRailToggle() {
  const { store, layout } = useDock();
  const text = useLabels();
  const visible = layout.rail.mode !== "hidden";
  return <button type="button" className={`dock-icon-button dock-rail-toggle${visible ? " is-active" : ""}`} data-dock-entry="rail"
    aria-label={text("对话工具区", "Conversation tools")} aria-pressed={visible} data-tip={text("对话工具区", "Conversation tools")}
    onClick={() => store.dispatch({ type: "region", region: "rail", visible: !visible })}><Icon name="columns" /></button>;
}

function FloatWindow({ group, bounds, order }: { group: DockFloat; bounds: DockRect; order: number }) {
  const { store, definitions, preferences } = useDock();
  const text = useLabels();
  const frame = useRef<HTMLDivElement>(null);
  const minHeight = Math.max(200, minimumBody(definitionFor(definitions, group.active)) + 78);
  const rect = group.maximized ? { x: 0, y: 0, width: bounds.width, height: bounds.height } : clampFloat(group.rect, { width: bounds.width, height: bounds.height }, minHeight);
  const resize = (event: ReactPointerEvent<HTMLElement>, direction: string) => {
    const element = frame.current;
    if (!element || preferences.locked || group.maximized) return;
    let next = rect;
    const previous = { left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height };
    const minW = Math.min(320, bounds.width), minH = Math.min(minHeight, bounds.height);
    beginDockResize(event, (dx, dy) => {
      const left = direction.includes("w") ? clamp(rect.x + dx, 0, rect.x + rect.width - minW) : rect.x;
      const top = direction.includes("n") ? clamp(rect.y + dy, 0, rect.y + rect.height - minH) : rect.y;
      const right = direction.includes("e") ? clamp(rect.x + rect.width + dx, rect.x + minW, bounds.width) : rect.x + rect.width;
      const bottom = direction.includes("s") ? clamp(rect.y + rect.height + dy, rect.y + minH, bounds.height) : rect.y + rect.height;
      next = { x: left, y: top, width: right - left, height: bottom - top };
      element.style.left = `${bounds.x + next.x}px`; element.style.top = `${bounds.y + next.y}px`;
      element.style.width = `${next.width}px`; element.style.height = `${next.height}px`;
    }, () => store.dispatch({ type: "float", groupId: group.id, rect: next }), () => Object.assign(element.style, previous));
  };
  const title = definitionFor(definitions, group.active).title;
  return <div className={`dock-float${group.maximized ? " is-maximized" : ""}`} ref={frame} role="region" aria-label={text(`${title} 浮窗`, `${title} floating window`)}
    tabIndex={-1} data-dock-float={group.id} data-dock-order={order} data-dock-focus-region={`float-${group.id}`}
    data-dock-group={group.id} data-dock-region="float"
    style={{ left: bounds.x + rect.x, top: bounds.y + rect.y, width: rect.width, height: rect.height, zIndex: 31 + order * 2 }}>
    <header className="dock-float-titlebar" onPointerDown={event => beginDockDrag(event, store, group.panels, group.id)}
      onDoubleClick={event => { if (!(event.target as Element).closest("button")) store.dispatch({ type: "float", groupId: group.id, maximized: !group.maximized }); }}>
      <span className="dock-float-title"><Icon name={definitionFor(definitions, group.active).icon} extra="sm" /><span>{title}</span>{group.panels.length > 1 && <span className="dock-count">{group.panels.length}</span>}</span>
      <button type="button" className="dock-icon-button" aria-label={text("最小化浮窗", "Minimize window")} data-tip={text("最小化", "Minimize")}
        onClick={() => store.dispatch({ type: "float", groupId: group.id, minimized: true })}><Icon name="minimize" extra="sm" /></button>
      <button type="button" className="dock-icon-button" aria-label={group.maximized ? text("还原浮窗", "Restore window") : text("最大化浮窗", "Maximize window")}
        data-tip={group.maximized ? text("还原", "Restore") : text("最大化", "Maximize")}
        onClick={() => store.dispatch({ type: "float", groupId: group.id, maximized: !group.maximized })}><Icon name={group.maximized ? "restore" : "maximize"} extra="sm" /></button>
      <button type="button" className="dock-icon-button" aria-label={text("隐藏整个浮窗", "Hide window group")} data-tip={text("隐藏整组", "Hide group")}
        onClick={() => store.dispatch({ type: "hide", panels: group.panels })}><Icon name="x" extra="sm" /></button>
    </header>
    <DockTabs group={group} region="float" />
    <div className="dock-group-body" id={`dock-body-${group.id}`} role="tabpanel" aria-labelledby={`dock-tab-${group.active}`}><DockSlot id={group.active} /></div>
    {!group.maximized && !preferences.locked && ["n", "e", "s", "w", "ne", "se", "sw", "nw"].map(direction => <div key={direction}
      className={`dock-float-resizer dock-float-resizer-${direction}`} onPointerDown={event => resize(event, direction)} aria-hidden="true" />)}
  </div>;
}

export function DockFloatingLayer() {
  const { layout, store } = useDock();
  const [bounds, setBounds] = useState<DockRect | null>(null);
  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>(".adaptive-workbench");
    if (!root) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const rect = root.getBoundingClientRect();
      const next = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      setBounds(previous => previous && previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(read); };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(root);
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, { attributes: true, attributeFilter: ["class", "style", "hidden", "inert"] });
    window.addEventListener("resize", schedule); document.addEventListener("scroll", schedule, true); read();
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); document.removeEventListener("scroll", schedule, true); };
  }, []);
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
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  return createPortal(<div className="dock-floating-layer">{layout.floats.map((group, order) => !group.minimized && <FloatWindow key={group.id} group={group} order={order} bounds={bounds} />)}</div>, document.body);
}

export function DockCapsules() {
  const { layout, store, definitions } = useDock();
  const text = useLabels();
  const root = useRef<HTMLDivElement>(null);
  const space = useConversationSpace(root);
  const minimized = layout.floats.filter(group => group.minimized);
  const capacity = Math.max(1, Math.floor(Math.max(0, space.width - 64) / 184)) * 2;
  const overflow = minimized.length > capacity;
  const displayed = overflow ? minimized.slice(0, Math.max(0, capacity - 1)) : minimized;
  const restore = (group: DockFloat) => store.dispatch({ type: "open", panel: group.active });
  return <div className="dock-capsules" ref={root} style={{ bottom: space.bottom, maxHeight: Math.max(32, Math.min(88, space.height)) }} hidden={!minimized.length}
    role="group" aria-label={text("已最小化的工具", "Minimized tools")}>
    {displayed.map(group => {
      const definition = definitionFor(definitions, group.active);
      return <button type="button" key={group.id} className="dock-capsule" data-tip={definition.title} onClick={() => restore(group)}
        aria-label={text(`还原 ${definition.title}${group.panels.length > 1 ? `（${group.panels.length} 个工具）` : ""}`, `Restore ${definition.title}${group.panels.length > 1 ? ` (${group.panels.length} tools)` : ""}`)}>
        <Icon name={definition.icon} extra="sm" /><span className="dock-capsule-title">{definition.title}</span>
        {group.panels.length > 1 && <span className="dock-count">{group.panels.length}</span>}<Icon name="restore" extra="sm" />
      </button>;
    })}
    {overflow && <AppSelect className="dock-capsule-overflow" value="" placeholder={text(`全部浮窗（${minimized.length}）`, `All windows (${minimized.length})`)}
      aria-label={text("还原最小化浮窗", "Restore minimized window")} onChange={event => {
        const group = minimized.find(item => item.id === event.target.value); if (group) restore(group);
      }}>{minimized.map(group => <option key={group.id} value={group.id}>{definitionFor(definitions, group.active).title}{group.panels.length > 1 ? ` (${group.panels.length})` : ""}</option>)}</AppSelect>}
  </div>;
}

/** Hosts live at the end of the document, so focus navigation follows their visual slots. */
export function DockKeyboard() {
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
