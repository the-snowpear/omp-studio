import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { DockMeterRing, DockMeterSummary, usePanelMeter } from "./panelMeters";
import { transitionMs } from "../motion";
import { dragPreview, type DragPreview } from "./dragPreview";
import { locatePanel } from "./model";
import type { PanelHosts } from "./hosts";
import type { DockGroup, DockRect, PanelDefinition, PanelId, DockTarget, DockLayout } from "./types";
import { WindowFrame } from "./WindowFrame";
import { PanelGlyph, definitionFor } from "./panelChrome";
import { useI18n } from "../i18n";
import { floatTitle } from "./workbenchGeometry";
import { usesNaturalHeight } from "./cardDrag";

function PreviewSlot({ id, hosts, height, definition, autoHeight = false }: { id: PanelId; hosts: PanelHosts; height?: number; definition?: PanelDefinition; autoHeight?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const content = definition?.content;
  useLayoutEffect(() => content ? content.attach(ref.current!, true) : hosts.previewSlot(id, ref.current!, autoHeight), [hosts, id, content, autoHeight]);
  return <div className="dock-slot" data-dock-slot={id} ref={ref} style={height === undefined ? undefined : { height }} />;
}

function PreviewToolbar({ id, hosts, left = false }: { id: PanelId; hosts: PanelHosts; left?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => hosts.previewToolbar(id, left ? ref.current : null), [hosts, id, left]);
  return left ? <span className="dock-card-actions" ref={ref} /> : null;
}

function PreviewTitle({ panel, collapsed, rail }: { panel: PanelDefinition; collapsed: boolean; rail: boolean }) {
  const meter = usePanelMeter(panel.id);
  return <span className="dock-card-title">{rail ? <>
    <PanelGlyph definition={panel} /><span>{panel.title}</span><Icon name={collapsed ? "chevron-r" : "chevron-d"} extra="sm dock-card-chevron" />
    {collapsed && panel.meter && <DockMeterSummary meter={meter} />}
  </> : <><Icon name={collapsed ? "chevron-r" : "chevron-d"} extra="sm" /><PanelGlyph definition={panel} /><span>{panel.title}</span></>}</span>;
}

function PreviewIcon({ panel }: { panel: PanelDefinition }) {
  const meter = usePanelMeter(panel.id);
  return <span className={`dock-rail-icon${panel.meter ? " has-meter" : ""}`}>{panel.meter && <DockMeterRing meter={meter} />}<PanelGlyph definition={panel} size="" /></span>;
}

/** Chrome uses the same styles as its destination. Body geometry is borrowed by
 * the existing Portal host, so canvas, terminal input and scroll state stay live. */
export function DockDragPreview({ hosts, definitions, conversationTitle }: { hosts: PanelHosts; definitions: readonly PanelDefinition[]; conversationTitle?: string }) {
  const state = useSyncExternalStore(dragPreview.subscribe, dragPreview.snapshot);
  const preview = useRef<HTMLDivElement>(null);
  const motion = useRef<{ state: DragPreview | null; rect: DockRect | null; animation: Animation | null; frame: number; end: number }>({ state: null, rect: null, animation: null, frame: 0, end: 0 });
  useLayoutEffect(() => {
    const current = motion.current;
    const element = preview.current;
    const previous = current.state;
    if (!state || state.hosts !== hosts || !element) {
      cancelAnimationFrame(current.frame);
      current.animation?.cancel();
      current.state = null;
      current.rect = null;
      current.animation = null;
      current.frame = 0;
      hosts.flush();
      return;
    }
    const sameSource = previous?.source === state.source;
    const from = sameSource ? current.rect ?? previous.rect : state.source.rect;
    const destinationChanged = !sameSource ? state.snapped : (previous.snapped || state.snapped) && (
      previous.snapped !== state.snapped || previous.target.region !== state.target.region || previous.target.groupId !== state.target.groupId ||
      previous.target.index !== state.target.index || previous.target.split !== state.target.split || previous.snapKey !== state.snapKey
    );
    const rectChanged = !sameSource || Math.abs(previous.rect.x - state.rect.x) >= 0.5 || Math.abs(previous.rect.y - state.rect.y) >= 0.5 || Math.abs(previous.rect.width - state.rect.width) >= 0.5 || Math.abs(previous.rect.height - state.rect.height) >= 0.5;
    if (!state.snapped) {
      cancelAnimationFrame(current.frame);
      current.frame = 0;
      current.animation?.cancel();
      current.animation = null;
      element.style.removeProperty("transform");
      current.state = state;
      if (state.settling) dragPreview.show(null);
      else { hosts.flush(); current.rect = element.getBoundingClientRect(); }
      return;
    }
    current.state = state;
    if (state.settling) {
      if (!current.animation) dragPreview.show(null);
      return;
    }
    if (destinationChanged || (current.animation && rectChanged)) {
      const duration = destinationChanged ? transitionMs(element) : Math.max(0, current.end - performance.now());
      cancelAnimationFrame(current.frame);
      current.frame = 0;
      current.animation?.cancel();
      current.animation = null;
      if (duration > 1 && typeof element.animate === "function" && from.width > 0 && from.height > 0 && state.rect.width > 0 && state.rect.height > 0) {
        current.end = performance.now() + duration;
        const animation = element.animate([
          { transform: `translate(${from.x - state.rect.x}px, ${from.y - state.rect.y}px) scale(${from.width / state.rect.width}, ${from.height / state.rect.height})` },
          { transform: "none" },
        ], { duration, easing: getComputedStyle(element).transitionTimingFunction });
        current.animation = animation;
        // The real bodies live outside the preview; sample its animated slots in the same frame.
        const follow = () => {
          hosts.flush();
          current.rect = element.getBoundingClientRect();
          current.frame = current.animation === animation ? requestAnimationFrame(follow) : 0;
        };
        animation.onfinish = () => {
          if (current.animation !== animation) return;
          current.animation = null;
          cancelAnimationFrame(current.frame);
          current.frame = 0;
          hosts.flush();
          current.rect = element.getBoundingClientRect();
          if (current.state?.settling) dragPreview.show(null);
        };
        current.frame = requestAnimationFrame(follow);
      }
    }
    hosts.flush();
    current.rect = element.getBoundingClientRect();
  }, [hosts, state]);
  useLayoutEffect(() => () => {
    cancelAnimationFrame(motion.current.frame);
    motion.current.animation?.cancel();
    if (dragPreview.snapshot()?.hosts === hosts) dragPreview.show(null);
  }, [hosts]);
  if (!state || state.hosts !== hosts) return null;
  const { target, layout, panels, rect } = state;
  if (state.conversation) return createPortal(<div ref={preview} className={`dock-drag-preview${state.snapped ? " is-snapped" : ""}`} aria-hidden="true" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
    <ConversationPreview content={state.conversation} rect={rect} {...(panels.length ? { target, layout, panels, definitions } : {})} /><div className="dock-drag-label">{state.label}</div>
  </div>, document.body);
  const definition = (id: PanelId) => definitionFor(definitions, id);
  const cards = target.region === "left" || target.region === "rail";
  const leftRects = target.region === "left" ? state.cards?.rects : undefined;
  const lastLeftExpanded = [...layout.left.panels].reverse().find(id => !layout.cards[id]!.collapsed);
  const location = locatePanel(layout, panels[0]!);
  const groups = target.region === "right" || target.region === "bottom" ? layout[target.region].groups : layout.floats;
  const group: DockGroup = groups.find(item => item.id === location?.groupId) ?? { id: "drag", panels, active: panels[0]! };
  const title = definition(group.active);
  return createPortal(<div ref={preview} className={`dock-drag-preview${state.snapped ? " is-snapped" : ""}${leftRects ? " is-left-stack" : ""}`} aria-hidden="true"
    style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
    {state.cards?.icons ? <div className="dock-rail-icon-list">{panels.map(id => <PreviewIcon key={id} panel={definition(id)} />)}</div> : cards ? <div className={`dock-card-region dock-card-region-${target.region}`} data-dock-cards={target.region}>
      <div className="dock-card-list">
        {panels.map(id => {
          const panel = definition(id);
          const preference = layout.cards[id]!;
          const height = state.cards!.sizes[id]!.body;
          const placed = leftRects?.[id];
          return <section className={`dock-card${preference.collapsed ? " is-collapsed" : ""}`} key={id}
            style={placed ? { position: "absolute", left: placed.x - rect.x, top: placed.y - rect.y, width: placed.width, height: placed.height, minHeight: 0 } : undefined}>
            <header className="dock-card-header"><PreviewTitle panel={panel} collapsed={preference.collapsed} rail={target.region === "rail"} /><PreviewToolbar id={id} hosts={hosts} left={target.region === "left"} />{target.region === "left" && <span className="dock-icon-button"><Icon name="more" extra="sm" /></span>}</header>
            {!preference.collapsed && <div className="dock-card-body"><PreviewSlot id={id} hosts={hosts} height={height} definition={panel} autoHeight={target.region === "rail" && preference.height === null && usesNaturalHeight(id)} /></div>}
            {!preference.collapsed && (target.region !== "left" || id !== lastLeftExpanded) && <div className="dock-card-resizer" />}
          </section>;
        })}
      </div>
    </div> : <div className={`dock-preview-group${target.region === "float" ? " dock-float" : " dock-group"}`} data-dock-region={target.region}>
      {target.region === "float" && <header className="dock-float-titlebar"><span className="dock-float-title"><PanelGlyph definition={title} /><span>{floatTitle(title.title, conversationTitle)}</span></span><span className="dock-icon-button"><Icon name="minimize" extra="sm" /></span><span className="dock-icon-button"><Icon name="maximize" extra="sm" /></span><span className="dock-icon-button"><Icon name="x" extra="sm" /></span></header>}
      {(target.region !== "float" || group.panels.length > 1) && <div className="dock-tab-strip"><div className="dock-tabs">
        {group.panels.map(id => <div className={`dock-tab${id === group.active ? " is-active" : ""}`} key={id}><button type="button" className="dock-tab-label" tabIndex={-1}><PanelGlyph definition={definition(id)} /><span>{definition(id).title}</span></button><span className="dock-tab-close"><Icon name="x" extra="sm" /></span></div>)}
      </div><span className="dock-icon-button"><Icon name="chevron-d" extra="sm" /></span></div>}
      <div className="dock-group-body"><PreviewSlot id={group.active} hosts={hosts} definition={definition(group.active)} /></div>
      {panels.map(id => <PreviewToolbar id={id} hosts={hosts} key={id} />)}
    </div>}
    <div className="dock-drag-label">{state.label}</div>
  </div>, document.body);
}

export function ConversationPreview({ content, rect, target, layout, panels, definitions = [] }: { content: NonNullable<DragPreview["conversation"]>; rect: DockRect; target?: DockTarget; layout?: DockLayout; panels?: PanelId[]; definitions?: readonly PanelDefinition[] }) {
  const body = useRef<HTMLDivElement>(null), title = useRef<HTMLSpanElement>(null), actions = useRef<HTMLSpanElement>(null);
  const { resolvedLanguage } = useI18n();
  useLayoutEffect(() => {
    content.sourceElement?.classList.add("dock-drag-source");
    const release = content.attach?.({ element: body.current!, ...(!target ? { title: title.current!, actions: actions.current! } : {}) });
    return () => { release?.(); content.sourceElement?.classList.remove("dock-drag-source"); };
  }, [content, target?.region]);
  const bodySlot = <div className="dock-group-body"><div className="cw-view-content" ref={body}>{!content.attach ? <div className="empty" role="status">{content.loadingLabel}</div> : null}</div></div>;
  if (target?.region === "left") return <section className="dock-card-region dock-card-region-left"><div className="dock-card-list"><section className="dock-card dock-conversation-card">
    <header className="dock-card-header"><span className="dock-card-title"><Icon name="chevron-d" extra="sm" /><Icon name="message" extra="sm" /><span>{content.title}</span></span><span className="dock-icon-button"><Icon name="x" extra="sm" /></span><span className="dock-icon-button"><Icon name="more" extra="sm" /></span></header>
    {bodySlot}<div className="dock-card-resizer" />
  </section></div></section>;
  if (target && layout && panels) {
    const location = locatePanel(layout, panels[0]!);
    const groups = target.region === "right" || target.region === "bottom" ? layout[target.region].groups : layout.floats;
    const group = groups.find(group => group.id === location?.groupId);
    return <div className="dock-preview-group dock-group" data-dock-region={target.region}>
      <div className="dock-tab-strip"><div className="dock-tabs">{(group?.panels ?? panels).map(panel => <div className={`dock-tab${panels.includes(panel) ? " is-active" : ""}`} key={panel}>
        <span className="dock-tab-label"><Icon name={panels.includes(panel) ? "message" : definitionFor(definitions, panel).icon} extra="sm" /><span>{panels.includes(panel) ? content.title : definitionFor(definitions, panel).title}</span></span><span className="dock-tab-close"><Icon name="x" extra="sm" /></span>
      </div>)}</div><span className="dock-icon-button"><Icon name="plus" extra="sm" /></span></div>
      {bodySlot}
    </div>;
  }
  return <WindowFrame title={content.title} icon="message" preview rect={{ x: 0, y: 0, width: rect.width, height: rect.height }} bounds={{ x: 0, y: 0, width: rect.width, height: rect.height }}
    frameProps={{ className: "dock-preview-group dock-conversation-window", style: { position: "relative", zIndex: "auto" } }}
    titleContent={<span className="cw-window-title-slot" ref={title}>{!content.attach ? <><Icon name="message" extra="sm" /><span className="cw-window-title-text">{content.title}</span><Icon name="chevron-d" extra="sm" /></> : null}</span>}
    controls={<><span className="cw-window-actions-slot" ref={actions}>{!content.attach ? <><span className="dock-icon-button"><Icon name="tool-list" extra="sm" /></span><span className="dock-icon-button"><Icon name="more" extra="sm" /></span></> : null}</span><span className="dock-icon-button"><Icon name="pin" extra="sm" /></span></>}
    onRectChange={() => {}} onControl={() => {}} onClose={() => {}} closeLabel={resolvedLanguage === "zh" ? "关闭对话视图" : "Close conversation view"}>
    <div className="dock-group-body"><div className="cw-view-content" ref={body}>{!content.attach ? <div className="empty" role="status">{content.loadingLabel}</div> : null}</div></div>
  </WindowFrame>;
}
