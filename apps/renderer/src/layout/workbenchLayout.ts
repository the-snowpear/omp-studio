export const CONVERSATION_MIN_WIDTH = 560;
export const LAYOUT_RESTORE_GAP = 32;
export const SIDEBAR_LIMITS = { min: 200, max: 400, initial: 272 };
export const SIDE_PANEL_LIMITS = { min: 360, max: 640, initial: 480 };
export const BOTTOM_PANEL_LIMITS = { min: 120, max: 480, initial: 240 };

export type LayoutPanel = "sidebar" | "side" | "bottom";
export type WorkbenchPreferences = {
  collapsed: boolean;
  sidebarWidth: number;
  sideOpen: boolean;
  panelWidth: number;
  bottomVisible: boolean;
  bottomOpen: boolean;
  bottomHeight: number;
};
export type WorkbenchLayout = {
  sidebarShown: boolean;
  sidebarWidth: number;
  sideShown: boolean;
  panelWidth: number;
  bottomVisible: boolean;
  bottomOpen: boolean;
  bottomHeight: number;
  overlay: LayoutPanel | null;
};

export function panelSize(value: number, limits: { min: number; max: number; initial: number }): number {
  return Number.isFinite(value) ? Math.min(limits.max, Math.max(limits.min, Math.round(value))) : limits.initial;
}

function horizontalLayout(width: number, prefs: WorkbenchPreferences, priority: LayoutPanel | null) {
  const sidebar = panelSize(prefs.sidebarWidth, SIDEBAR_LIMITS);
  const panel = panelSize(prefs.panelWidth, SIDE_PANEL_LIMITS);
  let left = prefs.collapsed ? 0 : sidebar;
  let right = prefs.sideOpen ? panel : 0;
  let overlay: LayoutPanel | null = null;
  if (priority === "sidebar" && left && width < CONVERSATION_MIN_WIDTH + SIDEBAR_LIMITS.min) {
    overlay = "sidebar";
    left = 0;
  } else if (priority === "side" && right && width < CONVERSATION_MIN_WIDTH + SIDE_PANEL_LIMITS.min) {
    overlay = "side";
    right = 0;
  }
  let shortage = Math.max(0, CONVERSATION_MIN_WIDTH - (width - left - right));
  const rightCut = Math.min(shortage, Math.max(0, right - SIDE_PANEL_LIMITS.min));
  right -= rightCut;
  shortage -= rightCut;
  const leftCut = Math.min(shortage, Math.max(0, left - SIDEBAR_LIMITS.min));
  left -= leftCut;
  shortage -= leftCut;
  if (shortage > 0) {
    if (priority === "side" && right) {
      left = 0;
      right = Math.min(panel, Math.max(SIDE_PANEL_LIMITS.min, width - CONVERSATION_MIN_WIDTH));
    } else {
      right = 0;
      left = !prefs.collapsed && overlay !== "sidebar" && width >= CONVERSATION_MIN_WIDTH + SIDEBAR_LIMITS.min
        ? Math.min(sidebar, width - CONVERSATION_MIN_WIDTH) : 0;
    }
  }
  return {
    sidebarShown: left > 0 || overlay === "sidebar",
    sidebarWidth: overlay === "sidebar" ? Math.min(sidebar, Math.max(0, width - 24)) : left || sidebar,
    sideShown: right > 0 || overlay === "side",
    panelWidth: overlay === "side" ? Math.min(panel, Math.max(0, width - 24)) : right || panel,
    overlay,
  };
}

export function fitWorkbench(
  prefs: WorkbenchPreferences,
  available: { width: number; height: number; composerHeight: number },
  priority: LayoutPanel | null = null,
  previous?: WorkbenchLayout,
): WorkbenchLayout {
  const width = Math.max(0, available.width);
  let horizontal = horizontalLayout(width, prefs, priority);
  if (previous) {
    const restoring = (!previous.sidebarShown && horizontal.sidebarShown) || (!previous.sideShown && horizontal.sideShown);
    if (restoring && priority === null) {
      const cautious = horizontalLayout(Math.max(0, width - LAYOUT_RESTORE_GAP), prefs, priority);
      if ((!previous.sidebarShown && !cautious.sidebarShown) || (!previous.sideShown && !cautious.sideShown)) horizontal = cautious;
    }
  }
  const preferredHeight = panelSize(prefs.bottomHeight, BOTTOM_PANEL_LIMITS);
  const budget = Math.max(0, available.height - available.composerHeight - 160);
  const bottomOverlay = priority === "bottom" && prefs.bottomVisible && prefs.bottomOpen && budget < BOTTOM_PANEL_LIMITS.min;
  const bottomVisible = prefs.bottomVisible && (budget >= 36 || bottomOverlay);
  const bottomOpen = bottomVisible && prefs.bottomOpen && (budget >= BOTTOM_PANEL_LIMITS.min || bottomOverlay);
  return {
    ...horizontal,
    bottomVisible,
    bottomOpen,
    bottomHeight: bottomOverlay ? Math.max(0, available.height) : Math.min(preferredHeight, Math.max(0, budget)),
    overlay: bottomOverlay ? "bottom" : horizontal.overlay,
  };
}
