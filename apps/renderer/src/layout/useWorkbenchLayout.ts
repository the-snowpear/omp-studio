import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { beforeConversationLayoutChange, afterConversationLayoutChange } from "../conversation/conversationReflow";
import { fitWorkbench, type LayoutPanel, type WorkbenchLayout, type WorkbenchPreferences } from "./workbenchLayout";

type LayoutVisibility = Pick<WorkbenchLayout, "sidebarShown" | "sideShown" | "bottomVisible" | "bottomOpen" | "overlay" | "railMode">;
function visibilityOf(layout: WorkbenchLayout): LayoutVisibility {
  return { sidebarShown: layout.sidebarShown, sideShown: layout.sideShown, bottomVisible: layout.bottomVisible, bottomOpen: layout.bottomOpen, overlay: layout.overlay, railMode: layout.railMode };
}
function sameVisibility(a: LayoutVisibility, b: LayoutVisibility): boolean {
  return a.sidebarShown === b.sidebarShown && a.sideShown === b.sideShown && a.bottomVisible === b.bottomVisible && a.bottomOpen === b.bottomOpen && a.overlay === b.overlay && a.railMode === b.railMode;
}

export function useWorkbenchLayout(prefs: WorkbenchPreferences, active: boolean) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [priority, setPriority] = useState<LayoutPanel | null>(null);
  const [visibility, setVisibility] = useState<LayoutVisibility>(() => visibilityOf(fitWorkbench(prefs, { width: window.innerWidth, height: window.innerHeight - 80, composerHeight: 160 })));
  const lastLayout = useRef<WorkbenchLayout | undefined>(undefined);
  const priorityRef = useRef(priority);
  priorityRef.current = priority;
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    if (wasActive.current !== active) {
      wasActive.current = active;
      priorityRef.current = null;
      setPriority(null);
      lastLayout.current = undefined;
    }
  }, [active]);
  /* `priorityRef` is written synchronously here: one gesture can reach the same
     panel twice (topbar button + the dock region event it dispatches), and a
     second "show this panel" must not re-run the conversation reflow for a
     layout that is already in place. */
  const focusPanel = useCallback((panel: LayoutPanel | null) => {
    if (priorityRef.current === panel) return;
    priorityRef.current = panel;
    beforeConversationLayoutChange();
    setPriority(panel);
  }, []);
  /* Closing a panel only drops the priority that panel itself holds. Clearing it
     unconditionally would also release whichever drawer a narrow window is
     currently showing — closing the bottom bar must not hide the side panel. */
  const releaseFocus = useCallback((panel: LayoutPanel | null) => {
    if (panel === null || priorityRef.current !== panel) return;
    priorityRef.current = null;
    beforeConversationLayoutChange();
    setPriority(null);
  }, []);
  const dismissOverlay = useCallback(() => focusPanel(null), [focusPanel]);
  /* A priority is the gesture that just asked for a panel ("show this even if it
     has to float"). A window resize is a new layout negotiation, not that gesture:
     keeping it would turn a docked panel into a focus-trapping drawer whenever the
     window crosses the overlay threshold. */
  useLayoutEffect(() => {
    const dropPriority = () => {
      if (priorityRef.current === null) return;
      priorityRef.current = null;
      beforeConversationLayoutChange();
      setPriority(null);
    };
    window.addEventListener("resize", dropPriority);
    return () => window.removeEventListener("resize", dropPriority);
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !active) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const workbench = root.querySelector<HTMLElement>("#workbench");
      const composer = root.querySelector<HTMLElement>(".composer-region");
      const rect = root.getBoundingClientRect();
      const contentTop = workbench?.getBoundingClientRect().top ?? rect.top + 44;
      const layout = fitWorkbench(prefs, {
        width: root.clientWidth,
        height: Math.max(0, rect.bottom - contentTop),
        composerHeight: composer?.offsetHeight ?? 160,
      }, priorityRef.current, lastLayout.current);
      const previous = lastLayout.current;
      const geometryChanged = !root.style.getPropertyValue("--sidebar-w") || !previous || layout.sidebarWidth !== previous.sidebarWidth || layout.panelWidth !== previous.panelWidth || layout.railWidth !== previous.railWidth || layout.bottomHeight !== previous.bottomHeight || !sameVisibility(layout, previous);
      if (!geometryChanged) return;
      beforeConversationLayoutChange();
      root.style.setProperty("--sidebar-w", `${layout.sidebarWidth}px`);
      root.style.setProperty("--panel-w", `${layout.panelWidth}px`);
      root.style.setProperty("--dock-rail-w", `${layout.railWidth}px`);
      root.style.setProperty("--bottom-panel-h", `${layout.bottomHeight}px`);
      root.querySelector("#sbResizer")?.setAttribute("aria-valuenow", String(Math.round(layout.sidebarWidth)));
      root.querySelector("#spResizer")?.setAttribute("aria-valuenow", String(Math.round(layout.panelWidth)));
      root.querySelector("#bpResizer")?.setAttribute("aria-valuenow", String(Math.round(layout.bottomHeight)));
      lastLayout.current = layout;
      const next = visibilityOf(layout);
      setVisibility(current => sameVisibility(current, next) ? current : next);
      afterConversationLayoutChange();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    sync();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(root);
    const composer = root.querySelector(".composer-region");
    const topbar = root.querySelector(".topbar");
    if (composer) observer?.observe(composer);
    if (topbar) observer?.observe(topbar);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [active, prefs.collapsed, prefs.sidebarWidth, prefs.sideOpen, prefs.panelWidth, prefs.bottomVisible, prefs.bottomOpen, prefs.bottomHeight, prefs.railMode, prefs.railWidth, priority]);
  const previousVisibility = useRef(visibility);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const previous = previousVisibility.current;
    previousVisibility.current = visibility;
    if (!root || !active) return;
    const focused = document.activeElement;
    for (const [wasShown, shown, selector, trigger] of [
      [previous.sidebarShown, visibility.sidebarShown, "#sidebar", '[aria-controls="sidebar"]'],
      [previous.sideShown, visibility.sideShown, "#sidePanel", '[aria-controls="sidePanel"]'],
      [previous.bottomVisible && previous.bottomOpen, visibility.bottomVisible && visibility.bottomOpen, "#bottomPanel .bp-body", '[aria-controls="bottomPanel"]'],
    ] as const) {
      if (wasShown && !shown && focused && root.querySelector(selector)?.contains(focused)) {
        document.querySelector<HTMLElement>(trigger)?.focus({ preventScroll: true });
      }
    }
  }, [active, visibility]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const panel = visibility.overlay;
    if (!root || !active || !panel) return;
    const drawerSelector = panel === "sidebar" ? "#sidebar" : panel === "side" ? "#sidePanel" : "#bottomPanel";
    const drawer = root.querySelector<HTMLElement>(drawerSelector);
    if (!drawer) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const hostNodes = () => [...drawer.querySelectorAll<HTMLElement>('[data-dock-slot]')].flatMap(slot => [...document.querySelectorAll<HTMLElement>(`[data-panel="${slot.dataset.dockSlot}"] button:not(:disabled), [data-panel="${slot.dataset.dockSlot}"] input:not(:disabled), [data-panel="${slot.dataset.dockSlot}"] textarea:not(:disabled), [data-panel="${slot.dataset.dockSlot}"] [tabindex="0"]`)]);
    const nodes = () => [...drawer.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex="0"]'), ...hostNodes()]
      .filter(node => !node.closest("[inert], [hidden]") && node.getClientRects().length > 0);
    if (!drawer.contains(document.activeElement)) nodes()[0]?.focus({ preventScroll: true });
    const backdrop = root.querySelector<HTMLElement>(".layout-overlay-backdrop");
    const restoreInert = () => {
      const visit = (parent: HTMLElement) => {
        for (const child of [...parent.children]) {
          if (!(child instanceof HTMLElement) || child === drawer || child === backdrop) continue;
          if (child.contains(drawer)) visit(child);
          else if (child.id === "sidebar") child.inert = child.classList.contains("collapsed");
          else if (child.id === "bottomPanel") child.inert = child.classList.contains("closed");
          else child.inert = false;
        }
      };
      visit(root);
    };
    const inertSiblings = (parent: HTMLElement) => {
      for (const child of [...parent.children]) {
        if (!(child instanceof HTMLElement) || child === drawer || child === backdrop) continue;
        if (child.contains(drawer)) inertSiblings(child);
        else child.inert = true;
      }
    };
    inertSiblings(root);
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[aria-modal="true"]') || document.querySelector('.menu:not([hidden]), .title-menu-popover')) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); dismissOverlay(); }
      if (event.key !== "Tab") return;
      const available = nodes();
      const first = available[0]; const last = available[available.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      restoreInert();
      window.removeEventListener("keydown", key, true);
      if (previousFocus?.isConnected && !previousFocus.closest("[inert]")) previousFocus.focus({ preventScroll: true });
    };
  }, [active, visibility.overlay, dismissOverlay]);
  return { ...visibility, rootRef, focusPanel, releaseFocus, dismissOverlay };
}
