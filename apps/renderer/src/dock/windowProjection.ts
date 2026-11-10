import { focusWindowId, type WorkbenchWindows, type WindowLayout } from "./windows";
import { snapCells } from "./snap";
import type { DockRect } from "./types";

export function previewWindowLayout(manager: WorkbenchWindows, layout: WindowLayout, sourceId: string, surface: Document, size?: Pick<DockRect, "width" | "height">) {
  if (!layout.snap) return () => {};
  const canvas = surface.querySelector<HTMLElement>("[data-conversation-canvas]");
  if (!canvas) return () => {};
  const bounds = canvas.getBoundingClientRect(), viewport = canvas.querySelector<HTMLElement>(".cw-snap-viewport");
  const cells = snapCells(layout.snap.template, layout.snap.tree, size ?? manager.size(layout.snap));
  const restore: Array<() => void> = [];
  for (const [cell, id] of Object.entries(layout.snap.members)) {
    if (id === sourceId) continue;
    const record = manager.get(id);
    if (!record || record.minimized || record.placement === "main") continue;
    const frame = surface.querySelector<HTMLElement>(`[data-dock-window="${focusWindowId(record)}"]`);
    if (!frame) continue;
    const previous = { position: frame.style.position, left: frame.style.left, top: frame.style.top, width: frame.style.width, height: frame.style.height };
    const rect = cells[Number(cell)]!;
    const parent = frame.closest<HTMLElement>(".cw-snap-surface");
    const origin = parent?.getBoundingClientRect();
    Object.assign(frame.style, { position: parent ? "absolute" : "fixed", left: `${bounds.x + rect.x - (viewport?.scrollLeft ?? 0) - (origin?.x ?? 0)}px`, top: `${bounds.y + rect.y - (viewport?.scrollTop ?? 0) - (origin?.y ?? 0)}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    restore.push(() => Object.assign(frame.style, previous));
  }
  return () => { for (const action of restore) action(); };
}
