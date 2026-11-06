import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SurfaceProvider, useSurfaceDocument, surfaceWindow } from "../dock/SurfaceContext";
import type { ConversationDocument, ConversationView } from "./model";
import type { ConversationWorkspaceStore } from "./store";

export type SharedRegion = "title" | "navigation" | "sidebar" | "conversationTitle" | "right" | "bottom" | "bottomReveal" | "page" | "background";
export type WorkspaceContextValue = {
  store: ConversationWorkspaceStore;
  slots: Partial<Record<SharedRegion, HTMLElement>>;
  snapLayer: HTMLElement | null;
  /** The row holding the conversation tabs and the shared title; the top bar takes its size tier from this width. */
  titleRow: HTMLElement | null;
};
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export const ShellReadinessContext = createContext(true);
export const ConversationViewContext = createContext<{
  store: ConversationWorkspaceStore;
  document: ConversationDocument;
  view: ConversationView | undefined;
  active: boolean;
  visible: boolean;
  root: HTMLElement;
  surface: Document;
  header: { title: HTMLElement; actions: HTMLElement };
} | null>(null);
export const useConversationView = () => useContext(ConversationViewContext);
export const useConversationWorkspace = () => useContext(WorkspaceContext);
const noSubscribe = () => () => {};
export function useConversationLayoutLocked(workspace: ConversationWorkspaceStore, documentId?: string) {
  const store = documentId ? workspace.hosts.get(documentId).tools?.store : undefined;
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, () => store?.getSnapshot().preferences.locked ?? false);
}
/** No conversation in the main area: the top bar lists conversation tabs and each window shows its own breadcrumb. */
export function useAllWindowed() {
  const view = useConversationView(), workspace = useConversationWorkspace();
  const store = view?.store ?? workspace?.store;
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, () => store?.allWindowed() ?? false);
}

/** One visible slot; the source component and its tool portals stay mounted. */
export function SharedSurface({ region, children }: { region: SharedRegion; children: ReactNode }) {
  const workspace = useConversationWorkspace(), view = useConversationView();
  const ready = useContext(ShellReadinessContext);
  const host = useMemo(() => document.createElement("div"), []);
  host.className = `cw-shared-content cw-shared-${region}`;
  if (view) host.dataset.conversationOwner = view.document.id;
  host.inert = !ready && ["conversationTitle", "right", "bottom"].includes(region);
  host.setAttribute("aria-busy", String(!ready));
  const slot = workspace?.slots[region];
  const workbenchRegion = ["sidebar", "conversationTitle", "right", "bottom", "bottomReveal"].includes(region);
  const presented = view?.active && !(workbenchRegion && view.document.page);
  useLayoutEffect(() => {
    if (presented && slot) slot.append(host);
    else host.remove();
    return () => host.remove();
  }, [host, slot, presented]);
  if (!workspace) return children;
  return createPortal(<SurfaceProvider document={document}>{children}</SurfaceProvider>, host);
}

export function ConversationTitleSurface({ children }: { children: ReactNode }) {
  return <SharedSurface region="conversationTitle">{children}</SharedSurface>;
}

export function ConversationChromeSurface({ title, actions }: { title: ReactNode; actions: ReactNode }) {
  const view = useConversationView();
  if (!view) return null;
  return <>{createPortal(<SurfaceProvider document={view.surface}>{title}</SurfaceProvider>, view.header.title)}{createPortal(<SurfaceProvider document={view.surface}>{actions}</SurfaceProvider>, view.header.actions)}</>;
}

/** Existing shell hooks use a document-local selector and window-local events. */
export function useConversationDom() {
  const surface = useSurfaceDocument(), view = useConversationView();
  const latest = useRef({ surface, view }); latest.current = { surface, view };
  const registrations = useRef(new Map<EventListenerOrEventListenerObject, { type: string; options?: boolean | AddEventListenerOptions | undefined; wrapped: EventListener; targets: Window[] }>());
  const eventTargets = (type: string): Window[] => {
    const { surface, view } = latest.current;
    return type === "keydown" || type.startsWith("omp") ? [...new Set([surfaceWindow(surface), window, ...(view ? [surfaceWindow(view.surface)] : [])])] : [surfaceWindow(surface)];
  };
  const scoped = useMemo(() => {
    const scopedDocument = new Proxy(document, {
      get(_target, property) {
        const { surface, view } = latest.current;
        const roots = () => view ? [view.root, ...new Set([...surface.querySelectorAll<HTMLElement>(`[data-conversation-owner="${view.document.id}"]`), ...document.querySelectorAll<HTMLElement>(`[data-conversation-owner="${view.document.id}"]`)])] : [];
        if (view && property === "getElementById") return (id: string) => roots().map(root => root.querySelector(`#${id}`)).find(Boolean) ?? null;
        if (view && property === "querySelector") return (selector: string) => roots().map(root => root.querySelector(selector)).find(Boolean) ?? null;
        if (view && property === "querySelectorAll") return (selector: string) => [...new Set(roots().flatMap(root => [...root.querySelectorAll(selector)]))];
        const value = Reflect.get(surface, property, surface);
        return typeof value === "function" ? value.bind(surface) : value;
      },
    });
    const scopedWindow = new Proxy(window, {
      get(_target, property) {
        const target = surfaceWindow(latest.current.surface);
        if (property === "document") return scopedDocument;
        if (property === "addEventListener") return (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          const wrapped: EventListener = event => {
            const current = latest.current.view;
            if (current && (type === "keydown" || type.startsWith("omp"))) {
              const owner = (event as CustomEvent<{ documentId?: string }>).detail?.documentId;
              if (owner ? owner !== current.document.id : !current.active) return;
            }
            if (typeof listener === "function") listener(event); else listener.handleEvent(event);
          };
          const targets = eventTargets(type);
          registrations.current.set(listener, { type, options, wrapped, targets });
          for (const target of targets) target.addEventListener(type, wrapped, options);
        };
        if (property === "removeEventListener") return (_type: string, listener: EventListenerOrEventListenerObject) => {
          const registration = registrations.current.get(listener);
          if (registration) { for (const target of registration.targets) target.removeEventListener(registration.type, registration.wrapped, registration.options); registrations.current.delete(listener); }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { document: scopedDocument, window: scopedWindow as Window & typeof globalThis };
  }, []);
  useLayoutEffect(() => {
    for (const registration of registrations.current.values()) {
      const targets = eventTargets(registration.type);
      for (const target of registration.targets) if (!targets.includes(target)) target.removeEventListener(registration.type, registration.wrapped, registration.options);
      for (const target of targets) if (!registration.targets.includes(target)) target.addEventListener(registration.type, registration.wrapped, registration.options);
      registration.targets = targets;
    }
  }, [surface, view?.surface]);
  useLayoutEffect(() => () => { for (const registration of registrations.current.values()) for (const target of registration.targets) target.removeEventListener(registration.type, registration.wrapped, registration.options); registrations.current.clear(); }, []);
  return scoped;
}
