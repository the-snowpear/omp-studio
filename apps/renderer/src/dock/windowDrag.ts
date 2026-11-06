import { flushSync } from "react-dom";
import type { PointerEvent as ReactPointerEvent } from "react";
import { clampFloat } from "./model";
import { beginPointerDrag, type DragPoint } from "./pointerDrag";
import { dragPreview, type DragPreview, type DragSource } from "./dragPreview";
import type { DockLayout, DockRect, DockTarget, PanelId } from "./types";
import type { PanelHosts } from "./hosts";

export type WindowDragProjection = { rect: DockRect; label: string; key: string; workspace?: DragPreview["workspace"]; target?: DockTarget; layout?: DockLayout; panels?: PanelId[]; cards?: DragPreview["cards"] };

export function beginWindowDrag(event: ReactPointerEvent<HTMLElement>, options: {
  rect: DockRect; bounds: DockRect; sourceRect: DockRect; hosts: PanelHosts; layout: DockLayout;
  conversation: NonNullable<DragPreview["conversation"]>;
  panel?: PanelId;
  valid: () => boolean; onStart: () => void; onCancel: () => void;
  subscribe: (listener: () => void) => () => void;
  project: (point: DragPoint, suspended: boolean) => WindowDragProjection | null;
  onDrop: (rect: DockRect, point: DragPoint, projection: WindowDragProjection | null) => void;
}) {
  if (event.button !== 0 || (event.target as Element).closest("button:not([data-window-drag]):not([data-dock-drag]), input, select, textarea, a, [contenteditable], [role=menu], [data-no-dock-drag]")) return;
  if (dragPreview.snapshot()?.settling) flushSync(() => dragPreview.show(null));
  const start = { x: event.clientX, y: event.clientY };
  const source: DragSource = { hosts: options.hosts, panels: options.panel ? [options.panel] : [], rect: options.sourceRect, snapped: !!options.conversation.sourceElement?.closest(".cw-main-conversation, .cw-snap-surface, [data-dock-card], [data-dock-region=right], [data-dock-region=bottom]"), cards: {} };
  let rect = options.rect, projection: WindowDragProjection | null = null;
  let synchronous = true, unsubscribe = () => {}, detach = () => {};
  const gesture = beginPointerDrag(event, {
    onStart: options.onStart,
    onMove: (point, suspended) => {
      if (!options.valid()) { gesture.cancel(); return; }
      rect = clampFloat({ ...options.rect, width: Math.max(360, options.rect.width), x: options.rect.x + point.x - start.x, y: options.rect.y + point.y - start.y }, { width: options.bounds.width, height: options.bounds.height }, 280);
      projection = options.project(point, suspended);
      const visibleRect = projection?.rect ?? { ...rect, x: options.bounds.x + rect.x, y: options.bounds.y + rect.y };
      flushSync(() => dragPreview.show({ kind: "conversation", source, hosts: options.hosts, layout: projection?.layout ?? options.layout, panels: projection?.panels ?? [], target: projection?.target ?? { region: "float", ...(projection ? { groupId: projection.key } : {}) }, rect: visibleRect, label: projection?.label ?? options.conversation.title, snapped: !!projection, conversation: options.conversation, ...(projection?.workspace ? { workspace: projection.workspace } : {}), ...(projection?.cards ? { cards: projection.cards } : {}) }));
    },
    onDrop: point => {
      unsubscribe(); detach();
      flushSync(() => options.onDrop(rect, point, projection));
      flushSync(() => { if (dragPreview.snapshot()?.source === source) dragPreview.settle(); });
      options.hosts.flush();
    },
    onCancel: () => {
      unsubscribe(); detach();
      const clear = () => { if (dragPreview.snapshot()?.source === source) dragPreview.show(null); };
      if (synchronous) flushSync(clear); else clear();
      options.onCancel();
      options.hosts.flush();
    },
  });
  const cancel = (flush = true) => { synchronous = flush; gesture.cancel(); };
  unsubscribe = options.subscribe(() => { if (!options.valid()) cancel(false); });
  detach = options.hosts.onDetach(() => cancel(false));
  return { cancel };
}
