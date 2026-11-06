import type { ManagedBrowserCommand, ManagedBrowserEvent, ManagedBrowserPage, ManagedBrowserState } from "@omp-studio/studio-protocol";
import { PREVIEW_BROWSER_TAB } from "./browserPreview";

/** Demo-only browser: every command changes local state; nothing reaches the Host or a real page. */
export interface ManagedBrowserPreviewState extends ManagedBrowserState {
  previewHistory: Record<string, { urls: string[]; cursor: number }>;
  previewNextId: number;
}

const icon = (body: string) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`);
/** Static demo site icons, so tabs show what real favicons look like. */
export const PREVIEW_FAVICONS = {
  studio: icon('<rect width="16" height="16" rx="4" fill="#6e56cf"/><path d="M4.5 10.5 8 4l3.5 6.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  docs: icon('<rect width="16" height="16" rx="4" fill="#1f6ba3"/><path d="M4.5 4h4.2c1.2 0 2.3.9 2.3 2.1V12H6.4c-1 0-1.9-.8-1.9-1.8z" fill="#fff"/>'),
  storybook: icon('<rect width="16" height="16" rx="4" fill="#d94f6c"/><path d="M10.6 4.6C9.9 4 9 3.8 8.1 3.8 6.6 3.8 5.5 4.6 5.5 5.9c0 2.7 4.9 1.8 4.9 4 0 .9-.9 1.5-2.2 1.5-1 0-1.9-.3-2.7-1" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>'),
} as const;

const DOCS_URL = "http://localhost:4173/docs/browser";
const STORY_URL = "http://localhost:6006/?path=/story/button--primary";
const page = (sessionId: string, id: number, patch: Partial<ManagedBrowserPage> & Pick<ManagedBrowserPage, "title" | "url">): ManagedBrowserPage =>
  ({ id: `${sessionId}:page-${id}`, sessionId, spaceId: "shared", status: "ready", canGoBack: false, canGoForward: false, zoom: 1, devtools: false, ...patch });

export function createManagedBrowserPreview(sessionId: string): ManagedBrowserPreviewState {
  const studio = page(sessionId, 1, { title: "Studio 组件预览", url: `${PREVIEW_BROWSER_TAB.url}/components`, favicon: PREVIEW_FAVICONS.studio, canGoBack: true });
  const docs = page(sessionId, 2, { title: "浏览器 · 使用说明", url: DOCS_URL, favicon: PREVIEW_FAVICONS.docs });
  const story = page(sessionId, 3, { title: "Button · Storybook", url: STORY_URL, favicon: PREVIEW_FAVICONS.storybook, status: "released" });
  return {
    sessionId, pages: [studio, docs, story], activePageId: studio.id,
    spaces: [{ id: "shared", name: "Shared" }, { id: "preview-space-qa", name: "测试账号" }],
    control: "agent", connection: "connected", settings: { maxTabs: 16, downloadDirectory: "C:\\Users\\demo\\Downloads", askDownloadLocation: false },
    downloads: [
      { id: "preview-download", pageId: studio.id, name: "studio-components.json", url: `${PREVIEW_BROWSER_TAB.url}/studio-components.json`, path: "studio-components.json", receivedBytes: 4096, totalBytes: 4096, state: "completed" },
      { id: "preview-download-2", pageId: docs.id, name: "browser-guide.pdf", url: `${DOCS_URL}/guide.pdf`, path: "browser-guide.pdf", receivedBytes: 1_310_720, totalBytes: 3_145_728, state: "progressing" },
    ],
    permissions: [{ spaceId: "shared", origin: PREVIEW_BROWSER_TAB.url, permission: "notifications", allowed: false }],
    previewHistory: { [studio.id]: { urls: [PREVIEW_BROWSER_TAB.url, studio.url], cursor: 1 }, [docs.id]: { urls: [DOCS_URL], cursor: 0 }, [story.id]: { urls: [STORY_URL], cursor: 0 } },
    previewNextId: 4,
  };
}

const normalize = (address: string) => address === "about:blank" ? address : new URL(/^https?:\/\//iu.test(address) ? address : `http://${address}`).href;
const known = (url: string) => url.startsWith(PREVIEW_BROWSER_TAB.url) ? { title: "Studio 组件预览", favicon: PREVIEW_FAVICONS.studio } : url.startsWith(DOCS_URL) ? { title: "浏览器 · 使用说明", favicon: PREVIEW_FAVICONS.docs } : url.startsWith("http://localhost:6006") ? { title: "Button · Storybook", favicon: PREVIEW_FAVICONS.storybook } : undefined;
const title = (url: string) => url === "about:blank" ? "新标签页" : known(url)?.title ?? new URL(url).host;
const update = (state: ManagedBrowserPreviewState, pageId: string, patch: Partial<ManagedBrowserPage>): ManagedBrowserPreviewState => ({ ...state, pages: state.pages.map(page => page.id === pageId ? { ...page, ...patch } : page) });
const visit = (url: string): Partial<ManagedBrowserPage> => ({ url, title: title(url), favicon: known(url)?.favicon, status: url === "about:blank" ? "ready" : "loading", error: undefined });

export function applyPreviewBrowserCommand(state: ManagedBrowserPreviewState, command: ManagedBrowserCommand): ManagedBrowserPreviewState {
  switch (command.action) {
    case "create": {
      if (state.pages.length >= state.settings.maxTabs) throw new Error("标签数已达上限，关闭一些标签或在浏览器设置中提高上限。");
      const id = `${state.sessionId}:page-${state.previewNextId}`, url = normalize(command.url);
      const created: ManagedBrowserPage = { id, sessionId: state.sessionId, spaceId: command.spaceId ?? "shared", canGoBack: false, canGoForward: false, zoom: 1, devtools: false, title: "", ...visit(url), status: url === "about:blank" ? "ready" : "loading", opener: { source: "human", ...(command.openerPageId ? { pageId: command.openerPageId } : {}) } } as ManagedBrowserPage;
      return { ...state, control: state.pages.length ? state.control : "human", pages: [...state.pages, created], activePageId: id, previewNextId: state.previewNextId + 1, previewHistory: { ...state.previewHistory, [id]: { urls: [url], cursor: 0 } } };
    }
    case "select": { const target = state.pages.find(page => page.id === command.pageId); return update({ ...state, activePageId: command.pageId }, command.pageId, target?.status === "released" ? { status: "loading" } : {}); }
    case "close": case "close-handoff": {
      const index = state.pages.findIndex(page => page.id === command.pageId), pages = state.pages.filter(page => page.id !== command.pageId);
      return { ...state, pages, activePageId: state.activePageId === command.pageId ? (pages[index] ?? pages.at(-1))?.id ?? null : state.activePageId };
    }
    case "close-others": return { ...state, pages: state.pages.filter(page => page.id === command.pageId), activePageId: command.pageId };
    case "navigate": { const url = normalize(command.url), prior = state.previewHistory[command.pageId] ?? { urls: [], cursor: -1 }, urls = [...prior.urls.slice(0, prior.cursor + 1), url]; return update({ ...state, previewHistory: { ...state.previewHistory, [command.pageId]: { urls, cursor: urls.length - 1 } } }, command.pageId, { ...visit(url), canGoBack: urls.length > 1, canGoForward: false }); }
    case "back": case "forward": { const prior = state.previewHistory[command.pageId]!, cursor = Math.max(0, Math.min(prior.urls.length - 1, prior.cursor + (command.action === "back" ? -1 : 1))), url = prior.urls[cursor]!; return update({ ...state, previewHistory: { ...state.previewHistory, [command.pageId]: { ...prior, cursor } } }, command.pageId, { ...visit(url), canGoBack: cursor > 0, canGoForward: cursor < prior.urls.length - 1 }); }
    case "reload": return update(state, command.pageId, { status: "loading", error: undefined });
    case "stop": return update(state, command.pageId, { status: "ready" });
    case "zoom": return update(state, command.pageId, { zoom: Math.round(Math.max(0.25, Math.min(3, command.factor)) * 100) / 100 });
    case "take": return { ...state, control: "human" };
    case "return": if (state.pages.some(page => page.devtools)) throw new Error("先关闭 DevTools 再归还控制。"); return { ...state, control: "agent" };
    case "release": return { ...state, control: "human", pages: state.pages.map(page => ({ ...page, status: "released", devtools: false, canGoBack: false, canGoForward: false })) };
    case "devtools": return update({ ...state, control: "human" }, command.pageId, { devtools: !state.pages.find(page => page.id === command.pageId)!.devtools });
    case "pick": return { ...state, control: "human" };
    case "space-create": return { ...state, spaces: [...state.spaces, { id: `preview-space-${state.previewNextId}`, name: command.name }], previewNextId: state.previewNextId + 1 };
    case "settings": return { ...state, settings: { ...state.settings, ...command.settings } };
    case "permission-forget": return { ...state, permissions: state.permissions.filter(permission => permission.spaceId !== command.spaceId || permission.origin !== command.origin || permission.permission !== command.permission) };
    case "download-cancel": return { ...state, downloads: state.downloads.map(download => download.id === command.downloadId ? { ...download, state: "cancelled" } : download) };
    default: return state;
  }
}

/** The preview twin of the desktop API: same commands and events, all held in memory. */
export function createPreviewBrowserBackend(options: { loadingMs?: number } = {}) {
  const sessions = new Map<string, ManagedBrowserPreviewState>();
  const listeners = new Set<(event: ManagedBrowserEvent) => void>();
  const emit = (event: ManagedBrowserEvent) => { for (const listener of listeners) listener(event); };
  const state = (sessionId: string) => { let value = sessions.get(sessionId); if (!value) sessions.set(sessionId, value = createManagedBrowserPreview(sessionId)); return value; };
  const settle = (sessionId: string) => setTimeout(() => {
    const current = state(sessionId);
    if (!current.pages.some(page => page.status === "loading")) return;
    const next = { ...current, pages: current.pages.map(page => page.status !== "loading" ? page : /error/iu.test(page.url) ? { ...page, status: "error" as const, error: "无法连接到演示站点（ERR_CONNECTION_REFUSED）" } : { ...page, status: "ready" as const }) };
    sessions.set(sessionId, next);
    emit({ kind: "state", state: next });
  }, options.loadingMs ?? 650);
  return {
    async read(sessionId: string): Promise<ManagedBrowserState> { return state(sessionId); },
    async execute(command: ManagedBrowserCommand): Promise<ManagedBrowserState> {
      const previous = state(command.sessionId);
      if (command.action === "stop-picking" || command.action === "pick") {
        const pageId = command.action === "pick" ? command.pageId : undefined;
        for (const page of previous.pages) emit({ kind: "picker", sessionId: command.sessionId, pageId: page.id, active: page.id === pageId });
      }
      const next = applyPreviewBrowserCommand(previous, command);
      if (next !== previous) { sessions.set(command.sessionId, next); emit({ kind: "state", state: next }); }
      if (next.pages.some(page => page.status === "loading")) settle(command.sessionId);
      return next;
    },
    subscribe(listener: (event: ManagedBrowserEvent) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Demo of the Agent opening a page by itself: a background tab, with control unchanged. */
    agentOpen(sessionId: string, url: string): void {
      const current = state(sessionId), opened = applyPreviewBrowserCommand(current, { action: "create", url, sessionId });
      const created = opened.pages.at(-1)!;
      const next = { ...opened, control: current.control, pages: opened.pages.map(page => page === created ? { ...page, opener: { source: "agent" as const } } : page) };
      sessions.set(sessionId, next);
      emit({ kind: "state", state: next });
      settle(sessionId);
    },
  };
}
