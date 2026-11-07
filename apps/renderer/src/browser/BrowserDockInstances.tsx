import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { BrowserElementReference } from "@omp-studio/studio-protocol";
import { useConversationDom } from "../conversationWorkspace/Context";
import { DockPanel, useBrowserPagesLayout, useDockEngine } from "../dock/DockContext";
import type { BrowserPagePanelId, PanelDefinition, PanelId } from "../dock/types";
import { usePreviewMode } from "../preview/PreviewContext";
import type { BrowserLinkIntent } from "./browserLinks";
import { planBrowserDockSync, type BrowserDockMemory } from "./browserDockSync";
import { browserHub, type BrowserSession, type BrowserSessionSnapshot } from "./browserSessions";
import { useManagedBrowserAvailable } from "./BrowserPane";
import { splitAddress } from "./BrowserToolbar";
import { ManagedBrowserPane, useBrowserCopy } from "./ManagedBrowserPane";

function useSessionSnapshots(sessions: readonly BrowserSession[]): readonly BrowserSessionSnapshot[] {
  const key = sessions.map(session => session.id).join("\n");
  const cache = useRef<readonly BrowserSessionSnapshot[]>([]);
  const subscribe = useCallback((listener: () => void) => { const off = sessions.map(session => session.subscribe(listener)); return () => off.forEach(stop => stop()); }, [key]);
  const read = useCallback(() => {
    const next = sessions.map(session => session.getSnapshot());
    if (next.length !== cache.current.length || next.some((value, index) => value !== cache.current[index])) cache.current = next;
    return cache.current;
  }, [key]);
  return useSyncExternalStore(subscribe, read);
}

/**
 * Every web page of the viewed chat as its own dock tab: keeps tabs in step with
 * the browser, describes them (title, site icon, state, close) and hosts each
 * page's pane. Message and terminal links for this chat open here as well.
 */
export function BrowserDockInstances({ client, sessionId, available, capabilities, remote, onReferences }: {
  client?: StudioClient | undefined; sessionId: string | undefined; available: boolean; capabilities: ClientBootstrap["capabilityManifest"] | undefined; remote: boolean;
  onReferences: (references: BrowserElementReference[]) => void;
}) {
  const { preview } = usePreviewMode();
  const copy = useBrowserCopy();
  const native = useManagedBrowserAvailable(available, capabilities);
  const { store, setBrowserPageDefinitions } = useDockEngine();
  const { window: conversationWindow } = useConversationDom();
  const pages = useBrowserPagesLayout();
  const scope = useSyncExternalStore(store.subscribe, () => store.getSnapshot().scope);
  const hub = native ? browserHub(preview) : null;
  const session = useMemo(() => hub && sessionId ? hub.session(sessionId) : null, [hub, sessionId]);
  // Only sync once the dock shows this chat's layout; a half-switched chat must not trade pages.
  const bound = !!session && scope.session === sessionId && !scope.draft;
  const tabs = (Object.entries(pages.browserPages) as [BrowserPagePanelId, (typeof pages.browserPages)[string]][]).filter(([id]) => pages.placed.has(id));
  const sessionIds = [...new Set(tabs.map(([, descriptor]) => descriptor.sessionId))];
  const sessions = useMemo(() => hub ? sessionIds.map(id => hub.session(id)) : [], [hub, sessionIds.join("\n")]);
  const snapshots = useSessionSnapshots(sessions);

  const definitions = useMemo((): PanelDefinition[] => tabs.map(([id, descriptor]) => {
    const index = sessionIds.indexOf(descriptor.sessionId), snap = snapshots[index], owner = sessions[index];
    const page = snap?.state?.pages.find(item => item.id === descriptor.pageId);
    const title = !page ? descriptor.title || "Browser" : page.url === "about:blank" ? copy("新标签页", "New tab") : page.title && page.title !== page.url ? page.title : splitAddress(page.url).host || page.url;
    const state = page?.status === "loading" ? "busy" as const : page?.status === "error" || page?.status === "crashed" ? "error" as const : page?.status === "released" ? "muted" as const : undefined;
    const human = snap?.state?.control === "human";
    return {
      id, title, icon: "globe", initialHeight: 320, minHeight: 180, compactLabel: title.slice(0, 2), detail: page && page.url !== "about:blank" ? `${title}\n${page.url}` : title,
      glyph: { image: page?.favicon, state, label: state === "busy" ? copy("正在加载", "Loading") : state === "error" ? copy("加载失败", "Failed to load") : state === "muted" ? copy("未加载", "Not loaded") : undefined },
      ...(owner ? { close: {
        run: () => void owner.closePage(descriptor.pageId), label: copy(`关闭 ${title}`, `Close ${title}`),
        tip: human || !snap?.state?.pages.length ? copy("关闭网页", "Close page") : copy("关闭网页（等 Agent 当前一步做完）", "Close page (after the Agent's current step)"),
        pending: !!snap?.closing.includes(descriptor.pageId), pendingTip: copy("等 Agent 当前一步做完后关闭", "Closes after the Agent's current step"),
      } } : {}),
    };
  }), [tabs.map(([id]) => id).join("\n"), snapshots, sessions, copy]);
  useLayoutEffect(() => { setBrowserPageDefinitions(definitions); }, [definitions, setBrowserPageDefinitions]);
  useLayoutEffect(() => () => setBrowserPageDefinitions([]), [setBrowserPageDefinitions]);

  const memories = useRef(new Map<string, BrowserDockMemory>());
  const selecting = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!session || !bound) return;
    let running = false;
    const run = () => {
      if (running) return;
      running = true;
      try {
        // Each pass settles membership first, then focus; four passes is more than any change needs.
        for (let pass = 0; pass < 4; pass++) {
          const state = session.getSnapshot().state;
          if (!state) return;
          const plan = planBrowserDockSync({ layout: store.getSnapshot().layout, sessionId: session.id, state, memory: memories.current.get(session.id), selecting: selecting.current });
          memories.current.set(session.id, plan.memory);
          if (plan.select) {
            const pageId = plan.select;
            selecting.current = pageId;
            void session.select(pageId).finally(() => { if (selecting.current === pageId) selecting.current = undefined; });
          }
          if (!plan.actions.length) break;
          for (const action of plan.actions) store.dispatch(action);
        }
      } finally { running = false; }
    };
    const offStore = store.subscribe(run), offSession = session.subscribe(run);
    run();
    return () => { offStore(); offSession(); };
  }, [store, session, bound]);

  // A pinned page from another chat leaves once that chat confirms the page is gone.
  useEffect(() => {
    const gone = tabs.filter(([, descriptor]) => descriptor.sessionId !== sessionId).filter(([, descriptor]) => {
      const state = snapshots[sessionIds.indexOf(descriptor.sessionId)]?.state;
      return state && !state.pages.some(page => page.id === descriptor.pageId);
    }).map(([id]) => id);
    if (gone.length) store.dispatch({ type: "browser-page-close", panels: gone });
  }, [snapshots]);

  useEffect(() => {
    if (remote || !session || !bound) return;
    const open = (event: Event) => {
      const detail = (event as CustomEvent<BrowserLinkIntent>).detail;
      detail.handled = true;
      const later = () => { session.setPendingLink({ id: crypto.randomUUID(), url: detail.url }); store.dispatch({ type: "open", panel: "browser" }); };
      const state = session.getSnapshot().state;
      // Opening directly needs the user in control, unless this is the chat's first page.
      if (state && (state.control === "human" || !state.pages.length)) void session.create(detail.url).then(result => { if (!result) later(); });
      else later();
    };
    conversationWindow.addEventListener("omp:browser-link", open);
    return () => conversationWindow.removeEventListener("omp:browser-link", open);
  }, [conversationWindow, remote, session, bound, store]);

  return <>{tabs.map(([id, descriptor]) => <DockPanel key={id} id={id as PanelId}>{visibility =>
    <ManagedBrowserPane client={available && descriptor.sessionId === sessionId && capabilities?.capabilities.some(item => item.id === "browser.webmcp.list" && item.grade !== "unavailable") ? client : undefined} sessionId={descriptor.sessionId} pageId={descriptor.pageId} visible={visibility.visible} width={visibility.width} foreign={descriptor.sessionId !== sessionId}
      onReferences={onReferences} onActivate={() => { if (store.getSnapshot().layout.lastBrowserPage !== id) store.dispatch({ type: "browser-page-focus", panel: id }); }} />}</DockPanel>)}</>;
}
