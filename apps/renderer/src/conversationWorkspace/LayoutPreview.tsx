import { useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ConversationPreview } from "../dock/DockDragPreview";
import { dragPreview, type DragPreview } from "../dock/dragPreview";
import { snapCells } from "../dock/snap";
import type { ConversationWorkspaceStore } from "./store";

export function ConversationLayoutPreview({ store }: { store: ConversationWorkspaceStore }) {
  const preview = useSyncExternalStore(dragPreview.subscribe, dragPreview.snapshot);
  const workspace = preview?.workspace?.manager === store.manager ? preview.workspace : undefined;
  const main = workspace ? store.manager.mainConversation(workspace.sourceId) : undefined;
  const source = main ? document.querySelector<HTMLElement>(`[data-conversation-view="${main.id}"]`) : null;
  const content = useMemo<NonNullable<DragPreview["conversation"]> | null>(() => main ? {
    title: main.title,
    documentId: main.content.documentId,
    sourceElement: source ?? undefined,
    attach: slots => store.hosts.preview(main.content.documentId, slots),
    loadingLabel: "",
  } : null, [store, main?.id, main?.content.documentId, main?.title, source]);
  const layout = workspace?.layout.snap;
  if (!main || !layout || !content) return null;
  const cell = Object.entries(layout.members).find(([, id]) => id === main.id)?.[0];
  if (cell === undefined) return null;
  const canvas = document.querySelector<HTMLElement>("[data-conversation-canvas]")!;
  const bounds = canvas.getBoundingClientRect(), viewport = canvas.querySelector<HTMLElement>(".cw-snap-viewport");
  const rect = snapCells(layout.template, layout.tree, workspace?.size ?? store.manager.size(layout))[Number(cell)]!;
  return createPortal(<div className="dock-layout-preview" aria-hidden="true" style={{ left: bounds.x + rect.x - (viewport?.scrollLeft ?? 0), top: bounds.y + rect.y - (viewport?.scrollTop ?? 0), width: rect.width, height: rect.height }}>
    <ConversationPreview content={content} rect={rect} />
  </div>, document.body);
}
