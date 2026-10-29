import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DeferredPanel } from "../DeferredPanel";
import { DockStore } from "./store";
import { PanelHosts } from "./hosts";
import type { PanelDefinition, PanelId, PanelVisibility } from "./types";

const Context = createContext<{ store: DockStore; hosts: PanelHosts; definitions: readonly PanelDefinition[] } | null>(null);
export function DockProvider({ children, definitions, store }: { children: ReactNode; definitions: readonly PanelDefinition[]; store?: DockStore }) {
  const [value] = useState(() => ({ store: store ?? new DockStore(), hosts: new PanelHosts(), definitions }));
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => value.hosts.attach(layer.current!), [value]);
  return <Context.Provider value={value}>{children}{definitions.filter(definition => definition.render).map(definition => <DockPanel key={definition.id} id={definition.id}>{definition.render!}</DockPanel>)}<div className="dock-host-layer" ref={layer} /></Context.Provider>;
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
export function DockPanel({ id, children }: { id: PanelId; children: ReactNode | ((visibility: PanelVisibility) => ReactNode) }) {
  const { hosts } = useDockEngine();
  const host = hosts.get(id);
  const visibility = useSyncExternalStore(host.subscribe, host.snapshot);
  const mounted = useRef(false);
  if (visibility.visible) mounted.current = true;
  return mounted.current ? createPortal(<DeferredPanel>{typeof children === "function" ? children(visibility) : children}</DeferredPanel>, host.element, id) : null;
}
export function DockSlot({ id, height, className = "" }: { id: PanelId; height?: number; className?: string }) {
  const { hosts } = useDockEngine();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => hosts.slot(id, ref.current!), [hosts, id]);
  return <div className={`dock-slot ${className}`} data-dock-slot={id} ref={ref} style={height === undefined ? undefined : { height }} />;
}
