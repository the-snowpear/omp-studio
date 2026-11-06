import { useLayoutEffect, useRef, type RefObject } from "react";
import type { ManagedBrowserApi, ManagedBrowserPresentation } from "@omp-studio/studio-protocol";
import { surfaceWindow } from "../dock/SurfaceContext";

type Rectangle = ManagedBrowserPresentation["bounds"];
function intersect(first: Rectangle, second: Rectangle): Rectangle {
  const x = Math.max(first.x, second.x), y = Math.max(first.y, second.y);
  return { x, y, width: Math.max(0, Math.min(first.x + first.width, second.x + second.width) - x), height: Math.max(0, Math.min(first.y + first.height, second.y + second.height) - y) };
}
const GEOMETRY = ".dock-panel-content, .dock-host-layer, .adaptive-workbench, .dock-drag-preview, [data-dock-slot], [data-dock-region], [data-dock-group], [data-dock-float]";
const OVERLAY = "[role='menu'], .menu, .app-select-popup, dialog[open], [data-dock-modal], .modal-backdrop";

export function useBrowserPresentation(options: { api?: ManagedBrowserApi | undefined; document: Document; viewport: RefObject<HTMLDivElement | null>; sessionId: string; surfaceId: string; pageId: string | null; visible: boolean; onError(message: string): void }) {
  const current = useRef(options); current.current = options;
  const refresh = useRef(() => {});
  const queue = useRef<Promise<void>>(Promise.resolve());
  useLayoutEffect(() => {
    const api = options.api, element = options.viewport.current, document = options.document;
    // A hidden pane parks its page (the previous run's cleanup) and watches nothing.
    if (!api || !element || !options.visible) return;
    const view = surfaceWindow(document);
    let disposed = false, frame = 0, signature = "", revision = 0;
    let last: ManagedBrowserPresentation | undefined;
    let ancestors: Element[] = [];
    const send = (payload: ManagedBrowserPresentation) => {
      const generation = ++revision;
      queue.current = queue.current.then(async () => { if (payload.visible && (disposed || generation !== revision)) return; await api.present(payload); }).catch(error => { if (!disposed) current.current.onError(error instanceof Error ? error.message : String(error)); });
    };
    const schedule = () => { if (!disposed && !frame) frame = view.requestAnimationFrame(measure); };
    const resize = new view.ResizeObserver(schedule);
    const observer = new view.MutationObserver(records => {
      if (records.some(record => {
        const target = record.target as Element;
        if (record.type === "attributes") return ancestors.includes(target) || target.matches?.(`${GEOMETRY}, ${OVERLAY}`);
        return [...record.addedNodes, ...record.removedNodes].some(node => node instanceof view.Element && (node.contains(element) || node.matches(`${GEOMETRY}, ${OVERLAY}`) || node.querySelector(OVERLAY)));
      })) schedule();
    });
    function measure() {
      frame = 0;
      if (disposed) return;
      const chain: Element[] = [];
      for (let parent: Element | null = element!; parent; parent = parent.parentElement) chain.push(parent);
      if (chain.length !== ancestors.length || chain.some((parent, index) => parent !== ancestors[index])) { ancestors = chain; resize.disconnect(); ancestors.forEach(parent => resize.observe(parent)); }
      const bounds = element!.getBoundingClientRect();
      let clip = intersect(bounds, { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight });
      let visible = current.current.visible && element!.isConnected && !document.hidden;
      for (const parent of ancestors) {
        const css = view.getComputedStyle(parent), rect = parent.getBoundingClientRect();
        if (css.display === "none" || css.visibility === "hidden" || css.opacity === "0" || parent.hasAttribute("hidden") || parent.hasAttribute("inert") || parent.closest(".dock-drag-preview")) visible = false;
        const horizontal = /auto|scroll|hidden|clip/u.test(css.overflowX), vertical = /auto|scroll|hidden|clip/u.test(css.overflowY);
        if (horizontal || vertical) clip = intersect(clip, { x: horizontal ? rect.x : clip.x, y: vertical ? rect.y : clip.y, width: horizontal ? rect.width : clip.width, height: vertical ? rect.height : clip.height });
        const inset = /^inset\(([^)]*)\)/u.exec(css.clipPath);
        if (inset) {
          const values = inset[1]!.split(/\s+round\s+/u)[0]!.trim().split(/\s+/u);
          const length = (value: string, extent: number) => Number.parseFloat(value) * (value.endsWith("%") ? extent / 100 : 1);
          const top = length(values[0]!, rect.height), right = length(values[1] ?? values[0]!, rect.width), bottom = length(values[2] ?? values[0]!, rect.height), left = length(values[3] ?? values[1] ?? values[0]!, rect.width);
          if ([top, right, bottom, left].every(Number.isFinite)) clip = intersect(clip, { x: rect.x + left, y: rect.y + top, width: Math.max(0, rect.width - left - right), height: Math.max(0, rect.height - top - bottom) });
        }
      }
      if ([...document.querySelectorAll(OVERLAY)].some(overlay => { if (overlay.contains(element!)) return false; const css = view.getComputedStyle(overlay), overlap = intersect(clip, overlay.getBoundingClientRect()); return css.display !== "none" && css.visibility !== "hidden" && overlap.width > 0 && overlap.height > 0; })) visible = false;
      const key = new URL(document.URL).searchParams.get("dockHost");
      const payload: ManagedBrowserPresentation = { sessionId: options.sessionId, surfaceId: options.surfaceId, pageId: current.current.pageId, visible: visible && clip.width > 0 && clip.height > 0, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, clip, ...(key ? { windowKey: key } : {}) };
      const next = JSON.stringify(payload);
      if (signature !== next) { signature = next; last = payload; send(payload); }
      if (ancestors.some(parent => parent.getAnimations?.().some(animation => animation.playState === "running"))) schedule();
    }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "inert", "open", "data-dock-modal"] });
    document.addEventListener("scroll", schedule, true); document.addEventListener("visibilitychange", schedule); document.addEventListener("transitionrun", schedule, true); view.addEventListener("resize", schedule);
    refresh.current = schedule; measure();
    return () => { disposed = true; resize.disconnect(); observer.disconnect(); view.cancelAnimationFrame(frame); document.removeEventListener("scroll", schedule, true); document.removeEventListener("visibilitychange", schedule); document.removeEventListener("transitionrun", schedule, true); view.removeEventListener("resize", schedule); refresh.current = () => {}; if (last) send({ ...last, visible: false }); };
  }, [options.api, options.document, options.sessionId, options.surfaceId, options.viewport, options.visible]);
  useLayoutEffect(() => refresh.current(), [options.pageId, options.visible]);
}
