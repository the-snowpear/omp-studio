import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DeferredPanel } from "../DeferredPanel";
import { useI18n } from "../i18n";
import { DockStore } from "./store";
import { PanelHosts } from "./hosts";
import { DockDragPreview } from "./DockDragPreview";
import { DockMetersProvider } from "./panelMeters";
import { SurfaceProvider } from "./SurfaceContext";
import { locatePanel } from "./model";
import { isBrowserPagePanelId, isInstancePanelId, type DockLayout, type PanelDefinition, type PanelId, type PanelVisibility } from "./types";

export type AgentDockEntry = { agentId: string; name: string; model: string; status: string; tone: string; stale: boolean };
export type AgentDockCatalog = { scope: string; entries: readonly AgentDockEntry[]; open: (agentId: string) => void };
/** Live page tabs (title, site icon, state, close) supplied by the browser layer; the dock never imports it. */
export type BrowserPageDefinitions = readonly PanelDefinition[];
/** Site icons are data URLs; comparing them by value is cheap, serializing every update is not. */
function samePageDefinitions(a: BrowserPageDefinitions, b: BrowserPageDefinitions): boolean {
  return a.length === b.length && a.every((left, index) => {
    const right = b[index]!;
    return left.id === right.id && left.title === right.title && left.detail === right.detail && left.compactLabel === right.compactLabel
      && left.glyph?.image === right.glyph?.image && left.glyph?.state === right.glyph?.state && left.glyph?.label === right.glyph?.label
      && !left.close === !right.close && left.close?.pending === right.close?.pending && left.close?.label === right.close?.label && left.close?.tip === right.close?.tip;
  });
}
type DockEngine = { store: DockStore; hosts: PanelHosts; definitions: readonly PanelDefinition[]; conversationTitle?: string | undefined; agentCatalog: AgentDockCatalog | null; setAgentCatalog: (catalog: AgentDockCatalog | null) => void; setFileViewDefinitions: (definitions: BrowserPageDefinitions) => void; setBrowserPageDefinitions: (definitions: BrowserPageDefinitions) => void };
const Context = createContext<DockEngine | null>(null);
export function DockProvider({ children, definitions, store, ownerId, conversationTitle }: { children: ReactNode; definitions: readonly PanelDefinition[]; store?: DockStore; ownerId?: string; conversationTitle?: string }) {
  const { resolvedLanguage } = useI18n();
  const [engine] = useState(() => ({ store: store ?? new DockStore(), hosts: new PanelHosts() }));
  const snapshot = useSyncExternalStore(engine.store.subscribe, engine.store.getSnapshot);
  const [agentCatalog, setCatalog] = useState<AgentDockCatalog | null>(null);
  const setAgentCatalog = useCallback((next: AgentDockCatalog | null) => setCatalog(previous =>
    previous?.open === next?.open && JSON.stringify([previous?.scope, previous?.entries]) === JSON.stringify([next?.scope, next?.entries]) ? previous : next), []);
  const [fileDefinitions, setFileDefinitions] = useState<BrowserPageDefinitions>([]);
  const setFileViewDefinitions = useCallback((next: BrowserPageDefinitions) => setFileDefinitions(previous => samePageDefinitions(previous, next) ? previous : next), []);
  const [pageDefinitions, setPages] = useState<BrowserPageDefinitions>([]);
  // Definitions carry close callbacks; only a visible change (title, icon, state, pending) replaces them.
  const setBrowserPageDefinitions = useCallback((next: BrowserPageDefinitions) => setPages(previous => samePageDefinitions(previous, next) ? previous : next), []);
  const dynamicKey = JSON.stringify([snapshot.layout.agentPanels, agentCatalog?.scope, agentCatalog?.entries, snapshot.layout.browserPages, snapshot.layout.fileViews]);
  const allDefinitions = useMemo(() => [...definitions.map(definition => definition.id === "git-quick" && resolvedLanguage === "en" ? { ...definition, menuTitle: "Git Quick" } : definition.id === "context-viewer" && resolvedLanguage === "en" ? { ...definition, title: "Context viewer" } : definition), ...Object.entries(snapshot.layout.agentPanels).map(([id, descriptor]) => {
    const entry = descriptor.scope === agentCatalog?.scope ? agentCatalog.entries.find(item => item.agentId === descriptor.target.agentId) : undefined;
    const duplicates = entry && (agentCatalog?.entries.filter(item => item.name === entry.name).length ?? 0) > 1;
    const title = `${entry?.name ?? descriptor.target.displayName ?? descriptor.target.agentId}${duplicates ? ` · ${descriptor.target.agentId.slice(-5)}` : ""}`;
    return { id: id as PanelId, title, icon: "message" as const, initialHeight: 480, ...(entry ? { status: entry.tone, stale: entry.stale } : {}),
      compactLabel: (entry?.name ?? descriptor.target.displayName ?? descriptor.target.agentId).slice(0, 2), detail: entry ? `${title}\n${entry.status}\n${entry.model}` : descriptor.target.resolvedModel ? `${title}\n${resolvedLanguage === "zh" ? "最近记录模型" : "Last recorded model"}: ${descriptor.target.resolvedModel}` : title };
  }), ...Object.entries(snapshot.layout.browserPages).map(([id, descriptor]): PanelDefinition => pageDefinitions.find(definition => definition.id === id)
    ?? { id: id as PanelId, title: descriptor.title || "Browser", icon: "globe", initialHeight: 320, minHeight: 180, compactLabel: (descriptor.title || "Browser").slice(0, 2) }), ...Object.entries(snapshot.layout.fileViews ?? {}).map(([id, descriptor]): PanelDefinition => fileDefinitions.find(definition => definition.id === id) ?? { id: id as PanelId, title: descriptor.title, icon: "file" })], [definitions, dynamicKey, resolvedLanguage, pageDefinitions, fileDefinitions]);
  const value = useMemo(() => ({ ...engine, definitions: allDefinitions, conversationTitle, agentCatalog, setAgentCatalog, setFileViewDefinitions, setBrowserPageDefinitions }), [engine, allDefinitions, conversationTitle, agentCatalog, setAgentCatalog, setFileViewDefinitions, setBrowserPageDefinitions]);
  const layer = useRef<HTMLDivElement>(null);
  const localLayer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const detach = engine.hosts.attach(layer.current!); return () => { engine.store.flush(); detach(); }; }, [engine]);
  useLayoutEffect(() => { if (ownerId && localLayer.current) return engine.hosts.attachLocalLayer(localLayer.current); }, [engine, ownerId]);
  const hostLayer = <div className="dock-host-layer" data-conversation-owner={ownerId} ref={layer} />;
  return <Context.Provider value={value}><DockMetersProvider>{children}{definitions.filter(definition => definition.render).map(definition => <DockPanel key={definition.id} id={definition.id}>{definition.render!}</DockPanel>)}{ownerId ? <>{createPortal(hostLayer, document.body)}<div className="dock-host-layer" data-conversation-owner={ownerId} ref={localLayer} /></> : hostLayer}<DockDragPreview hosts={value.hosts} definitions={allDefinitions} {...(conversationTitle ? { conversationTitle } : {})} /></DockMetersProvider></Context.Provider>;
}
export function useDockEngine() {
  const value = useContext(Context);
  if (!value) throw new Error("DockProvider is required");
  return value;
}
const noSubscribe = () => () => {};
const noSnapshot = () => null;
export function useOptionalDock() {
  const engine = useContext(Context);
  const snapshot = useSyncExternalStore(engine?.store.subscribe ?? noSubscribe, engine?.store.getSnapshot ?? noSnapshot);
  return engine && snapshot ? { ...engine, ...snapshot } : null;
}
export function useDock() {
  const engine = useDockEngine();
  const snapshot = useSyncExternalStore(engine.store.subscribe, engine.store.getSnapshot);
  return { ...engine, ...snapshot };
}
/** Business content only needs Agent membership, not every drag-resize frame. */
export function useAgentDockLayout(): DockLayout {
  const { store } = useDockEngine();
  const cache = useRef<{ key: string; layout: DockLayout } | undefined>(undefined);
  const snapshot = useCallback(() => {
    const layout = store.getSnapshot().layout;
    const ids = Object.keys(layout.agentPanels) as PanelId[];
    const key = JSON.stringify([layout.agentPanels, layout.lastAgentPanel, ids.map(id => [!!locatePanel(layout, id), layout.floats.some(group => group.pin && group.panels.includes(id))])]);
    if (cache.current?.key !== key) cache.current = { key, layout };
    return cache.current.layout;
  }, [store]);
  return useSyncExternalStore(store.subscribe, snapshot);
}
/** Page tabs are business content too: membership changes only, never resize frames. */
export function useBrowserPagesLayout(): Pick<DockLayout, "browserPages" | "lastBrowserPage" | "floats"> & { placed: ReadonlySet<PanelId> } {
  const { store } = useDockEngine();
  const cache = useRef<{ key: string; value: Pick<DockLayout, "browserPages" | "lastBrowserPage" | "floats"> & { placed: ReadonlySet<PanelId> } } | undefined>(undefined);
  const snapshot = useCallback(() => {
    const layout = store.getSnapshot().layout;
    const ids = Object.keys(layout.browserPages) as PanelId[];
    const placed = ids.filter(id => locatePanel(layout, id));
    const pinned = layout.floats.filter(group => group.pin && group.panels.some(isBrowserPagePanelId)).map(group => [group.id, group.panels]);
    const key = JSON.stringify([layout.browserPages, layout.lastBrowserPage, placed, pinned]);
    if (cache.current?.key !== key) cache.current = { key, value: { browserPages: layout.browserPages, ...(layout.lastBrowserPage ? { lastBrowserPage: layout.lastBrowserPage } : {}), floats: layout.floats, placed: new Set(placed) } };
    return cache.current.value;
  }, [store]);
  return useSyncExternalStore(store.subscribe, snapshot);
}
export function DockPanel({ id, children }: { id: PanelId; children: ReactNode | ((visibility: PanelVisibility) => ReactNode) }) {
  const { hosts, store } = useDockEngine();
  const host = hosts.get(id);
  const visibility = useSyncExternalStore(host.subscribe, host.snapshot);
  const surface = useSyncExternalStore(host.subscribe, host.surfaceSnapshot);
  useLayoutEffect(() => () => { if (isInstancePanelId(id) && !store.isPinned(id)) hosts.release(id, host.element); }, [hosts, host.element, id, store]);
  const mounted = useRef(false);
  if (visibility.visible) mounted.current = true;
  return mounted.current ? createPortal(<SurfaceProvider document={surface}><DeferredPanel>{typeof children === "function" ? children(visibility) : children}</DeferredPanel></SurfaceProvider>, host.element, id) : null;
}
/** Left sections share a single heading with their business actions. */
export function DockToolbar({ id, children }: { id: PanelId; children: ReactNode }) {
  const { hosts } = useDockEngine();
  const host = hosts.get(id);
  const target = useSyncExternalStore(host.subscribe, host.toolbarSnapshot);
  return target ? createPortal(children, target) : children;
}
export function DockSlot({ id, height, className = "" }: { id: PanelId; height?: number; className?: string }) {
  const { hosts, definitions } = useDockEngine();
  const content = definitions.find(definition => definition.id === id)?.content;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => content ? content.attach(ref.current!, false) : hosts.slot(id, ref.current!), [hosts, id, content]);
  return <div className={`dock-slot ${className}`} data-dock-slot={id} ref={ref} onPointerDownCapture={content?.activate} onFocusCapture={content?.activate} style={height === undefined ? undefined : { height }} />;
}
