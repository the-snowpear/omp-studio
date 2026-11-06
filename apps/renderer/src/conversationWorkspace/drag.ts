import type { PointerEvent } from "react";
import { beginWindowDrag } from "../dock/windowDrag";
import type { DragPreview } from "../dock/dragPreview";
import { workbenchBounds } from "../dock/workbenchGeometry";
import { WindowSnapTracker, snapCells, type ConversationSnapTarget } from "./snap";
import { conversationVisible, MIN_VIEW, type ConversationRef } from "./model";
import type { ConversationWorkspaceStore } from "./store";
import { previewWindowLayout } from "../dock/windowProjection";
import { dockHitTest, previewBounds } from "../dock/gestures";
import { dockReducer } from "../dock/model";
import { conversationPanelId, type DockTarget } from "../dock/types";
import { measureCardPlacement, cardPlacementRect } from "../dock/cardDrag";
import { conversationDocument } from "./dom";

export function dragConversation(event: PointerEvent<HTMLElement>, store: ConversationWorkspaceStore, source: { viewId: string } | { ref: ConversationRef; title: string }) {
  const surface = event.currentTarget.ownerDocument;
  const canvas = surface.querySelector<HTMLElement>("[data-conversation-canvas]");
  if (!canvas) return;
  const box = canvas.getBoundingClientRect(), bounds = workbenchBounds(surface) ?? box;
  if (!bounds.width || !bounds.height) return;
  store.setGeometry(bounds, box);
  const view = "viewId" in source ? store.getSnapshot().views.find(view => view.id === source.viewId) : store.viewFor(source.ref);
  if (view?.placement === "native") { store.focus(view.id); return; }
  const record = view ? store.documentFor(view.id)! : undefined;
  const host = record ? store.hosts.get(record.id) : undefined;
  const tools = host?.tools ?? (store.getSnapshot().activeDocumentId ? store.hosts.get(store.getSnapshot().activeDocumentId!).tools : undefined);
  if (!tools || tools.store.getSnapshot().preferences.locked) return;
  const title = record?.title ?? ("title" in source ? source.title : "新对话");
  const sourceId = view?.id ?? "pending-conversation";
  const bodyFrame = view ? surface.querySelector<HTMLElement>(`[data-conversation-view="${view.id}"]`) : null;
  const frame = bodyFrame?.closest<HTMLElement>("[data-dock-card]") ?? bodyFrame;
  const measured = frame?.getBoundingClientRect();
  const sourceRect = measured?.width ? measured : view?.placement === "float" ? { ...view.rect, x: view.rect.x + bounds.x, y: view.rect.y + bounds.y } : box;
  const width = Math.min(bounds.width, Math.max(MIN_VIEW.width, view?.rect.width ?? 760));
  const height = Math.min(bounds.height, Math.max(MIN_VIEW.height, view?.rect.height ?? 600));
  const detached = !view || view.placement === "main" || view.placement === "docked" || view.maximized || store.snapCell(view.id) !== undefined;
  const fromDirectory = !!event.currentTarget.closest("#projectList");
  const grabX = fromDirectory ? Math.min(120, width / 2) : Math.max(0, Math.min(1, (event.clientX - sourceRect.x) / sourceRect.width)) * width;
  const grabY = Math.max(0, Math.min(28, event.clientY - sourceRect.y));
  const rect = detached || fromDirectory ? { x: event.clientX - bounds.x - grabX, y: event.clientY - bounds.y - grabY, width, height } : { x: sourceRect.x - bounds.x, y: sourceRect.y - bounds.y, width, height };
  const directory = event.currentTarget.closest("#projectList")?.getBoundingClientRect();
  const checkpoint = store.windows.checkpoint();
  const content: NonNullable<DragPreview["conversation"]> = { title, documentId: record?.id, sourceElement: frame ?? undefined, attach: record ? slots => store.hosts.preview(record.id, slots) : undefined, loadingLabel: "正在打开对话…" };
  let started = false, target: ConversationSnapTarget | null = null;
  let dockTarget: DockTarget | null = null;
  const panel = conversationPanelId(sourceId);
  const scoped = conversationDocument(surface, tools.store.documentId);
  const snapTracker = new WindowSnapTracker();
  let restorePreview = () => {};
  const gesture = beginWindowDrag(event, { rect, bounds, sourceRect, hosts: tools.hosts, layout: tools.store.getSnapshot().layout,
    conversation: content, panel,
    valid: () => {
      const state = store.getSnapshot(), current = view ? state.views.find(value => value.id === view.id) : undefined;
      return !tools.store.getSnapshot().preferences.locked && (!frame || frame.isConnected) && (!view || !!current && current.placement !== "native" && conversationVisible(current, state));
    },
    subscribe: listener => { const release = store.subscribe(listener), releaseDock = tools.store.subscribe(listener); return () => { release(); releaseDock(); }; },
    onStart: () => { started = true; if (view) store.activate(view.id); },
    onCancel: () => { restorePreview(); store.cancelDrag = undefined; if (started) store.windows.restoreCheckpoint(checkpoint); },
    project: (point, suspended) => {
      restorePreview(); restorePreview = () => {};
      dockTarget = null;
      target = null;
      const snapshot = tools.store.getSnapshot();
      const hit = dockHitTest(point.x, point.y, snapshot.preferences.snap && !suspended, view ? panel : undefined, snapshot.layout, scoped, tools.store.documentId, surface);
      if (hit && hit.target.region !== "rail" && (hit.target.region !== "float" || hit.target.groupId)) {
        dockTarget = hit.target;
        snapTracker.reset();
        const layout = view ? snapshot.layout : { ...snapshot.layout, cards: { ...snapshot.layout.cards, [panel]: { collapsed: false, height: 400 } }, hidden: { ...snapshot.layout.hidden, [panel]: { region: "float" as const } } };
        const projected = dockReducer(layout, { type: "move", panels: [panel], target: dockTarget });
        const cards = dockTarget.region === "left" ? measureCardPlacement("left", projected, [panel], tools.hosts, [{ id: panel, title, icon: "message", initialHeight: 400, minHeight: 280 }], scoped) : undefined;
        const fallback = previewBounds(hit, projected, [panel], scoped, surface);
        return { rect: cards ? cardPlacementRect(cards, projected, [panel], fallback, scoped) : fallback, target: dockTarget, panels: [panel], layout: projected, cards, label: hit.label, key: JSON.stringify(dockTarget) };
      }
      const area = canvas.getBoundingClientRect();
      if (suspended || !tools.store.getSnapshot().preferences.snap) snapTracker.reset();
      target = !suspended && tools.store.getSnapshot().preferences.snap ? snapTracker.hit(point.x, point.y, area, store.getSnapshot().snap, !!store.manager.mainConversation(sourceId)) : null;
      if (!target) return null;
      if ("maximize" in target) return { rect: area, label: "最大化对话", key: "conversation-maximize" };
      const projected = store.manager.project(sourceId, target);
      restorePreview = previewWindowLayout(store.manager, projected, sourceId, surface);
      const candidate = projected.snap!;
      const size = store.manager.size(candidate);
      const cell = snapCells(target.template, candidate.tree, size)[target.cell]!;
      const viewport = canvas.querySelector<HTMLElement>(".cw-snap-viewport");
      return { rect: { ...cell, x: area.x + cell.x - (viewport?.scrollLeft ?? 0), y: area.y + cell.y - (viewport?.scrollTop ?? 0) }, label: "吸附对话", key: `${target.template}:${target.cell}`, workspace: { manager: store.manager, layout: projected, sourceId } };
    },
    onDrop: (rect, point) => {
      restorePreview();
      store.cancelDrag = undefined;
      if (directory && point.x >= directory.left && point.x <= directory.right && point.y >= directory.top && point.y <= directory.bottom) { store.windows.restoreCheckpoint(checkpoint); return; }
      const id = view?.id ?? ("ref" in source ? store.open(source.ref, "float", rect) : undefined);
      if (!id) return;
      content.documentId = store.documentFor(id)!.id;
      store.manager.transaction(() => {
        if (dockTarget) store.dockPanel(id, dockTarget);
        else store.float(id, rect);
        if (!view && "title" in source) store.updateDocument(store.documentFor(id)!.id, { title: source.title });
        if (target && "maximize" in target) store.manager.maximize(id);
        else if (target) store.manager.snap(id, target);
      });
    },
  });
  store.cancelDrag = gesture ? () => gesture.cancel(false) : undefined;
  return gesture;
}
