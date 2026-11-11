import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { closePanels } from "./panelChrome";
import { createPortal } from "react-dom";
import { TipHost } from "../TipHost";
import { useDockEngine } from "./DockContext";
import { FloatWindow } from "./DockRegions";
import { SurfaceProvider } from "./SurfaceContext";
import { registerConversationSurface } from "../conversation/conversationViews";
import type { DockFloat, DockRect } from "./types";
import { useWindowFocus } from "./windowOrder";
import { applyTheme } from "../themeTransition";
import { floatTitle, workbenchBounds } from "./workbenchGeometry";

/** Styles and root preferences stay in sync, including dev-server style updates. */
export function mirrorAppearance(target: Document, bodyClass = "dock-native-document"): () => void {
  const nodes = new Map<Element, Element>();
  // Preferences are shared; snapshot/flight flags belong to each document.
  const attributes = ["data-density", "data-palette", "data-platform", "data-perf-tier", "data-backdrop", "data-backdrop-scope", "data-preview", "data-preview-marks", "style", "lang", "dir"];
  let lastTheme: string | null | undefined;
  const sync = () => {
    const sourceRoot = document.documentElement;
    const targetRoot = target.documentElement;
    for (const name of attributes) {
      const value = sourceRoot.getAttribute(name);
      if (value === null) targetRoot.removeAttribute(name);
      else targetRoot.setAttribute(name, value);
    }
    const theme = sourceRoot.getAttribute("data-theme");
    if (theme !== lastTheme) {
      lastTheme = theme;
      if (theme === null) targetRoot.removeAttribute("data-theme");
      else applyTheme(targetRoot, theme);
    }
    target.body.className = bodyClass;
    const sources = new Set(document.head.querySelectorAll('style, link[rel="stylesheet"]'));
    for (const [source, clone] of nodes) if (!sources.has(source)) { clone.remove(); nodes.delete(source); }
    for (const source of sources) {
      let clone = nodes.get(source);
      if (!clone) { clone = source.cloneNode(true) as Element; clone.setAttribute("data-float-style", ""); target.head.append(clone); nodes.set(source, clone); }
      if (source.tagName === "STYLE" && clone.textContent !== source.textContent) clone.textContent = source.textContent;
    }
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes: true }); observer.observe(document.head, { subtree: true, childList: true, characterData: true });
  return () => { observer.disconnect(); for (const node of nodes.values()) node.remove(); };
}

export function waitForDocument(child: Window, key: string): Promise<Document> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (child.closed) { reject(new Error("Window closed while opening")); return; }
      if (Date.now() - started > 15000) { reject(new Error("Window did not finish loading")); return; }
      if (child.document.readyState === "complete" && child.document.getElementById("root") && new URL(child.location.href).searchParams.get("dockHost") === key) resolve(child.document);
      else setTimeout(check, 30);
    };
    check();
  });
}

/** Native tool and conversation windows share creation, appearance and lifecycle. */
export function NativeWindowHost({ id, title, rect, sourceRect, minimized, maximized, topmost, minimum, onSurface, onState, onClose, onError, onFocus, focusEvent, acceptsFocus, children }: {
  id: string; title: string; rect?: DockRect | undefined; sourceRect?: DockRect | undefined; minimized: boolean; maximized: boolean; topmost: boolean;
  minimum?: { width: number; height: number }; onSurface?: (document: Document) => () => void;
  onState: (state: { rect: DockRect; minimized: boolean; maximized: boolean }) => void; onClose: () => void; onError: (message: string) => void; onFocus?: () => void;
  focusEvent: string; acceptsFocus: (event: Event) => boolean;
  children: (surface: { doc: Document; key: string; bounds: DockRect }) => ReactNode;
}) {
  const current = useRef({ title, rect, sourceRect, minimized, maximized, topmost, minimum, onSurface, onState, onClose, onError, onFocus, acceptsFocus });
  current.current = { title, rect, sourceRect, minimized, maximized, topmost, minimum, onSurface, onState, onClose, onError, onFocus, acceptsFocus };
  const [surface, setSurface] = useState<{ doc: Document; key: string } | null>(null);
  const [bounds, setBounds] = useState<DockRect>({ x: 0, y: 0, width: 640, height: 560 });
  useEffect(() => {
    const api = globalThis.ompStudioChrome;
    if (!api?.prepareFloatWindow || !api.controlFloatWindow) return;
    let disposed = false, key: string | undefined, release: (() => void) | undefined, unstyle: (() => void) | undefined, unwatch: (() => void) | undefined;
    const open = async () => {
      try {
        const initial = current.current;
        const ticket = await api.prepareFloatWindow!({ id, title: initial.title, topmost: initial.topmost,
          ...(initial.rect ? { rect: initial.rect } : initial.sourceRect ? { sourceRect: initial.sourceRect } : {}),
          ...(initial.minimum ? { minWidth: initial.minimum.width, minHeight: initial.minimum.height } : {}), minimized: initial.minimized, maximized: initial.maximized });
        key = ticket.key;
        if (disposed) { await api.controlFloatWindow!({ key, action: "close" }); return; }
        const child = window.open(ticket.url, ticket.key);
        if (!child) throw new Error("Desktop window could not be opened");
        const doc = await waitForDocument(child, key);
        if (disposed) { await api.controlFloatWindow!({ key, action: "close" }); return; }
        doc.body.replaceChildren(); unstyle = mirrorAppearance(doc);
        const detachHosts = current.current.onSurface?.(doc), detachViews = registerConversationSurface(doc);
        const focus = () => current.current.onFocus?.(); child.addEventListener("focus", focus);
        release = () => { child.removeEventListener("focus", focus); detachHosts?.(); detachViews(); };
        unwatch = api.onFloatWindow?.(event => {
          if (event.key !== key || disposed) return;
          if (event.kind === "close-request") current.current.onClose();
          else if (event.kind === "state") current.current.onState(event);
        });
        setSurface({ doc, key });
      } catch (error) {
        if (key) void api.controlFloatWindow!({ key, action: "close" });
        if (!disposed) current.current.onError(error instanceof Error ? error.message : String(error));
      }
    };
    void open();
    return () => {
      disposed = true; unwatch?.(); release?.(); unstyle?.();
      if (key) { const closing = key; queueMicrotask(() => { void api.controlFloatWindow!({ key: closing, action: "close" }); }); }
    };
  }, [id]);
  useLayoutEffect(() => {
    if (!surface) return;
    const view = surface.doc.defaultView!;
    const resize = () => setBounds({ x: 0, y: 0, width: view.innerWidth, height: view.innerHeight });
    resize(); view.addEventListener("resize", resize);
    void globalThis.ompStudioChrome!.controlFloatWindow!({ key: surface.key, action: "ready" });
    return () => view.removeEventListener("resize", resize);
  }, [surface]);
  useEffect(() => { if (surface) void globalThis.ompStudioChrome!.controlFloatWindow!({ key: surface.key, action: "topmost", topmost }); }, [surface, topmost]);
  useEffect(() => { if (surface) surface.doc.title = title; }, [surface, title]);
  useEffect(() => {
    if (!surface) return;
    const open = (event: Event) => { if (current.current.acceptsFocus(event)) void globalThis.ompStudioChrome!.controlFloatWindow!({ key: surface.key, action: "focus" }); };
    window.addEventListener(focusEvent, open);
    return () => window.removeEventListener(focusEvent, open);
  }, [surface, focusEvent]);
  return surface ? createPortal(<SurfaceProvider document={surface.doc}>{children({ ...surface, bounds })}<TipHost /></SurfaceProvider>, surface.doc.body) : null;
}

export function NativeFloat({ group, namespace, onError }: { group: DockFloat; namespace: string; onError: (message: string) => void }) {
  const { store, hosts, definitions, conversationTitle } = useDockEngine();
  const windows = useWindowFocus();
  const area = workbenchBounds();
  const sourceRect = { ...group.rect, x: (area?.x ?? 0) + group.rect.x, y: (area?.y ?? 0) + group.rect.y };
  return <NativeWindowHost id={`${namespace}:${store.documentId ?? "standalone"}:${group.id}`} title={floatTitle(definitions.find(definition => definition.id === group.active)?.title ?? "OMP Studio", conversationTitle)}
    rect={group.pin?.windowRect} sourceRect={sourceRect} minimized={group.minimized} maximized={group.maximized} topmost={group.pin?.mode === "topmost"}
    onSurface={doc => hosts.attachWindow(doc)} onState={event => { store.setNativeState(group.id, event); if (event.minimized) windows?.forget(`tool:${store.documentId ?? "standalone"}:${group.id}`); hosts.flush(); }}
    onFocus={() => windows?.activate(`tool:${store.documentId ?? "standalone"}:${group.id}`, store.documentId ?? null)}
    onClose={() => closePanels(store, definitions, group.panels)}
    onError={message => { store.setPin(group.id, group.pin?.returnMode ?? "application"); onError(message); }}
    focusEvent="omp:dock-open" acceptsFocus={event => group.panels.includes((event as CustomEvent).detail.panel)}>
    {({ bounds, key }) => <FloatWindow group={group} order={0} bounds={bounds} nativeKey={key} />}
  </NativeWindowHost>;
}
