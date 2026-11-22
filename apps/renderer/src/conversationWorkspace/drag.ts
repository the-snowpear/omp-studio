import type { PointerEvent } from "react";
import { beginWindowDrag } from "../dock/windowDrag";
import type { DragPreview } from "../dock/dragPreview";
import { workbenchBounds } from "../dock/workbenchGeometry";
import { WindowSnapTracker, snapCells, type ConversationSnapTarget } from "./snap";
import { conversationKey, conversationVisible, MIN_VIEW, type ConversationRef } from "./model";
import type { ConversationWorkspaceStore } from "./store";
import { previewWindowLayout } from "../dock/windowProjection";
import { dockHitTest, previewBounds } from "../dock/gestures";
import { dockReducer } from "../dock/model";
import { conversationPanelId, type DockTarget } from "../dock/types";
import { measureCardPlacement, cardPlacementRect } from "../dock/cardDrag";
import { conversationDocument } from "./dom";
import { composerDropAt, type CapsuleOrigin, type ComposerDropTarget, type DroppedChip } from "../composer/composerDrop";
import { capsuleCaptions, hideCapsuleGhost, landCapsuleGhost, showCapsuleGhost } from "../composer/capsuleGhost";
import { sessionReferenceChip, type SessionReference } from "../composer/sessionReference";
import { MOTION_EASE, MOTION_MS, motionReduced } from "../motion";
import { findPreviewThread, previewSessionId } from "../preview/fixtures";
import type { WorkspaceId } from "@omp-studio/client-contract";

/** The session reference a conversation turns into when it is dropped on an input box. */
export function conversationReference(ref: ConversationRef, title: string, zh: boolean): SessionReference | null {
  const fixture = ref.previewThreadId ? findPreviewThread(ref.previewThreadId, zh) : undefined;
  const sessionId = ref.sessionId ?? (ref.previewThreadId && fixture && fixture.thread.msgs > 0 ? previewSessionId(ref.previewThreadId) : undefined);
  if (!sessionId || !ref.workspaceId) return null;
  return { sessionId, messages: [], source: {
    targetId: ref.targetId, workspaceId: ref.workspaceId as WorkspaceId, title,
    ...(ref.historyId ? { historyId: ref.historyId as NonNullable<SessionReference["source"]>["historyId"] } : {}),
    ...(ref.threadId ? { threadId: ref.threadId as NonNullable<SessionReference["source"]>["threadId"] } : {}),
    ...(ref.previewThreadId ? { previewThreadId: ref.previewThreadId } : {}),
  } };
}

/** Where a session capsule opens: only a capsule that knows its project can. */
export function referenceRef(reference: SessionReference): ConversationRef | null {
  const source = reference.source;
  if (!source) return null;
  return { targetId: source.targetId, workspaceId: source.workspaceId, sessionId: reference.sessionId,
    ...(source.threadId ? { threadId: source.threadId } : {}), ...(source.historyId ? { historyId: source.historyId } : {}), ...(source.previewThreadId ? { previewThreadId: source.previewThreadId } : {}) };
}

/** A window handed its content to the drag ghost; it comes back in place instead of popping. */
export function settleInPlace(element: HTMLElement | null | undefined) {
  if (!element || motionReduced() || typeof element.animate !== "function") return;
  element.ownerDocument.defaultView?.requestAnimationFrame(() => {
    element.animate([{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "none" }], { duration: MOTION_MS.slow, easing: MOTION_EASE.emphasis });
  });
}

/** `identity`: what the row's「复制会话 ID」carries, for rows whose ref has no session (preview stories). */
type ConversationDragSource = { viewId: string } | { ref: ConversationRef; title: string; identity?: SessionReference | undefined } | { reference: SessionReference; title: string; capsule: CapsuleOrigin };

export function dragConversation(event: PointerEvent<HTMLElement>, store: ConversationWorkspaceStore, input: ConversationDragSource, zh: boolean) {
  const captions = capsuleCaptions(zh);
  const capsule = "capsule" in input ? input.capsule : undefined;
  const capsuleRef = "reference" in input ? referenceRef(input.reference) : null;
  const source: { viewId: string } | { ref: ConversationRef; title: string } | null = "reference" in input ? (capsuleRef ? { ref: capsuleRef, title: input.title } : null) : input;
  const surface = event.currentTarget.ownerDocument;
  const canvas = surface.querySelector<HTMLElement>("[data-conversation-canvas]");
  if (!canvas) return;
  const box = canvas.getBoundingClientRect(), bounds = workbenchBounds(surface) ?? box;
  if (!bounds.width || !bounds.height) return;
  store.setGeometry(bounds, box);
  const view = !source ? undefined : "viewId" in source ? store.getSnapshot().views.find(view => view.id === source.viewId) : store.viewFor(source.ref);
  if (view?.placement === "native" && !capsule) { store.focus(view.id); return; }
  const record = view ? store.documentFor(view.id)! : undefined;
  const host = record && view?.placement !== "native" ? store.hosts.get(record.id) : undefined;
  const tools = host?.tools ?? (store.getSnapshot().activeDocumentId ? store.hosts.get(store.getSnapshot().activeDocumentId!).tools : undefined);
  if (!tools) return;
  // A locked layout still lets a conversation become a capsule; it only refuses to move windows.
  const locked = tools.store.getSnapshot().preferences.locked;
  const title = record?.title ?? (source && "title" in source ? source.title : "title" in input ? input.title : (zh ? "新对话" : "New conversation"));
  const reference = "reference" in input ? input.reference : "identity" in input && input.identity ? input.identity : conversationReference(record?.ref ?? (source && "ref" in source ? source.ref : { targetId: null }), title, zh);
  const chip: DroppedChip | null = capsule ? capsule.target.chipOf(capsule.element) : reference ? sessionReferenceChip(reference, zh) : null;
  const opens = !!source && !locked && !(capsule && view?.placement === "native");
  if (!opens && !chip) return;
  const moving = view && view.placement !== "native" ? view : undefined;
  const sourceId = moving?.id ?? "pending-conversation";
  const bodyFrame = moving ? surface.querySelector<HTMLElement>(`[data-conversation-view="${moving.id}"]`) : null;
  const frame = bodyFrame?.closest<HTMLElement>("[data-dock-card]") ?? bodyFrame;
  const measured = frame?.getBoundingClientRect();
  const sourceRect = measured?.width ? measured : moving?.placement === "float" ? { ...moving.rect, x: moving.rect.x + bounds.x, y: moving.rect.y + bounds.y } : box;
  const width = Math.min(bounds.width, Math.max(MIN_VIEW.width, moving?.rect.width ?? 760));
  const height = Math.min(bounds.height, Math.max(MIN_VIEW.height, moving?.rect.height ?? 600));
  const detached = !moving || moving.placement === "main" || moving.placement === "docked" || moving.maximized || store.snapCell(moving.id) !== undefined;
  const fromDirectory = !!event.currentTarget.closest("#projectList");
  const pointerGrab = fromDirectory || !!capsule;
  const grabX = pointerGrab ? Math.min(120, width / 2) : Math.max(0, Math.min(1, (event.clientX - sourceRect.x) / sourceRect.width)) * width;
  const grabY = pointerGrab ? 14 : Math.max(0, Math.min(28, event.clientY - sourceRect.y));
  const rect = detached || pointerGrab ? { x: event.clientX - bounds.x - grabX, y: event.clientY - bounds.y - grabY, width, height } : { x: sourceRect.x - bounds.x, y: sourceRect.y - bounds.y, width, height };
  const directory = event.currentTarget.closest("#projectList")?.getBoundingClientRect();
  const checkpoint = store.windows.checkpoint();
  const documentId = record?.id ?? (source && "ref" in source ? store.getSnapshot().documents.find(document => conversationKey(document.ref) === conversationKey(source.ref))?.id : undefined);
  const content: NonNullable<DragPreview["conversation"]> = { title, documentId, sourceElement: frame ?? undefined, attach: record && moving ? slots => store.hosts.preview(record.id, slots) : undefined, loadingLabel: zh ? "正在打开对话…" : "Opening conversation…" };
  let started = false, target: ConversationSnapTarget | null = null;
  let dockTarget: DockTarget | null = null;
  let composer: ComposerDropTarget | null = null;
  const panel = conversationPanelId(sourceId);
  const scoped = conversationDocument(surface, tools.store.documentId);
  const snapTracker = new WindowSnapTracker();
  let restorePreview = () => {};
  const finishCapsule = () => { composer?.hideCaret(); capsule?.element.classList.remove("is-drag-origin"); };
  /** Outside every input box while the window cannot open: the capsule stays and says why. */
  const stuck = () => (locked ? captions.locked : !source ? captions.unknown : captions.cancel);
  const gesture = beginWindowDrag(event, { rect, bounds, sourceRect, hosts: tools.hosts, layout: tools.store.getSnapshot().layout,
    conversation: content, panel, fromCapsule: !!capsule,
    valid: () => {
      const state = store.getSnapshot(), current = moving ? state.views.find(value => value.id === moving.id) : undefined;
      return (locked || !tools.store.getSnapshot().preferences.locked) && (!frame || frame.isConnected) && (!capsule || capsule.element.isConnected) && (!moving || !!current && current.placement !== "native" && conversationVisible(current, state));
    },
    subscribe: listener => { const release = store.subscribe(listener), releaseDock = tools.store.subscribe(listener); return () => { release(); releaseDock(); }; },
    onStart: () => { started = true; capsule?.element.classList.add("is-drag-origin"); if (moving && opens) store.activate(moving.id); },
    onCancel: () => {
      restorePreview(); store.cancelDrag = undefined;
      finishCapsule();
      if (capsule) landCapsuleGhost(surface, capsule.element); else hideCapsuleGhost(surface);
      if (started) store.windows.restoreCheckpoint(checkpoint);
    },
    project: (point, suspended) => {
      restorePreview(); restorePreview = () => {};
      dockTarget = null;
      target = null;
      const hovered = chip ? composerDropAt(surface, point, { documentId: moving ? record?.id : undefined, sessionId: reference?.sessionId }) : null;
      if (hovered !== composer) composer?.hideCaret();
      composer = hovered;
      if (composer && chip) {
        composer.showCaret(point);
        const caption = capsule && composer === capsule.target ? captions.move : captions.insert;
        const pill = showCapsuleGhost(surface, { kind: "session", label: chip.label, caption }, point);
        return { rect: pill, label: caption, key: "composer", capsule: { rect: pill } };
      }
      if (!opens) {
        const pill = showCapsuleGhost(surface, { kind: "session", label: title, caption: stuck(), muted: true }, point);
        return { rect: pill, label: stuck(), key: "capsule-stuck", capsule: { rect: pill } };
      }
      hideCapsuleGhost(surface);
      const snapshot = tools.store.getSnapshot();
      const hit = dockHitTest(point.x, point.y, snapshot.preferences.snap && !suspended, moving ? panel : undefined, snapshot.layout, scoped, tools.store.documentId, surface);
      if (hit && hit.target.region !== "rail" && (hit.target.region !== "float" || hit.target.groupId)) {
        dockTarget = hit.target;
        snapTracker.reset();
        const layout = moving ? snapshot.layout : { ...snapshot.layout, cards: { ...snapshot.layout.cards, [panel]: { collapsed: false, height: 400 } }, hidden: { ...snapshot.layout.hidden, [panel]: { region: "float" as const } } };
        const projected = dockReducer(layout, { type: "move", panels: [panel], target: dockTarget });
        const cards = dockTarget.region === "left" ? measureCardPlacement("left", projected, [panel], tools.hosts, [{ id: panel, title, icon: "message", initialHeight: 400, minHeight: 280 }], scoped) : undefined;
        const fallback = previewBounds(hit, projected, [panel], scoped, surface);
        return { rect: cards ? cardPlacementRect(cards, projected, [panel], fallback, scoped) : fallback, target: dockTarget, panels: [panel], layout: projected, cards, label: hit.label, key: JSON.stringify(dockTarget) };
      }
      const area = canvas.getBoundingClientRect();
      if (suspended || !tools.store.getSnapshot().preferences.snap) snapTracker.reset();
      target = !suspended && tools.store.getSnapshot().preferences.snap ? snapTracker.hit(point.x, point.y, area, store.getSnapshot().snap, !!store.manager.mainConversation(sourceId)) : null;
      if (!target) return null;
      if ("maximize" in target) return { rect: area, label: zh ? "最大化对话" : "Maximize conversation", key: "conversation-maximize" };
      const projected = store.manager.project(sourceId, target);
      restorePreview = previewWindowLayout(store.manager, projected, sourceId, surface);
      const candidate = projected.snap!;
      const size = store.manager.size(candidate);
      const cell = snapCells(target.template, candidate.tree, size)[target.cell]!;
      const viewport = canvas.querySelector<HTMLElement>(".cw-snap-viewport");
      return { rect: { ...cell, x: area.x + cell.x - (viewport?.scrollLeft ?? 0), y: area.y + cell.y - (viewport?.scrollTop ?? 0) }, label: zh ? "吸附对话" : "Snap conversation", key: `${target.template}:${target.cell}`, workspace: { manager: store.manager, layout: projected, sourceId } };
    },
    onDrop: (rect, point) => {
      restorePreview();
      store.cancelDrag = undefined;
      const into = composer;
      finishCapsule();
      if (into && chip) {
        // The conversation only lent its shape to the capsule: every window stays where it was.
        store.windows.restoreCheckpoint(checkpoint);
        const landed = capsule && into === capsule.target ? into.moveTo(capsule.element, point) : into.insertAt(chip, point);
        if (landed && capsule && into !== capsule.target) capsule.target.remove(capsule.chipId);
        landCapsuleGhost(surface, landed);
        if (moving) settleInPlace(frame);
        return;
      }
      const home = directory && point.x >= directory.left && point.x <= directory.right && point.y >= directory.top && point.y <= directory.bottom;
      if (!opens || home || !source) {
        if (capsule) landCapsuleGhost(surface, capsule.element); else hideCapsuleGhost(surface);
        store.windows.restoreCheckpoint(checkpoint);
        return;
      }
      hideCapsuleGhost(surface);
      const id = moving?.id ?? ("ref" in source ? store.open(source.ref, "float", rect) : undefined);
      if (!id) return;
      content.documentId = store.documentFor(id)!.id;
      store.manager.transaction(() => {
        if (dockTarget) store.dockPanel(id, dockTarget);
        else store.float(id, rect);
        if (!moving && "title" in source) store.updateDocument(store.documentFor(id)!.id, { title: source.title });
        if (target && "maximize" in target) store.manager.maximize(id);
        else if (target) store.manager.snap(id, target);
      });
      if (capsule) capsule.target.remove(capsule.chipId);
    },
  });
  store.cancelDrag = gesture ? () => gesture.cancel(false) : undefined;
  return gesture;
}
