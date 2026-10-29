import type { PointerEvent as ReactPointerEvent } from "react";
import type { DockStore } from "./store";
import type { DockTarget, PanelId } from "./types";
import { PLATFORM } from "../platform";

const NAMES = { left: "左侧栏", rail: "对话工具区", right: "右侧栏", bottom: "底栏", float: "浮窗" };
export function dockHitTest(x: number, y: number, snap: boolean, ignoredFloat?: string): { target: DockTarget; rect: DOMRect; label: string } | null {
  const root = document.querySelector<HTMLElement>(".adaptive-workbench");
  if (!root) return null;
  const bounds = root.getBoundingClientRect();
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
  if (snap) {
    const ignored = ignoredFloat ? document.querySelector<HTMLElement>(`[data-dock-float="${ignoredFloat}"]`) : null;
    const ignoredRect = ignored?.getBoundingClientRect();
    const withinIgnored = ignoredRect && x >= ignoredRect.left && x <= ignoredRect.right && y >= ignoredRect.top && y <= ignoredRect.bottom;
    const elements = withinIgnored ? [] : document.elementsFromPoint(x, y);
    for (let element of elements) {
      if (element.closest('.dock-drag-preview')) continue;
      if (ignoredFloat && element.closest<HTMLElement>('[data-dock-float]')?.dataset.dockFloat === ignoredFloat) continue;
      const host = element.closest<HTMLElement>('[data-panel]');
      if (host) element = document.querySelector<HTMLElement>(`[data-dock-slot="${host.dataset.panel}"]`) ?? element;
      if (ignoredFloat && element.closest<HTMLElement>('[data-dock-float]')?.dataset.dockFloat === ignoredFloat) continue;
      const entry = element.closest<HTMLElement>('[data-dock-entry]');
      if (entry) {
        const region = entry.dataset.dockEntry as DockTarget["region"];
        return { target: { region }, rect: entry.getBoundingClientRect(), label: `移入${NAMES[region]}` };
      }
      const group = element.closest<HTMLElement>('[data-dock-group]');
      if (group) {
        const region = group.dataset.dockRegion as DockTarget["region"];
        const groupId = group.dataset.dockGroup!;
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
        const card = element.closest<HTMLElement>('[data-dock-card]');
        const list = [...cards.querySelectorAll<HTMLElement>('[data-dock-card]')];
        if (card) {
          const rect = card.getBoundingClientRect();
          const before = y < rect.top + rect.height / 2;
          return { target: { region, index: list.indexOf(card) + (before ? 0 : 1) }, rect: new DOMRect(rect.left, before ? rect.top : rect.bottom - 3, rect.width, 3), label: `插入 ${card.dataset.dockCard} ${before ? "上方" : "下方"}` };
        }
        return { target: { region, index: list.length }, rect: cards.getBoundingClientRect(), label: `移入${NAMES[region]}` };
      }
      const empty = element.closest<HTMLElement>('[data-dock-empty]');
      if (empty) { const region = empty.dataset.dockEmpty as DockTarget["region"]; return { target: { region }, rect: empty.getBoundingClientRect(), label: `移入${NAMES[region]}` }; }
    }
  }
  return { target: { region: "float", rect: { x: x - bounds.left - 160, y: y - bounds.top - 18, width: 480, height: 360 } }, rect: new DOMRect(Math.max(bounds.left, Math.min(x - 160, bounds.right - Math.min(480, bounds.width))), Math.max(bounds.top, Math.min(y - 18, bounds.bottom - Math.min(360, bounds.height))), Math.min(480, bounds.width), Math.min(360, bounds.height)), label: "作为浮窗" };
}

export function beginDockDrag(event: ReactPointerEvent<HTMLElement>, store: DockStore, panels: PanelId[], floatingId?: string) {
  if (event.button !== 0 || store.getSnapshot().preferences.locked) return;
  if ((event.target as Element).closest('button:not([data-dock-drag]), input, select, textarea, [data-no-dock-drag]')) return;
  const source = event.currentTarget;
  const scope = store.getSnapshot().scope;
  const previewMode = store.getSnapshot().preview;
  const start = { x: event.clientX, y: event.clientY };
  let point = start, moved = false, frame = 0, suspended = PLATFORM === "darwin" ? event.metaKey : event.ctrlKey;
  let hit: ReturnType<typeof dockHitTest> = null;
  let preview: HTMLDivElement | null = null;
  const update = () => {
    frame = 0;
    if (!moved) return;
    hit = dockHitTest(point.x, point.y, store.getSnapshot().preferences.snap && !suspended, floatingId);
    if (hit && preview) {
      preview.hidden = false;
      const { rect, label } = hit;
      preview.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
      preview.textContent = panels.length > 1 && (hit.target.region === "left" || hit.target.region === "rail") ? `${label} · 拆为 ${panels.length} 张卡片` : label;
    } else if (preview) preview.hidden = true;
    const under = document.elementsFromPoint(point.x, point.y);
    let scroll: HTMLElement | null = null;
    for (const element of under) {
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
      if (delta) { if (horizontal) scroll.scrollLeft += delta; else scroll.scrollTop += delta; frame = requestAnimationFrame(update); }
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const move = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    point = { x: next.clientX, y: next.clientY };
    if (!moved && Math.hypot(point.x - start.x, point.y - start.y) >= 6) {
      moved = true; window.getSelection()?.removeAllRanges();
      preview = document.createElement("div"); preview.className = "dock-drag-preview"; preview.setAttribute("role", "status"); document.body.append(preview);
      document.body.classList.add("dock-dragging");
    }
    if (moved) { next.preventDefault(); schedule(); }
  };
  const cleanup = () => {
    cancelAnimationFrame(frame); preview?.remove(); document.body.classList.remove("dock-dragging");
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel); window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", key, true);
    if (moved) {
      const suppress = (click: MouseEvent) => { click.preventDefault(); click.stopImmediatePropagation(); };
      window.addEventListener("click", suppress, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", suppress, true), 0);
    }
  };
  const cancel = () => cleanup();
  const up = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    point = { x: next.clientX, y: next.clientY }; if (moved) { cancelAnimationFrame(frame); update(); }
    cleanup();
    if (!moved || !hit || store.getSnapshot().scope !== scope || store.getSnapshot().preview !== previewMode) return;
    if (floatingId && hit.target.region === "float" && !hit.target.groupId) {
      const group = store.getSnapshot().layout.floats.find(item => item.id === floatingId);
      if (group) store.dispatch({ type: "float", groupId: floatingId, maximized: false, rect: { ...group.rect, x: group.rect.x + point.x - start.x, y: group.rect.y + point.y - start.y } });
    } else store.dispatch({ type: "move", panels, target: hit.target });
    source.focus({ preventScroll: true });
  };
  const key = (next: KeyboardEvent) => {
    if (next.key === "Escape") { next.preventDefault(); next.stopImmediatePropagation(); cancel(); return; }
    suspended = PLATFORM === "darwin" ? next.metaKey : next.ctrlKey; schedule();
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel); window.addEventListener("keydown", key, true); window.addEventListener("keyup", key, true);
}

export function beginDockResize(event: ReactPointerEvent<HTMLElement>, update: (dx: number, dy: number) => void, commit: () => void, cancel: () => void) {
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
