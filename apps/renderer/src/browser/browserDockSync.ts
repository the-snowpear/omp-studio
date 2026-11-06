import type { ManagedBrowserState } from "@omp-studio/studio-protocol";
import { locatePanel } from "../dock/model";
import { browserPagePanelId, isBrowserPagePanelId, type BrowserPagePanelId, type DockAction, type DockLayout } from "../dock/types";

/** What the previous pass saw, so a change can be told apart from a standing difference. */
export interface BrowserDockMemory {
  pages: ReadonlyMap<string, ManagedBrowserState["pages"][number]["status"]>;
  activePageId: string | null;
  lastBrowserPage: BrowserPagePanelId | undefined;
}
export interface BrowserDockPlan { actions: DockAction[]; select?: string | undefined; memory: BrowserDockMemory }

/**
 * Reconciles one chat's browser with its page tabs. The browser state decides
 * which pages exist; the dock decides where they sit. Tab focus flows both ways:
 * a clicked tab selects its page, and the Agent switching pages moves the tab
 * of a strip that already shows this chat's browser.
 */
export function planBrowserDockSync({ layout, sessionId, state, memory, selecting }: { layout: DockLayout; sessionId: string; state: ManagedBrowserState; memory: BrowserDockMemory | undefined; /** A select still on its way to the desktop. */ selecting?: string | undefined }): BrowserDockPlan {
  const actions: DockAction[] = [];
  const live = new Map(state.pages.map(page => [page.id, page]));
  const placed = (panel: BrowserPagePanelId) => !!locatePanel(layout, panel);

  const gone = (Object.keys(layout.browserPages) as BrowserPagePanelId[]).filter(id => layout.browserPages[id]!.sessionId === sessionId && !live.has(layout.browserPages[id]!.pageId));
  if (gone.length) actions.push({ type: "browser-page-close", panels: gone });

  for (const page of state.pages) {
    const panel = browserPagePanelId(sessionId, page.id);
    const descriptor = layout.browserPages[panel];
    const wasReady = memory?.pages.get(page.id) === "ready";
    const title = page.status === "ready" && !wasReady && page.title && page.title !== descriptor?.title ? page.title : undefined;
    if (descriptor && placed(panel)) {
      // Titles are remembered at load boundaries only: single-page apps retitle constantly.
      if (title) actions.push({ type: "browser-page-open", panel, descriptor: { ...descriptor, title }, reveal: false });
      continue;
    }
    const fresh = !!memory && !memory.pages.has(page.id);
    const opener = page.opener?.pageId ? browserPagePanelId(sessionId, page.opener.pageId) : undefined;
    actions.push({
      type: "browser-page-open", panel, descriptor: { sessionId, pageId: page.id, ...(title ?? descriptor?.title ? { title: title ?? descriptor?.title } : {}) },
      reveal: fresh && page.opener?.source === "human", ...(opener && layout.browserPages[opener] ? { after: opener } : {}),
    });
  }

  const next: BrowserDockMemory = { pages: new Map(state.pages.map(page => [page.id, page.status])), activePageId: state.activePageId, lastBrowserPage: layout.lastBrowserPage };
  // Membership changes first; focus is reconciled on the next pass against the settled layout.
  if (actions.some(action => action.type === "browser-page-close" || action.type === "browser-page-open" && !layout.browserPages[action.panel])) return { actions, memory: memory ? { ...next, activePageId: memory.activePageId, lastBrowserPage: memory.lastBrowserPage } : next };
  if (!memory) return { actions, memory: next };

  const focused = layout.lastBrowserPage && isBrowserPagePanelId(layout.lastBrowserPage) ? layout.browserPages[layout.lastBrowserPage] : undefined;
  const focusedPage = focused?.sessionId === sessionId ? focused.pageId : undefined;
  if (layout.lastBrowserPage !== memory.lastBrowserPage && focusedPage && focusedPage !== state.activePageId && live.has(focusedPage)) return { actions, select: focusedPage, memory: next };
  // While a clicked tab's select is in flight, an older active page must not pull focus back.
  if (state.activePageId !== memory.activePageId && state.activePageId && state.activePageId !== focusedPage && (!selecting || selecting === state.activePageId)) {
    const panel = browserPagePanelId(sessionId, state.activePageId);
    if (placed(panel)) {
      actions.push({ type: "browser-page-focus", panel });
      const group = [...layout.right.groups, ...layout.bottom.groups, ...layout.floats].find(item => item.panels.includes(panel));
      const showing = group && isBrowserPagePanelId(group.active) ? layout.browserPages[group.active] : undefined;
      if (group && group.active !== panel && showing?.sessionId === sessionId) actions.push({ type: "activate", groupId: group.id, panel });
    }
  }
  return { actions, memory: next };
}
