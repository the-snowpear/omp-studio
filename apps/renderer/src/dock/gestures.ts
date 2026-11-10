import { conversationDocument } from "../conversationWorkspace/dom";
import { measureWorkbenchLayout } from "../layout/useWorkbenchLayout";
import { flushSync } from "react-dom";
import type { PointerEvent as ReactPointerEvent } from "react";
import { toolWindowMinimum, type DockStore } from "./store";
import type { DockLayout, DockRect, DockTarget, PanelDefinition, PanelId } from "./types";
import { WORKBENCH_PANELS } from "../panels/registry";
import { beginPointerDrag } from "./pointerDrag";
import { workbenchBounds } from "./workbenchGeometry";
import { clampFloat, dockReducer, panelsAtDockTarget } from "./model";
import { dragPreview, type DragSource, type DragPreview } from "./dragPreview";
import type { PanelHosts } from "./hosts";
import { cardLayoutRect, cardList, cardPlacementRect, measureCardPlacement, type CardPlacement } from "./cardDrag";
import { snapCells, WindowSnapTracker, type WindowSnapTarget } from "./snap";
import { previewWindowLayout } from "./windowProjection";

const NAMES = { left: "左侧栏", rail: "对话工具区", right: "右侧栏", bottom: "底栏", float: "浮窗" };
const WINDOW_EDGE_WIDTH = 24;
const WINDOW_EDGE_DWELL = 160;
function railDropBounds(document: Document) {
  const rail = document.querySelector<HTMLElement>(".dock-rail-expanded, .dock-rail-compact");
  if (!rail || rail.closest('.dock-drag-preview, .dock-layout-preview')) return null;
  const rect = rail.getBoundingClientRect();
  const conversation = rail.closest(".convo-wrap")?.getBoundingClientRect();
  // Keep the outer edge available for window splitting, separate from cards.
  return new DOMRect(rect.left, rect.top, Math.max(rect.right, conversation ? conversation.right - WINDOW_EDGE_WIDTH : rect.right) - rect.left, rect.height);
}
function cardHit(list: HTMLElement, region: "left" | "rail", y: number, layout?: DockLayout) {
  const cards = [...list.querySelectorAll<HTMLElement>(":scope > [data-dock-card]")];
  const state = dragPreview.snapshot();
  const gap = cards.find(card => {
    const rect = cardLayoutRect(card);
    return card.classList.contains("dock-drag-source") && rect.height > 0 && y >= rect.top && y <= rect.bottom;
  });
  if (gap && state?.cards?.region === region) return { target: state.target, rect: cardLayoutRect(gap), label: `移入${NAMES[region]}` };
  const next = cards.filter(card => !card.classList.contains("dock-drag-source")).find(card => { const rect = cardLayoutRect(card); return y < rect.top + rect.height / 2; });
  const original = layout?.[region].panels ?? cards.map(card => card.dataset.dockCard as PanelId);
  const index = next ? original.indexOf(next.dataset.dockCard as PanelId) : original.length;
  const rect = next ? cardLayoutRect(next) : list.getBoundingClientRect();
  return { target: { region, index }, rect: new DOMRect(rect.left, next ? rect.top : rect.bottom - 3, rect.width, 3), label: next ? `插入 ${next.dataset.dockCard} 上方` : `移至${NAMES[region]}底部` };
}
export function dockHitTest(x: number, y: number, snap: boolean, ignoredFloat?: string, layout?: DockLayout, document: Document = globalThis.document, ownerId?: string, surface: Document = globalThis.document): { target: DockTarget; rect: DOMRect; label: string } | null {
  const hit = readDockTarget(x, y, snap, ignoredFloat, layout, document, ownerId, surface);
  return hit && ownerId ? { ...hit, target: { ...hit.target, ownerId } } : hit;
}
function readDockTarget(x: number, y: number, snap: boolean, ignoredFloat: string | undefined, layout: DockLayout | undefined, document: Document, ownerId: string | undefined, surface: Document): { target: DockTarget; rect: DOMRect; label: string } | null {
  const root = document.querySelector<HTMLElement>(".adaptive-workbench");
  const area = workbenchBounds(surface) ?? root?.getBoundingClientRect();
  if (!area) return null;
  const bounds = new DOMRect(area.x, area.y, area.width, area.height);
  const elementsAtPoint = () => {
    const backdrop = document.querySelector<HTMLElement>(".dock-modal-backdrop");
    const previous = backdrop?.style.pointerEvents;
    if (backdrop) backdrop.style.pointerEvents = "none";
    const elements = document.elementsFromPoint(x, y);
    if (backdrop) backdrop.style.pointerEvents = previous ?? "";
    return elements;
  };
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
  if (snap) {
    const elements = elementsAtPoint();
    let blocked = false;
    for (let element of elements) {
      if (element.closest('.dock-drag-preview, .dock-layout-preview, .dock-drag-source, .dock-panel-content.is-drag-preview')) continue;
      const owner = element.closest<HTMLElement>("[data-conversation-owner], [data-conversation-document]");
      const targetOwner = owner?.dataset.conversationOwner ?? owner?.dataset.conversationDocument;
      if (ownerId && targetOwner && targetOwner !== ownerId) { blocked = true; break; }
      if (ignoredFloat && element.closest<HTMLElement>('[data-dock-float]')?.dataset.dockFloat === ignoredFloat) continue;
      const host = element.closest<HTMLElement>('[data-panel]');
      if (host) element = document.querySelector<HTMLElement>(`[data-dock-slot="${host.dataset.panel}"]`) ?? element;
      if (ignoredFloat && element.closest<HTMLElement>('[data-dock-float]')?.dataset.dockFloat === ignoredFloat) continue;
      const entry = element.closest<HTMLElement>('[data-dock-entry]');
      if (entry) {
        const region = entry.dataset.dockEntry as DockTarget["region"];
        const list = region === "left" || region === "rail" ? cardList(region, document) : null;
        if (list) return cardHit(list, region as "left" | "rail", y, layout);
        return { target: { region }, rect: entry.getBoundingClientRect(), label: `移入${NAMES[region]}` };
      }
      const group = element.closest<HTMLElement>('[data-dock-group]');
      if (group) {
        const region = group.dataset.dockRegion as DockTarget["region"];
        const groupId = group.dataset.dockGroup!;
        if (groupId === ignoredFloat) continue;
        const rect = group.getBoundingClientRect();
        const tabs = [...group.querySelectorAll<HTMLElement>('[data-dock-tab]')];
        const bar = group.querySelector<HTMLElement>('.dock-tabs')?.getBoundingClientRect();
        if (bar && y >= bar.top && y <= bar.bottom) {
          const index = tabs.findIndex(tab => x < tab.getBoundingClientRect().left + tab.getBoundingClientRect().width / 2);
          const at = index < 0 ? tabs.length : index;
          const edge = at < tabs.length ? tabs[at]!.getBoundingClientRect().left : tabs.at(-1)?.getBoundingClientRect().right ?? bar.left;
          return { target: { region, groupId, index: at }, rect: new DOMRect(edge - 2, bar.top, 4, bar.height), label: `插入${NAMES[region]}标签` };
        }
        if (region === "right" || region === "bottom") {
          const container = group.closest<HTMLElement>('[data-dock-groups]')!;
          const regionRect = container.getBoundingClientRect();
          const pos = region === "right" ? y : x;
          const start = region === "right" ? regionRect.top : regionRect.left;
          const end = region === "right" ? regionRect.bottom : regionRect.right;
          if (pos - start < 24 || end - pos < 24) {
            const before = pos - start < 24;
            const groups = [...container.querySelectorAll<HTMLElement>(':scope > [data-dock-group]')];
            const existing = groups.length >= 2 ? groups[before ? 0 : 1] : undefined;
            const target: DockTarget = existing ? { region, groupId: existing.dataset.dockGroup! } : { region, split: before ? "before" : "after" };
            const highlight = region === "right" ? new DOMRect(regionRect.x, before ? regionRect.y : regionRect.y + regionRect.height / 2, regionRect.width, regionRect.height / 2) : new DOMRect(before ? regionRect.x : regionRect.x + regionRect.width / 2, regionRect.y, regionRect.width / 2, regionRect.height);
            return { target, rect: highlight, label: `加入${NAMES[region]}${region === "right" ? (before ? "上方" : "下方") : (before ? "左侧" : "右侧")}标签组` };
          }
        }
        return { target: { region, groupId }, rect, label: `加入${NAMES[region]}标签组` };
      }
      const cards = element.closest<HTMLElement>('[data-dock-cards]');
      if (cards) {
        const region = cards.dataset.dockCards as "left" | "rail";
        return cardHit(cardList(region, document) ?? cards, region, y, layout);
      }
      const empty = element.closest<HTMLElement>('[data-dock-empty]');
      if (empty) { const region = empty.dataset.dockEmpty as DockTarget["region"]; return { target: { region }, rect: empty.getBoundingClientRect(), label: `移入${NAMES[region]}` }; }
      if (element.closest(".dock-float, [data-conversation-view]")) {
        blocked = !ownerId || targetOwner !== ownerId || !!element.closest("[data-dock-float]");
        break;
      }
    }
    const railBox = !blocked ? railDropBounds(document) : null;
    if (railBox && x >= railBox.left && x <= railBox.right && y >= railBox.top && y <= railBox.bottom) {
      const list = cardList("rail", document);
      if (list) return cardHit(list, "rail", y, layout);
    }
    const sidebar = !blocked ? document.querySelector<HTMLElement>('.sidebar:not(.collapsed)') : null;
    if (sidebar && !sidebar.closest('[hidden], [inert]') && sidebar.getClientRects().length) {
      const rect = sidebar.getBoundingClientRect();
      const css = getComputedStyle(sidebar);
      if (css.display !== "none" && css.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return { target: { region: "left" }, rect, label: "吸附到左侧栏底部" };
      }
    }
  }
  return { target: { region: "float", rect: { x: x - bounds.left - 160, y: y - bounds.top - 18, width: 480, height: 360 } }, rect: new DOMRect(Math.max(bounds.left, Math.min(x - 160, bounds.right - Math.min(480, bounds.width))), Math.max(bounds.top, Math.min(y - 18, bounds.bottom - Math.min(360, bounds.height))), Math.min(480, bounds.width), Math.min(360, bounds.height)), label: "作为浮窗" };
}

export function previewBounds(hit: NonNullable<ReturnType<typeof dockHitTest>>, layout: DockLayout, panels: PanelId[], document: Document = globalThis.document, surface: Document = globalThis.document): DockRect {
  const area = workbenchBounds(surface)!;
  const root = new DOMRect(area.x, area.y, area.width, area.height);
  const { target } = hit;
  if (target.region === "float" && !target.groupId) {
    const rect = target.rect!;
    return { ...rect, x: root.left + rect.x, y: root.top + rect.y };
  }
  if (target.groupId && !target.split) {
    const group = document.querySelector<HTMLElement>(`[data-dock-group="${target.groupId}"]`);
    if (group && !(target.region === "bottom" && group.closest(".is-folded"))) return group.getBoundingClientRect();
  }
  if (target.region === "left") {
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    const projects = sidebar?.querySelector<HTMLElement>('#sbProjects');
    if (sidebar && projects) {
      const list = sidebar.querySelector<HTMLElement>('[data-dock-cards="left"]');
      const box = list?.getBoundingClientRect();
      const sidebarBox = sidebar.getBoundingClientRect();
      const projectBox = projects.getBoundingClientRect();
      const css = getComputedStyle(sidebar);
      const footerHeight = sidebar.querySelector<HTMLElement>('.sb-footer')?.getBoundingClientRect().height ?? 0;
      const bottom = sidebarBox.bottom - footerHeight - (Number.parseFloat(css.borderBottomWidth) || 0) - (Number.parseFloat(css.paddingBottom) || 0);
      const divider = sidebar.querySelector<HTMLElement>('#sbDivider');
      const dividerHeight = divider ? Number.parseFloat(getComputedStyle(divider).height) || 0 : 0;
      const expanded = box && box.height > 0 && !list?.closest('.is-folded');
      const available = Math.max(0, (bottom - projectBox.top - dividerHeight) * (1 - layout.left.ratio));
      const area = expanded ? box : new DOMRect(projectBox.left, bottom - available, projectBox.width, available);
      if (layout.left.panels.length === 1 && !layout.cards[panels[0]!]!.collapsed) return area;
      const height = Math.min(area.height, panels.reduce((sum, id) => sum + 38 + (layout.cards[id]!.collapsed ? 0 : layout.cards[id]!.height ?? Math.max(80, document.querySelector<HTMLElement>(`[data-dock-slot="${id}"]`)?.getBoundingClientRect().height || 280)), 0));
      const y = hit.rect.height <= 4 ? hit.rect.top : area.bottom - height;
      return { x: area.left, y: Math.max(area.top, Math.min(y, area.bottom - height)), width: area.width, height };
    }
  }
  if (target.region === "left") {
    const list = document.querySelector<HTMLElement>(`[data-dock-cards="${target.region}"]`);
    const box = list?.getBoundingClientRect();
    const convo = document.querySelector<HTMLElement>(".convo-wrap")?.getBoundingClientRect() ?? root;
    const width = box && box.width > 80 ? box.width : target.region === "left" ? layout.left.width : layout.rail.width;
    const x = box && box.width > 80 ? box.left : target.region === "left" ? root.left : convo.right - width - 12;
    const height = panels.reduce((sum, id) => sum + 38 + (layout.cards[id]!.collapsed ? 0 : layout.cards[id]!.height ?? Math.max(80, document.querySelector<HTMLElement>(`[data-dock-slot="${id}"]`)?.getBoundingClientRect().height || 280)), 0);
    const top = box && box.height > 0 ? box.top : convo.top + 8;
    const bottom = box && box.height > 0 ? box.bottom : convo.bottom - 12;
    const padding = 0;
    const y = hit.rect.height <= 4 ? hit.rect.top : top;
    return { x: x + padding, y: Math.max(top, Math.min(y, bottom - Math.min(height, bottom - top))), width: width - padding * 2, height: Math.min(height, bottom - top) };
  }
  // Hidden region buttons name destinations but aren't the destination's geometry.
  if (hit.rect.width < 80 || hit.rect.height < 48) {
    const workbench = surface.querySelector<HTMLElement>(".cw-workbench")?.getBoundingClientRect() ?? root;
    const main = surface.querySelector<HTMLElement>(".cw-shell-main")?.getBoundingClientRect() ?? root;
    if (target.region === "right") {
      const visible = surface.querySelector<HTMLElement>(".cw-right-slot")?.getBoundingClientRect();
      const width = visible?.width || Math.min(layout.right.size, workbench.width);
      return { x: workbench.right - width, y: workbench.top, width, height: workbench.height };
    }
    if (target.region === "bottom") {
      const height = Math.min(layout.bottom.size, main.height);
      return { x: main.left, y: main.bottom - height, width: main.width, height };
    }
  }
  return hit.rect;
}

export function beginDockDrag(event: ReactPointerEvent<HTMLElement>, store: DockStore, panels: PanelId[], floatingId: string | undefined, hosts: PanelHosts, definitions: readonly PanelDefinition[] = WORKBENCH_PANELS) {
  if (event.button !== 0 || store.getSnapshot().preferences.locked) return;
  if ((event.target as Element).closest('button:not([data-dock-drag]), input, select, textarea, [data-no-dock-drag]')) return;
  const source = event.currentTarget;
  const document = conversationDocument(source.ownerDocument, store.documentId);
  const surface = source.ownerDocument;
  if (dragPreview.snapshot()?.settling) flushSync(() => dragPreview.show(null));
  const sourceRect = (source.closest<HTMLElement>('[data-dock-card], [data-dock-group], [data-dock-float]') ?? source).getBoundingClientRect();
  const sourceCards = [...document.querySelectorAll<HTMLElement>('.adaptive-workbench .dock-card-list > [data-dock-card], .adaptive-workbench .dock-rail-icon-list > [data-dock-card]')];
  const sourceRail = railDropBounds(document);
  const dragSource: DragSource = {
    hosts, panels, rect: sourceRect, snapped: !source.closest('[data-dock-float]'),
    cards: Object.fromEntries(sourceCards.map(card => [card.dataset.dockCard, card.getBoundingClientRect()])),
  };
  const possiblePanels = panels.includes("git") ? [...panels, "git-quick" as PanelId] : panels;
  const scope = store.getSnapshot().scope;
  const previewMode = store.getSnapshot().preview;
  const start = { x: event.clientX, y: event.clientY };
  const sourceFloat = floatingId ? source.closest<HTMLElement>('[data-dock-float]')?.getBoundingClientRect() : null;
  const sourceGroup = store.getSnapshot().layout.floats.find(group => group.id === floatingId);
  const wholeWindow = sourceGroup?.panels.length === panels.length && sourceGroup.panels.every(panel => panels.includes(panel));
  let point = start, suspended = false;
  let hit: ReturnType<typeof dockHitTest> = null;
  let windowTarget: WindowSnapTarget | null = null;
  const snapTracker = new WindowSnapTracker();
  let edgeAnchor: typeof start | null = null, edgeSince = 0, edgeTimer = 0, edgeArmed = false;
  const resetEdge = () => { edgeAnchor = null; edgeArmed = false; surface.defaultView!.clearTimeout(edgeTimer); edgeTimer = 0; };
  let restoreWindowPreview = () => {};
  let projected: DockLayout | null = null, projectionKey = "";
  let cardPlacement: CardPlacement | undefined;
  let contentChanged = false;
  const contentObserver = new MutationObserver(() => {
    if (cardPlacement) { contentChanged = true; gesture.schedule(); }
  });
  // Reused content can be mounted but hidden before the preview borrows it.
  for (const id of possiblePanels) contentObserver.observe(hosts.get(id).element, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
  let finished = false;
  let synchronous = true;
  let unsubscribe = () => {}, detach = () => {};
  const update = () => {
    restoreWindowPreview(); restoreWindowPreview = () => {};
    if (finished) return;
    const snapshot = store.getSnapshot();
    if (!source.isConnected || snapshot.scope !== scope || snapshot.preview !== previewMode) { cancel(); return; }
    const manager = store.windowManager;
    const canvas = surface.querySelector<HTMLElement>("[data-conversation-canvas]");
    const box = canvas?.getBoundingClientRect();
    const atRailEdge = sourceRail && box && point.x >= box.right - WINDOW_EDGE_WIDTH && point.x <= box.right + 24 && point.y >= sourceRail.top && point.y <= sourceRail.bottom;
    if (dragPreview.snapshot()?.workspace && sourceRail && !atRailEdge && point.x >= sourceRail.left && point.x <= sourceRail.right && point.y >= sourceRail.top && point.y <= sourceRail.bottom) {
      const top = surface.elementsFromPoint(point.x, point.y).find(element => !element.closest('.dock-drag-preview, .dock-layout-preview, .dock-drag-source, .dock-panel-content.is-drag-preview'));
      const owner = top?.closest<HTMLElement>("[data-conversation-owner], [data-conversation-document]");
      const targetOwner = owner?.dataset.conversationOwner ?? owner?.dataset.conversationDocument;
      if (!targetOwner || targetOwner === store.documentId) {
        flushSync(() => dragPreview.show(null));
        flushSync(() => measureWorkbenchLayout(document.querySelector<HTMLElement>(".adaptive-workbench")));
      }
    }
    hit = dockHitTest(point.x, point.y, store.getSnapshot().preferences.snap && !suspended, floatingId, snapshot.layout, document, store.documentId, surface);
    let workspace: DragPreview["workspace"];
    windowTarget = null;
    if (manager && canvas && box && snapshot.preferences.snap && !suspended) {
      const area = workbenchBounds(surface)!;
      manager.geometry = { workbench: area, canvas: { x: box.x, y: box.y, width: box.width, height: box.height } };
      const id = store.windowId(wholeWindow ? floatingId! : "pending");
      const edgeRail = atRailEdge && hit?.target.region === "rail";
      if (hit && (hit.target.region !== "float" || hit.target.groupId) && !edgeRail) snapTracker.reset();
      else windowTarget = snapTracker.hit(point.x, point.y, box, manager.getSnapshot().snap, !!manager.mainConversation(id));
      if (windowTarget && atRailEdge) {
        // The wider edge overlaps the rail: it becomes a window destination
        // after a dwell, and stays selected while moving inside that edge.
        if (edgeRail) hit = dockHitTest(point.x, point.y, false, floatingId, snapshot.layout, document, store.documentId, surface);
        if (!edgeAnchor || (!edgeArmed && (point.x !== edgeAnchor.x || point.y !== edgeAnchor.y))) {
          resetEdge(); edgeAnchor = point; edgeSince = performance.now();
          edgeTimer = surface.defaultView!.setTimeout(() => gesture.schedule(), WINDOW_EDGE_DWELL);
        }
        if (performance.now() - edgeSince < WINDOW_EDGE_DWELL) {
          windowTarget = null;
          if (hit) hit.label = "停留以吸附到右侧分栏";
        } else edgeArmed = true;
      } else resetEdge();
      if (windowTarget) {
        const projection = "maximize" in windowTarget ? null : manager.project(id, windowTarget);
        const candidate = projection?.snap;
        const sourceGroups = [...snapshot.layout.right.groups, ...snapshot.layout.bottom.groups, ...snapshot.layout.floats];
        const sourceGroup = sourceGroups.find(group => panels.every(panel => group.panels.includes(panel)));
        const active = sourceGroup && panels.includes(sourceGroup.active) ? sourceGroup.active : panels[0]!;
        const size = candidate && !("maximize" in windowTarget)
          ? manager.size(candidate, { [windowTarget.cell]: manager.get(id)?.minimum ?? toolWindowMinimum(active, panels.length) })
          : undefined;
        if (projection) {
          restoreWindowPreview = previewWindowLayout(manager, projection, id, surface, size);
          workspace = { manager, layout: projection, sourceId: id, ...(size ? { size } : {}) };
        }
        const rect = candidate && size && !("maximize" in windowTarget) ? snapCells(candidate.template, candidate.tree, size)[windowTarget.cell]! : { ...manager.geometry.canvas, x: 0, y: 0 };
        const viewport = canvas.querySelector<HTMLElement>(".cw-snap-viewport");
        const visibleRect = candidate ? { ...rect, x: box.x + rect.x - (viewport?.scrollLeft ?? 0), y: box.y + rect.y - (viewport?.scrollTop ?? 0) } : { x: box.x, y: box.y, width: box.width, height: box.height };
        hit = { target: { region: "float", rect: { ...visibleRect, x: visibleRect.x - area.x, y: visibleRect.y - area.y } }, rect: new DOMRect(visibleRect.x, visibleRect.y, visibleRect.width, visibleRect.height), label: candidate ? "吸附窗口" : "最大化窗口" };
      }
    } else { snapTracker.reset(); resetEdge(); }
    if (hit) {
      const destinationPanels = panelsAtDockTarget(panels, hit.target);
      const snapshot = store.getSnapshot();
      if (snapshot.scope !== scope || snapshot.preview !== previewMode) { cancel(); return; }
      if (hit.target.region === "float" && !hit.target.groupId && !windowTarget) {
        const area = workbenchBounds(surface)!;
        const root = new DOMRect(area.x, area.y, area.width, area.height);
        const active = floatingId ? snapshot.layout.floats.find(group => group.id === floatingId)?.active : panels[0];
        const minimumHeight = active === "terminal" ? 282 + (panels.length > 1 ? 36 : 0) : 200;
        const managed = floatingId ? manager?.get(store.windowId(floatingId)) : undefined;
        const detached = managed && (managed.maximized || manager?.cell(managed.id) !== undefined);
        const remembered = detached ? managed.rect : undefined;
        const desired = remembered && sourceFloat ? { ...remembered, x: point.x - root.left - Math.max(0, Math.min(1, (start.x - sourceFloat.left) / sourceFloat.width)) * remembered.width, y: point.y - root.top - Math.min(28, start.y - sourceFloat.top) } : sourceFloat ? { x: sourceFloat.left - root.left + point.x - start.x, y: sourceFloat.top - root.top + point.y - start.y, width: sourceFloat.width, height: sourceFloat.height } : hit.target.rect!;
        hit.target.rect = clampFloat(desired, { width: root.width, height: root.height }, minimumHeight);
      }
      const key = JSON.stringify(hit.target);
      if (projectionKey !== key || contentChanged) {
        projected = dockReducer(snapshot.layout, { type: "move", panels, target: hit.target });
        projectionKey = key;
        contentChanged = false;
        cardPlacement = hit.target.region === "left" || hit.target.region === "rail"
          ? measureCardPlacement(hit.target.region, projected, destinationPanels, hosts, definitions, document)
          : undefined;
      }
      // Borrow only destination geometry. The saved layout is unchanged until pointerup.
      const fallback = previewBounds(hit, projected!, destinationPanels, document, surface);
      const rect = cardPlacement ? cardPlacementRect(cardPlacement, projected!, destinationPanels, fallback, document) : fallback;
      flushSync(() => dragPreview.show({ source: dragSource, hosts, layout: projected!, panels: destinationPanels, target: hit!.target, rect, ...(cardPlacement ? { cards: cardPlacement } : {}), label: destinationPanels.length > 1 && cardPlacement ? `${hit!.label} · 拆为 ${destinationPanels.length} 张卡片` : hit!.label, snapped: !!windowTarget || hit!.target.region !== "float" || !!hit!.target.groupId, ...(windowTarget ? { snapKey: JSON.stringify(windowTarget) } : {}), ...(workspace ? { workspace } : {}) }));
      if (cardPlacement) {
        const list = cardList(cardPlacement.region, document);
        const gaps = destinationPanels.map(id => {
          const card = list?.querySelector<HTMLElement>(`:scope > [data-dock-card="${id}"]`);
          return card ? cardLayoutRect(card) : undefined;
        });
        const present = gaps.filter((gap): gap is DOMRect => !!gap && gap.width > 0 && gap.height > 0);
        const first = gaps[0], last = gaps.at(-1);
        if (cardPlacement.region === "left" && present.length === destinationPanels.length) {
          // Folded titles land at the bottom, so a mixed group need not stay contiguous.
          const top = Math.min(...present.map(gap => gap.top));
          const placed = { x: present[0]!.x, y: top, width: present[0]!.width, height: Math.max(...present.map(gap => gap.bottom)) - top };
          cardPlacement = { ...cardPlacement, rects: Object.fromEntries(destinationPanels.map((id, index) => {
            const gap = gaps[index]!;
            return [id, { x: gap.x, y: gap.y, width: gap.width, height: gap.height }];
          })) };
          flushSync(() => dragPreview.show({ ...dragPreview.snapshot()!, rect: placed, cards: cardPlacement! }));
        } else if (first && last && first.width > 0 && first.height > 0) {
          const placed = { x: first.x, y: first.y, width: first.width, height: last.bottom - first.top };
          if (Math.abs(placed.x - rect.x) >= 0.5 || Math.abs(placed.y - rect.y) >= 0.5 || Math.abs(placed.width - rect.width) >= 0.5 || Math.abs(placed.height - rect.height) >= 0.5) flushSync(() => dragPreview.show({ ...dragPreview.snapshot()!, rect: placed }));
        }
      }
    } else flushSync(() => dragPreview.show(null));
    const under = document.elementsFromPoint(point.x, point.y);
    let scroll: HTMLElement | null = null;
    for (const element of under) {
      if (element.closest('.dock-drag-preview, .dock-layout-preview, .dock-drag-source, .dock-panel-content.is-drag-preview')) continue;
      const host = element.closest<HTMLElement>('[data-panel]');
      const slot = host ? document.querySelector<HTMLElement>(`[data-dock-slot="${host.dataset.panel}"]`) : element;
      scroll = slot?.closest<HTMLElement>('.dock-card-list, .dock-tabs') ?? null;
      if (scroll) break;
    }
    if (scroll) {
      const rect = scroll.getBoundingClientRect();
      const horizontal = scroll.classList.contains("dock-tabs");
      const p = horizontal ? point.x : point.y, a = horizontal ? rect.left : rect.top, b = horizontal ? rect.right : rect.bottom;
      const delta = p - a < 28 ? -10 : b - p < 28 ? 10 : 0;
      if (delta) {
        const before = horizontal ? scroll.scrollLeft : scroll.scrollTop;
        if (horizontal) scroll.scrollLeft += delta; else scroll.scrollTop += delta;
        return (horizontal ? scroll.scrollLeft : scroll.scrollTop) !== before;
      }
    }
  };
  const cleanup = (synchronous = true, settle = false) => {
    restoreWindowPreview(); restoreWindowPreview = () => {};
    if (finished) return;
    finished = true;
    resetEdge();
    contentObserver.disconnect();
    unsubscribe(); detach();
    if (dragPreview.snapshot()?.source === dragSource) {
      if (synchronous) flushSync(() => { if (settle) dragPreview.settle(); else dragPreview.show(null); });
      else dragPreview.show(null);
    }
    if (synchronous) hosts.flush();
  };
  const cancel = () => gesture.cancel();
  const drop = () => {
    restoreWindowPreview(); restoreWindowPreview = () => {};
    if (finished) return;
    unsubscribe();
    if (hit && store.getSnapshot().scope === scope && store.getSnapshot().preview === previewMode) {
      const target = hit.target;
      flushSync(() => {
        if (windowTarget && store.windowManager) {
          const manager = store.windowManager;
          manager.transaction(() => {
            const groupId = store.floatPanels(panels, floatingId);
            if (groupId) {
              const id = store.windowId(groupId);
              if ("maximize" in windowTarget!) manager.maximize(id); else manager.snap(id, windowTarget!);
            }
          });
        } else if (target.region === "float" && !target.groupId) {
          store.floatPanels(panels, floatingId, target.rect);
        } else store.dispatch({ type: "move", panels, target });
      });
    }
    cleanup(true, !!hit);
    if (source.isConnected) source.focus({ preventScroll: true });
  };
  const gesture = beginPointerDrag(event, {
    onStart: () => { const modalPanel = store.getSnapshot().modalPanel; if (modalPanel && panels.includes(modalPanel)) flushSync(() => store.endModalFocus(modalPanel)); },
    onMove: (next, modifier) => { point = next; suspended = modifier; return update(); },
    onDrop: drop,
    onCancel: () => cleanup(synchronous),
  });
  unsubscribe = store.subscribe(() => {
    const snapshot = store.getSnapshot();
    if (snapshot.scope !== scope || snapshot.preview !== previewMode || snapshot.preferences.locked) { synchronous = false; gesture.cancel(); }
  });
  detach = hosts.onDetach(() => { synchronous = false; gesture.cancel(); });
}

export function beginDockResize(event: ReactPointerEvent<HTMLElement>, update: (dx: number, dy: number) => void, commit: () => void, cancel: () => void) {
  const document = event.currentTarget.ownerDocument, window = document.defaultView!;
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  const start = { x: event.clientX, y: event.clientY };
  let frame = 0, x = 0, y = 0;
  const apply = () => { frame = 0; update(x, y); };
  const move = (next: PointerEvent) => { if (next.pointerId !== event.pointerId) return; x = next.clientX - start.x; y = next.clientY - start.y; if (!frame) frame = requestAnimationFrame(apply); };
  const clean = () => { cancelAnimationFrame(frame); document.body.classList.remove("dock-resizing"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", abort); window.removeEventListener("blur", abort); window.removeEventListener("keydown", key, true); };
  const up = (next: PointerEvent) => { if (next.pointerId !== event.pointerId) return; x = next.clientX - start.x; y = next.clientY - start.y; apply(); clean(); commit(); };
  const abort = () => { clean(); cancel(); };
  const key = (next: KeyboardEvent) => { if (next.key === "Escape") { next.preventDefault(); next.stopImmediatePropagation(); abort(); } };
  document.body.classList.add("dock-resizing");
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", abort); window.addEventListener("blur", abort); window.addEventListener("keydown", key, true);
}
