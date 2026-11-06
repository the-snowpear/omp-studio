import type { PointerEvent as ReactPointerEvent } from "react";
import { PLATFORM } from "../platform";

export type DragPoint = { x: number; y: number };
let activeDrag: (() => void) | null = null;

export function beginPointerDrag(event: ReactPointerEvent<HTMLElement>, options: {
  onStart?: () => void;
  onMove: (point: DragPoint, suspended: boolean) => boolean | void;
  onDrop: (point: DragPoint) => void;
  onCancel: () => void;
}) {
  activeDrag?.();
  const source = event.currentTarget;
  const originControl = (event.target as Element).closest("button, a, input, select, textarea");
  const surface = source.ownerDocument, view = surface.defaultView!;
  const start = { x: event.clientX, y: event.clientY };
  let point = start, moved = false, finished = false, frame = 0;
  let suspended = PLATFORM === "darwin" ? event.metaKey : event.ctrlKey;
  const paint = () => {
    frame = 0;
    if (finished || !moved) return;
    if (options.onMove(point, suspended) && !finished) schedule();
  };
  const schedule = () => { if (!frame && !finished) frame = view.requestAnimationFrame(paint); };
  const move = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId || finished) return;
    point = { x: next.clientX, y: next.clientY };
    suspended = PLATFORM === "darwin" ? next.metaKey : next.ctrlKey;
    if (!moved && Math.hypot(point.x - start.x, point.y - start.y) >= 6) {
      moved = true;
      surface.body.classList.add("dock-dragging");
      view.getSelection()?.removeAllRanges();
      options.onStart?.();
    }
    if (moved) { next.preventDefault(); schedule(); }
  };
  const cleanup = () => {
    finished = true;
    view.cancelAnimationFrame(frame); frame = 0;
    if (activeDrag === cancel) activeDrag = null;
    surface.body.classList.remove("dock-dragging");
    view.removeEventListener("pointermove", move); view.removeEventListener("pointerup", up);
    view.removeEventListener("pointercancel", cancel); view.removeEventListener("blur", cancel);
    view.removeEventListener("keydown", key, true); view.removeEventListener("keyup", key, true);
    if (moved) {
      const suppress = (click: MouseEvent) => {
        const target = click.target as Node;
        const control = (target as Element).closest?.("button, a, input, select, textarea");
        if (control && control !== originControl) return;
        if (source.contains(target) || target.contains(source)) { click.preventDefault(); click.stopImmediatePropagation(); }
      };
      view.addEventListener("click", suppress, { capture: true, once: true });
      view.setTimeout(() => view.removeEventListener("click", suppress, true), 0);
    }
  };
  const cancel = () => {
    if (finished) return;
    cleanup();
    options.onCancel();
  };
  const up = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId || finished) return;
    point = { x: next.clientX, y: next.clientY };
    suspended = PLATFORM === "darwin" ? next.metaKey : next.ctrlKey;
    if (moved) { view.cancelAnimationFrame(frame); paint(); }
    if (finished) return;
    cleanup();
    if (moved) options.onDrop(point);
    else options.onCancel();
  };
  const key = (next: KeyboardEvent) => {
    if (next.key === "Escape") { next.preventDefault(); next.stopImmediatePropagation(); cancel(); return; }
    suspended = PLATFORM === "darwin" ? next.metaKey : next.ctrlKey;
    schedule();
  };
  activeDrag = cancel;
  view.addEventListener("pointermove", move); view.addEventListener("pointerup", up);
  view.addEventListener("pointercancel", cancel); view.addEventListener("blur", cancel);
  view.addEventListener("keydown", key, true); view.addEventListener("keyup", key, true);
  return { cancel, schedule };
}
