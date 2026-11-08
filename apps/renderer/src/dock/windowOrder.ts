import { createContext, useContext, useId, useLayoutEffect, useSyncExternalStore } from "react";
import { useSurfaceDocument } from "./SurfaceContext";

type WindowRegistration = { ownerId: string | null; surface: Document; floating: boolean };
type WindowFocusSnapshot = { activeId: string | null; ownerId: string | null; order: readonly string[] };

export class WindowFocusStore {
  /** A workspace-owned file keeps the active conversation while taking keyboard focus. */
  resolveOwner?: (id: string, ownerId: string | null) => string | null;
  private registrations = new Map<string, WindowRegistration>();
  private recent: string[] = [];
  private history: { id: string; ownerId: string | null }[] = [];
  private surfaces = new Map<Document, { count: number; release: () => void }>();
  private listeners = new Set<() => void>();
  private state: WindowFocusSnapshot = { activeId: null, ownerId: null, order: [] };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  recentIds() { return [...this.history].reverse().map(entry => entry.id); }
  recentOwners() { return [...new Set([...this.history].reverse().map(entry => entry.ownerId))]; }
  checkpoint() { return { state: this.state, recent: [...this.recent], history: [...this.history] }; }
  restoreCheckpoint(checkpoint: ReturnType<WindowFocusStore["checkpoint"]>) {
    this.recent = checkpoint.recent;
    this.history = checkpoint.history;
    this.publish(checkpoint.state);
  }
  private publish(state: WindowFocusSnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  register(id: string, registration: WindowRegistration) {
    this.registrations.set(id, registration);
    const order = registration.floating ? !this.state.order.includes(id) ? [...this.state.order, id] : this.state.order : this.state.order.includes(id) ? this.state.order.filter(value => value !== id) : this.state.order;
    const ownerId = this.state.activeId === id ? this.resolveOwner?.(id, registration.ownerId) ?? registration.ownerId : this.state.ownerId;
    if (order !== this.state.order || ownerId !== this.state.ownerId) this.publish({ ...this.state, order, ownerId });
    return () => {
      if (this.registrations.get(id) !== registration) return;
      this.registrations.delete(id);
      queueMicrotask(() => {
        if (this.registrations.has(id)) return;
        this.forget(id);
      });
    };
  }
  activate(id: string, ownerId = this.registrations.get(id)?.ownerId) {
    if (ownerId === undefined) return;
    ownerId = this.resolveOwner?.(id, ownerId) ?? ownerId;
    const floating = this.registrations.get(id)?.floating ?? id.startsWith("conversation:");
    const order = floating ? [...this.state.order.filter(value => value !== id), id] : this.state.order;
    this.recent = [...this.recent.filter(value => value !== id), id];
    this.history = [...this.history.filter(value => value.id !== id), { id, ownerId }];
    if (this.state.activeId === id && this.state.ownerId === ownerId && (!floating || this.state.order.at(-1) === id)) return;
    this.publish({ activeId: id, ownerId, order });
  }
  forget(id: string) {
    this.registrations.delete(id);
    this.recent = this.recent.filter(value => value !== id);
    const order = this.state.order.filter(value => value !== id);
    if (this.state.activeId === id) {
      this.publish({ ...this.state, activeId: null, order });
      this.restore();
    } else if (order.length !== this.state.order.length) this.publish({ ...this.state, order });
  }
  restore() {
    const id = [...this.recent].reverse().find(value => this.registrations.has(value))
      ?? [...this.registrations].find(([, registration]) => !registration.floating)?.[0];
    if (id) this.activate(id);
    return id;
  }
  attach(surface: Document) {
    const previous = this.surfaces.get(surface);
    if (previous) { previous.count++; return () => this.detach(surface); }
    const focus = (event: Event) => {
      const target = event.target as Element | null;
      const id = target?.closest?.<HTMLElement>("[data-dock-window]")?.dataset.dockWindow;
      if (id) this.activate(id);
    };
    surface.addEventListener("pointerdown", focus, true);
    surface.addEventListener("focusin", focus, true);
    this.surfaces.set(surface, { count: 1, release: () => { surface.removeEventListener("pointerdown", focus, true); surface.removeEventListener("focusin", focus, true); } });
    return () => this.detach(surface);
  }
  private detach(surface: Document) {
    const entry = this.surfaces.get(surface)!;
    if (--entry.count === 0) { entry.release(); this.surfaces.delete(surface); }
  }
}

export const WindowFocusContext = createContext<WindowFocusStore | null>(null);
export const WindowOwnerContext = createContext<string | null>(null);
const standalone = new WeakMap<Document, WindowFocusStore>();
export function useWindowFocus() { return useContext(WindowFocusContext); }

export function useWindowOrder(order: number, options?: { id?: string | undefined; floating?: boolean; ownerId?: string | null; visible?: boolean }) {
  const surface = useSurfaceDocument(), generatedId = useId();
  const owner = useContext(WindowOwnerContext), shared = useWindowFocus();
  const id = options?.id ?? generatedId;
  if (!standalone.has(surface)) standalone.set(surface, new WindowFocusStore());
  const current = shared ?? standalone.get(surface)!;
  const ownerId = options?.ownerId ?? owner;
  const floating = options?.floating !== false;
  const visible = options?.visible !== false;
  useLayoutEffect(() => {
    if (!visible) return;
    const value = { surface, ownerId, floating };
    const release = current.register(id, value), detach = current.attach(surface);
    return () => { release(); detach(); };
  }, [current, id, ownerId, surface, floating, visible]);
  const state = useSyncExternalStore(current.subscribe, current.getSnapshot);
  const index = state.order.includes(id) ? state.order.indexOf(id) : order;
  return { id, index, active: state.activeId === id, raise: () => current.activate(id, ownerId) };
}
