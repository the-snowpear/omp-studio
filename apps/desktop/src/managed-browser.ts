import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { BrowserWindow, Menu, Notification, View, WebContentsView, dialog, nativeImage, session, shell, type DownloadItem, type Session, type WebContents } from "electron";
import type { BrowserElementReference, BrowserPageInspection, ManagedBrowserCommand, ManagedBrowserDownload, ManagedBrowserEvent, ManagedBrowserInspectionRequest, ManagedBrowserPage, ManagedBrowserPageOpener, ManagedBrowserPresentation, ManagedBrowserState } from "@omp-studio/studio-protocol";
import { normalizeBrowserAddress } from "./managed-browser-address.js";
import { faviconDataUrl, loadFavicon, pickFaviconUrl } from "./managed-browser-favicon.js";
import { BROWSER_PICKER_POLL, BROWSER_PICKER_START, BROWSER_PICKER_STOP, BROWSER_PICKER_WORLD_ID, type BrowserPickerPoll } from "./managed-browser-picker.js";
import { ManagedBrowserStore } from "./managed-browser-store.js";
import { BrowserPageActivity } from "./managed-browser-activity.js";
import { ManagedBrowserInspection } from "./managed-browser-inspection.js";

interface LivePage {
  page: ManagedBrowserPage;
  view: WebContentsView;
  clip: View;
  parent: BrowserWindow;
  shield?: WebContentsView;
  presentation?: ManagedBrowserPresentation;
  picker?: NodeJS.Timeout;
  picking: boolean;
  closed: boolean;
  agentInputs: number;
  activity: BrowserPageActivity;
  inspection?: ManagedBrowserInspection;
  focusEmulation: Set<string>;
  favicon?: AbortController;
}
export interface ManagedBrowserRuntime {
  control(sessionId: string, control: "human" | "agent"): Promise<void>;
  changed(sessionId: string): void;
  closed(pageId: string): void;
  ownsDebugger?(pageId: string): boolean;
  dispose(): Promise<void>;
}

const originOf = (url: string) => { try { return new URL(url).origin; } catch { return ""; } };
/** Raster icons are re-encoded at 32px so tab state stays small. */
const shrinkFavicon = (bytes: Uint8Array): Uint8Array | undefined => {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) return undefined;
  const size = image.getSize();
  return new Uint8Array((size.width > 32 || size.height > 32 ? image.resize(size.width >= size.height ? { width: 32, quality: "best" } : { height: 32, quality: "best" }) : image).toPNG());
};

export class DesktopManagedBrowser {
  readonly store: ManagedBrowserStore;
  readonly ready: Promise<void>;
  readonly #pages = new Map<string, LivePage>();
  readonly #listeners = new Set<(event: ManagedBrowserEvent) => void>();
  readonly #spaces = new Map<string, { space: Session; download(event: Electron.Event, item: DownloadItem, contents: WebContents): void }>();
  readonly #downloads = new Map<string, DownloadItem>();
  readonly #downloadDirectories = new Map<string, string>();
  readonly #surfaces = new Map<string, ManagedBrowserPresentation>();
  /** Recently resolved icons per space and icon URL; `""` remembers a URL that yielded none. */
  readonly #favicons = new Map<string, string>();
  readonly #releasedPages = new Set<string>();
  readonly #notifications = new Map<string, Notification>();
  readonly #controlChanges = new Map<string, Promise<void>>();
  readonly #windowStops = new Map<BrowserWindow, () => void>();
  #parking?: BrowserWindow;
  #runtime?: ManagedBrowserRuntime;
  #disposed = false;

  constructor(readonly options: { directory: string; downloadsDirectory: string; windowFor(key?: string): BrowserWindow | undefined; language?: () => string }) {
    this.store = new ManagedBrowserStore({ directory: options.directory, downloadsDirectory: options.downloadsDirectory, changed: sessionId => this.#changed(sessionId) });
    this.ready = this.store.load().then(() => mkdir(options.downloadsDirectory, { recursive: true })).then(() => undefined);
  }
  setRuntime(runtime: ManagedBrowserRuntime): void { this.#runtime = runtime; }
  subscribe(listener: (event: ManagedBrowserEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  /** Reading never loads pages: a page loads when a tab presents it, is selected, or the Agent attaches. */
  async read(sessionId: string): Promise<ManagedBrowserState> {
    await this.ready;
    return this.store.state(sessionId);
  }
  isReleased(pageId: string): boolean { return this.#releasedPages.has(pageId); }
  contents(pageId: string): WebContents | undefined { return this.#pages.get(pageId)?.view.webContents; }
  /** The relay holds this for attach/command work; catalog reads do not wake a page. */
  holdActivity(pageId: string): () => void {
    const live = this.#pages.get(pageId);
    if (!live) throw new Error("Managed browser page is not loaded.");
    return live.activity.hold();
  }
  pages(sessionId: string): ManagedBrowserPage[] { return this.store.state(sessionId).pages; }
  #emit(event: ManagedBrowserEvent): void { for (const listener of this.#listeners) listener(event); }
  #changed(sessionId: string): void {
    if (this.#disposed) return;
    this.#emit({ kind: "state", state: this.store.state(sessionId) });
    this.#runtime?.changed(sessionId);
    for (const live of this.#pages.values()) if (live.page.sessionId === sessionId) this.#inputState(live);
  }
  #error(sessionId: string, error: unknown): void { this.#emit({ kind: "error", sessionId, message: error instanceof Error ? error.message : String(error) }); }
  #owner(sessionId: string, pageId: string): ManagedBrowserPage {
    const page = this.store.page(pageId);
    if (!page || page.sessionId !== sessionId) throw new Error("This page does not belong to the selected chat.");
    return page;
  }
  #human(sessionId: string): void { if (this.store.state(sessionId).control !== "human") throw new Error("Take browser control before editing this page."); }
  #parkingWindow(): BrowserWindow {
    if (!this.#parking) {
      this.#parking = new BrowserWindow({ show: false, width: 1280, height: 900, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      void this.#parking.loadURL("about:blank");
    }
    return this.#parking;
  }
  #space(spaceId: string): Session {
    const existing = this.#spaces.get(spaceId);
    if (existing) return existing.space;
    const space = session.fromPartition(`persist:omp-managed-browser-${spaceId}`);
    space.setPermissionCheckHandler((contents, permission, origin, details) => {
      if (permission === "clipboard-sanitized-write") return true;
      const requestingOrigin = details.securityOrigin || origin;
      if (requestingOrigin === "null") return false;
      const normalizedOrigin = new URL(requestingOrigin).origin;
      const names = permission === "media" ? details.mediaType === "audio" || details.mediaType === "video" ? [`media:${details.mediaType}`] : ["media:audio", "media:video"] : [permission];
      return names.every(name => this.store.permissionFor(spaceId, normalizedOrigin, name)?.allowed === true);
    });
    space.setPermissionRequestHandler((contents, permission, callback, details) => {
      const live = [...this.#pages.values()].find(candidate => candidate.view.webContents === contents);
      if (!live) { callback(false); return; }
      if (permission === "clipboard-sanitized-write") { callback(true); return; }
      const securityOrigin = "securityOrigin" in details ? details.securityOrigin : undefined;
      if (securityOrigin === "null") { callback(false); return; }
      const origin = new URL(securityOrigin || details.requestingUrl || contents.getURL()).origin;
      const types = "mediaTypes" in details && details.mediaTypes?.length ? details.mediaTypes : ["audio", "video"];
      const names = permission === "media" ? types.map(type => `media:${type}`) : [permission];
      const existing = names.map(name => this.store.permissionFor(spaceId, origin, name));
      if (existing.some(entry => entry?.allowed === false)) { callback(false); return; }
      if (existing.every(entry => entry?.allowed === true)) { callback(true); return; }
      if (!["media", "notifications", "clipboard-read", "clipboard-readwrite", "geolocation", "fullscreen"].includes(permission)) { callback(false); return; }
      const zh = this.options.language?.() !== "en";
      const labels: Record<string, string> = { "media:audio": "麦克风", "media:video": "摄像头", notifications: "通知", "clipboard-read": "读取剪贴板", "clipboard-readwrite": "读取剪贴板", geolocation: "位置信息", fullscreen: "全屏" };
      const prompt = { type: "question" as const, title: zh ? "网站权限" : "Website permission", message: `${origin}\n${zh ? "请求使用：" + names.map(name => labels[name] ?? name).join("、") : `requests ${names.join(", ")}`}`, buttons: zh ? ["拒绝", "允许"] : ["Deny", "Allow"], defaultId: 0, cancelId: 0, checkboxLabel: zh ? "在此浏览空间记住选择" : "Remember in this browser space", checkboxChecked: false };
      void dialog.showMessageBox(live.parent === this.#parking ? this.options.windowFor() ?? live.parent : live.parent, prompt).then(result => {
        const allowed = result.response === 1;
        if (result.checkboxChecked) for (const name of names) this.store.permission({ spaceId, origin, permission: name, allowed });
        callback(allowed);
      }, () => callback(false));
    });
    const download = (_event: Electron.Event, item: DownloadItem, contents: WebContents) => this.#download(item, contents);
    space.on("will-download", download);
    this.#spaces.set(spaceId, { space, download });
    return space;
  }
  async create(sessionId: string, address: string, source: "human" | "agent", spaceId = "shared", opener: Omit<ManagedBrowserPageOpener, "source"> = {}): Promise<ManagedBrowserPage> {
    await this.ready;
    const previous = this.store.state(sessionId);
    await mkdir(previous.settings.downloadDirectory || this.options.downloadsDirectory, { recursive: true });
    if (!previous.spaces.some(space => space.id === spaceId)) throw new Error("Browser space not found.");
    if (source === "human" && !previous.pages.length && previous.connection === "connected") await this.#control(sessionId, "human");
    if (previous.pages.length && (source === "human" ? previous.control !== "human" : previous.control === "human")) throw new Error(source === "human" ? "Take browser control before opening a page." : "The user controls this chat's browser. Wait for control to be returned.");
    this.#space(spaceId);
    const page = this.store.create(sessionId, normalizeBrowserAddress(address), source, spaceId, opener);
    await this.ensure(page.id);
    return page;
  }
  async ensure(pageId: string): Promise<WebContents> {
    await this.ready;
    const existing = this.#pages.get(pageId);
    if (existing) return existing.view.webContents;
    const page = this.store.page(pageId);
    if (!page) throw new Error("Browser page no longer exists.");
    this.#releasedPages.delete(pageId);
    const live = this.#newPage(page);
    void live.view.webContents.loadURL(page.url).catch(error => { if (!live.closed && (error as { code?: string }).code !== "ERR_ABORTED") this.store.update(pageId, { status: "error", error: String(error) }); });
    return live.view.webContents;
  }
  #updateVisibility(live: LivePage): void {
    live.activity.update({ visible: live.presentation?.visible === true && !live.parent.isDestroyed() && live.parent.isVisible() && !live.parent.isMinimized() });
  }
  #watchWindow(window: BrowserWindow): void {
    if (this.#windowStops.has(window)) return;
    const update = () => { for (const live of this.#pages.values()) if (live.parent === window) this.#updateVisibility(live); };
    const close = () => { update(); stop(); this.#windowStops.delete(window); };
    const stop = () => {
      window.removeListener("show", update); window.removeListener("hide", update);
      window.removeListener("minimize", update); window.removeListener("restore", update);
      window.removeListener("closed", close);
    };
    window.on("show", update); window.on("hide", update);
    window.on("minimize", update); window.on("restore", update);
    window.once("closed", close);
    this.#windowStops.set(window, stop);
  }
  #newPage(page: ManagedBrowserPage, options?: Electron.WebContentsViewConstructorOptions): LivePage {
    const webPreferences = { ...options?.webPreferences, session: this.#space(page.spaceId), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, backgroundThrottling: false };
    delete webPreferences.preload;
    const view = new WebContentsView({ ...options, webPreferences });
    const clip = new View();
    clip.setBounds({ x: 0, y: 0, width: 1100, height: 720 });
    view.setBounds({ x: 0, y: 0, width: 1100, height: 720 });
    clip.addChildView(view);
    const parent = this.#parkingWindow(); parent.contentView.addChildView(clip);
    const focusEmulation = new Set<string>();
    const activity = new BrowserPageActivity(throttled => {
      const contents = view.webContents;
      // A new page already starts awake. Capturing its initial empty document can
      // compete with the first navigation; only real state transitions need it.
      if (contents.getBackgroundThrottling() === throttled) return;
      // Chromium keeps the old visibility after changing throttling on a parked view.
      // A capture reapplies visibility without navigating or replacing the live page.
      const refreshVisibility = () => { void contents.capturePage(undefined, { stayHidden: throttled }).catch(error => {
        if (!contents.isDestroyed()) console.warn("[managed-browser] Could not refresh page visibility", error);
      }); };
      if (!throttled) refreshVisibility();
      contents.setBackgroundThrottling(throttled);
      if (throttled) refreshVisibility();
      if (contents.debugger.isAttached()) for (const sessionId of focusEmulation) {
        void contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: !throttled }, sessionId || undefined)
          .catch(() => focusEmulation.delete(sessionId));
      }
    });
    const live: LivePage = { page, view, clip, parent, activity, focusEmulation, picking: false, closed: false, agentInputs: 0 };
    this.#pages.set(page.id, live);
    this.#watchWindow(parent);
    const contents = view.webContents;
    live.inspection = new ManagedBrowserInspection(contents, () => this.#runtime?.ownsDebugger?.(page.id) === true);
    this.store.update(page.id, { descriptor: { targetId: `electron:${contents.id}`, ownerSessionId: page.sessionId, sessionId: page.sessionId, generation: randomUUID(), ownership: "owned",
      engine: process.versions.chrome ? "chromium" : "unknown", transport: "embedded", embeddedPageId: page.id,
      capabilities: { observe: true, control: true, nativeViewer: false, history: true, console: true, network: true, downloads: true, webmcp: !!process.versions.chrome, pdf: true, cdp: true, tracing: true, zoom: true, find: true, pick: true, devtools: true, settings: true,
        reasons: { nativeViewer: "The embedded adapter presents this same WebContentsView inside Studio, not in a separate native viewer.", network: "Request metadata is captured while Network is visible; response bodies are not copied to Studio." } } } });
    contents.setZoomFactor(page.zoom);
    const update = () => {
      if (live.closed || contents.isDestroyed()) return;
      activity.update({ devtools: contents.isDevToolsOpened() });
      this.store.update(page.id, { url: contents.getURL() || page.url, title: contents.getTitle() || page.url, canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(), devtools: contents.isDevToolsOpened() });
    };
    contents.on("did-start-loading", () => { activity.update({ loading: true }); if (!live.closed) this.store.update(page.id, { status: "loading", error: undefined }); });
    contents.on("did-stop-loading", () => { activity.update({ loading: false }); if (!live.closed && page.status === "loading") this.store.update(page.id, { status: "ready" }); update(); });
    contents.on("media-started-playing", () => activity.update({ media: true }));
    contents.on("media-paused", () => activity.update({ media: false }));
    contents.on("audio-state-changed", event => activity.update({ audible: event.audible }));
    contents.once("destroyed", () => activity.dispose());
    const navigated = () => { if (!live.closed) { this.#stopPicking(live); this.store.update(page.id, { documentId: randomUUID() }); } update(); };
    contents.on("did-navigate", navigated); contents.on("did-navigate-in-page", navigated); contents.on("page-title-updated", update);
    let origin = originOf(page.url);
    contents.on("did-navigate", (_event, url) => {
      const next = originOf(url);
      if (next === origin && url !== "about:blank") return;
      origin = next; live.favicon?.abort();
      if (!live.closed && page.favicon) this.store.update(page.id, { favicon: undefined });
    });
    contents.on("page-favicon-updated", (_event, favicons) => void this.#favicon(live, favicons));
    contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => { if (!live.closed && mainFrame && code !== -3) this.store.update(page.id, { status: "error", error: description }); });
    contents.on("render-process-gone", (_event, details) => { activity.update({ loading: false, media: false, audible: false }); if (!live.closed) { this.#stopPicking(live, false); this.store.update(page.id, { status: "crashed", error: details.reason }); } });
    contents.on("devtools-opened", update); contents.on("devtools-closed", update);
    contents.on("before-input-event", (event, input) => {
      if (live.agentInputs > 0) return;
      if (this.store.state(page.sessionId).control !== "human" && contents.isFocused()) { event.preventDefault(); return; }
      if (this.store.state(page.sessionId).control !== "human") return;
      const modifier = input.control || input.meta;
      if (input.type === "keyDown" && modifier && ["l", "f", "r", "t", "w"].includes(input.key.toLowerCase())) {
        event.preventDefault(); const key = input.key.toLowerCase();
        // Address, find and the new tab's start page are renderer inputs: give the window focus before they ask for it.
        if (["l", "f", "t"].includes(key) && !live.parent.isDestroyed()) live.parent.webContents.focus();
        if (key === "l" || key === "f") this.#emit({ kind: "shortcut", sessionId: page.sessionId, pageId: page.id, action: key === "l" ? "address" : "find" });
        else if (key === "r") { if (input.shift) contents.reloadIgnoringCache(); else contents.reload(); }
        else if (key === "w") void this.close(page.sessionId, page.id).catch(error => this.#error(page.sessionId, error));
        else void this.create(page.sessionId, "about:blank", "human", page.spaceId, { pageId: page.id }).catch(error => this.#error(page.sessionId, error));
        return;
      }
      if (input.type === "keyDown" && modifier && ["+", "=", "-", "0"].includes(input.key)) {
        event.preventDefault(); const zoom = input.key === "0" ? 1 : Math.min(3, Math.max(0.25, contents.getZoomFactor() + (input.key === "-" ? -0.1 : 0.1)));
        contents.setZoomFactor(zoom); this.store.update(page.id, { zoom });
      }
    });
    contents.on("before-mouse-event", event => { if (!live.agentInputs && this.store.state(page.sessionId).control !== "human" && contents.isFocused()) event.preventDefault(); });
    contents.on("focus", () => {
      const state = this.store.state(page.sessionId);
      if (state.control !== "human") { if (!live.parent.isDestroyed()) live.parent.webContents.focus(); return; }
      if (state.activePageId !== page.id) this.store.select(page.sessionId, page.id);
    });
    contents.on("will-navigate", (event, url) => { if (!/^https?:/iu.test(url) && url !== "about:blank") event.preventDefault(); });
    contents.setWindowOpenHandler(details => {
      try {
        if (!/^https?:/iu.test(details.url) && details.url !== "about:blank" && !details.url.startsWith("blob:")) return { action: "deny" };
        if (this.store.state(page.sessionId).pages.length >= this.store.state(page.sessionId).settings.maxTabs) throw new Error("Browser tab limit reached. Close a tab or raise the limit.");
        return { action: "allow", outlivesOpener: true, createWindow: options => {
          const child = this.store.create(page.sessionId, details.url, this.store.state(page.sessionId).control === "human" ? "human" : "agent", page.spaceId, { pageId: page.id, popup: true });
          return this.#newPage(child, options).view.webContents;
        } };
      } catch (error) { this.#error(page.sessionId, error); return { action: "deny" }; }
    });
    contents.on("context-menu", (_event, details) => {
      if (this.store.state(page.sessionId).control !== "human") return;
      const items: Electron.MenuItemConstructorOptions[] = [{ role: "copy", enabled: !!details.selectionText }, { role: "paste", enabled: details.isEditable }, { role: "selectAll" }];
      if (details.linkURL) items.push({ type: "separator" }, { label: "在新标签打开 / Open in new tab", click: () => { void this.create(page.sessionId, details.linkURL, "human", page.spaceId, { pageId: page.id }).catch(error => this.#error(page.sessionId, error)); } }, { label: "系统浏览器 / System browser", click: () => { if (/^https?:/iu.test(details.linkURL)) void shell.openExternal(details.linkURL); } });
      items.push({ type: "separator" }, { label: "检查元素 / Inspect", click: () => { void this.execute({ sessionId: page.sessionId, action: "devtools", pageId: page.id }).then(() => contents.inspectElement(details.x, details.y)).catch(error => this.#error(page.sessionId, error)); } });
      Menu.buildFromTemplate(items).popup({ window: live.parent });
    });
    this.#inputState(live);
    return live;
  }
  #inputState(live: LivePage): void {
    if (live.closed) return;
    const locked = this.store.state(live.page.sessionId).control !== "human";
    if (locked && live.presentation?.visible && !live.shield) {
      live.shield = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      live.shield.setBackgroundColor("#00000000");
      live.shield.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      live.shield.webContents.on("will-navigate", event => event.preventDefault());
      void live.shield.webContents.loadURL("data:text/html,<html style='background:transparent'><body style='margin:0;cursor:default' ondragover='event.preventDefault()' ondrop='event.preventDefault()'></body></html>");
      live.clip.addChildView(live.shield);
    }
    if (live.shield) { const bounds = live.clip.getBounds(); live.shield.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height }); live.shield.setVisible(locked); }
    if (locked && live.view.webContents.isFocused() && !live.parent.isDestroyed()) live.parent.webContents.focus();
  }
  async present(presentation: ManagedBrowserPresentation): Promise<void> {
    await this.ready;
    const previous = this.#surfaces.get(presentation.surfaceId);
    if (previous?.pageId && previous.pageId !== presentation.pageId) this.#park(previous.pageId, presentation.surfaceId);
    if (presentation.visible) this.#surfaces.set(presentation.surfaceId, presentation);
    else this.#surfaces.delete(presentation.surfaceId);
    if (!presentation.pageId) return;
    this.#owner(presentation.sessionId, presentation.pageId);
    if (!presentation.visible || presentation.clip.width <= 0 || presentation.clip.height <= 0) { this.#park(presentation.pageId, presentation.surfaceId); return; }
    // Presenting loads a dormant page, except one the user released on purpose: that waits for an explicit reload.
    if (this.#releasedPages.has(presentation.pageId)) { this.#park(presentation.pageId, presentation.surfaceId); return; }
    const parent = this.options.windowFor(presentation.windowKey);
    if (!parent || parent.isDestroyed()) return;
    await this.ensure(presentation.pageId);
    const live = this.#pages.get(presentation.pageId)!;
    if (live.parent !== parent) { live.parent.contentView.removeChildView(live.clip); parent.contentView.addChildView(live.clip); live.parent = parent; }
    const factor = parent.webContents.getZoomFactor();
    const pixel = (value: number) => Math.round(value * factor);
    const bounds = presentation.bounds, clip = presentation.clip;
    live.clip.setBounds({ x: pixel(clip.x), y: pixel(clip.y), width: pixel(clip.width), height: pixel(clip.height) });
    live.view.setBounds({ x: pixel(bounds.x - clip.x), y: pixel(bounds.y - clip.y), width: pixel(bounds.width), height: pixel(bounds.height) });
    live.presentation = presentation;
    live.clip.setVisible(true);
    this.#watchWindow(parent);
    this.#updateVisibility(live);
    this.#inputState(live);
  }
  #park(pageId: string, surfaceId?: string): void {
    const live = this.#pages.get(pageId);
    if (!live || (surfaceId && live.presentation?.surfaceId !== surfaceId)) return;
    delete live.presentation;
    this.#stopPicking(live);
    void live.inspection?.stop();
    live.clip.setVisible(false);
    this.#updateVisibility(live);
    const parking = this.#parkingWindow();
    if (live.parent !== parking) { if (!live.parent.isDestroyed()) live.parent.contentView.removeChildView(live.clip); parking.contentView.addChildView(live.clip); live.parent = parking; }
  }
  detachWindow(window: BrowserWindow): void { for (const live of this.#pages.values()) if (live.parent === window) this.#park(live.page.id); }
  async close(sessionId: string, pageId: string): Promise<void> {
    this.#owner(sessionId, pageId);
    this.store.close(sessionId, pageId);
    this.#releasedPages.delete(pageId);
    this.#downloadDirectories.delete(pageId);
    await this.#destroyPage(pageId);
  }
  async #destroyPage(pageId: string): Promise<void> {
    const live = this.#pages.get(pageId);
    if (!live) return;
    live.closed = true; live.activity.dispose(); live.inspection?.dispose(); live.favicon?.abort(); this.#stopPicking(live); this.#pages.delete(pageId);
    this.#runtime?.closed(pageId);
    if (!live.parent.isDestroyed()) live.parent.contentView.removeChildView(live.clip);
    const children = [live.view, ...(live.shield ? [live.shield] : [])];
    for (const child of children) {
      live.clip.removeChildView(child);
      if (!child.webContents.isDestroyed()) {
        child.webContents.closeDevTools();
        if (child.webContents.debugger.isAttached()) child.webContents.debugger.detach();
        await new Promise<void>(resolve => { child.webContents.once("destroyed", () => resolve()); child.webContents.close({ waitForBeforeUnload: false }); });
      }
    }
  }
  async #control(sessionId: string, control: "human" | "agent"): Promise<void> {
    const pending = this.#controlChanges.get(sessionId);
    const operation = async () => {
      try {
        if (control === "agent" && this.pages(sessionId).some(page => page.devtools)) throw new Error("Close DevTools before returning browser control.");
        this.store.control(sessionId, "waiting");
        if (control === "agent") for (const page of this.pages(sessionId)) this.#stopPicking(this.#pages.get(page.id));
        await this.#runtime?.control(sessionId, control);
        for (const page of this.pages(sessionId)) {
          const contents = this.contents(page.id);
          if (contents && !contents.isDestroyed() && contents.debugger.isAttached()) await this.agentCommand(page.id, "Emulation.setFocusEmulationEnabled", { enabled: control === "agent" });
        }
        if (control === "human") for (const page of this.pages(sessionId)) this.#downloadDirectories.delete(page.id);
        this.store.control(sessionId, control);
      } catch (error) { this.#error(sessionId, error); throw error; }
    };
    const promise = (pending ?? Promise.resolve()).catch(() => undefined).then(operation); this.#controlChanges.set(sessionId, promise);
    try { await promise; } finally { if (this.#controlChanges.get(sessionId) === promise) this.#controlChanges.delete(sessionId); }
  }
  async execute(command: ManagedBrowserCommand): Promise<ManagedBrowserState> {
    await this.ready;
    const { sessionId, action } = command;
    if ("pageId" in command) this.#owner(sessionId, command.pageId);
    if (["navigate", "close", "close-others", "reload", "stop", "back", "forward", "zoom", "find"].includes(action)) this.#human(sessionId);
    switch (action) {
      case "create": await this.create(sessionId, command.url, "human", command.spaceId, command.openerPageId ? { pageId: command.openerPageId } : {}); break;
      case "select": this.store.select(sessionId, command.pageId); await this.ensure(command.pageId); break;
      case "close": await this.close(sessionId, command.pageId); break;
      case "close-handoff": {
        // Closing a tab never asks for a manual takeover: wait out the Agent's current step, close, then hand control back.
        await this.#controlChanges.get(sessionId)?.catch(() => undefined);
        const restore = this.store.state(sessionId).control !== "human";
        if (restore) await this.#control(sessionId, "human");
        await this.close(sessionId, command.pageId);
        if (restore) await this.#control(sessionId, "agent").catch(() => undefined);
        break;
      }
      case "close-others": for (const page of this.pages(sessionId)) if (page.id !== command.pageId) await this.close(sessionId, page.id); break;
      case "navigate": { const contents = await this.ensure(command.pageId); void contents.loadURL(normalizeBrowserAddress(command.url)).catch(error => { if ((error as { code?: string }).code !== "ERR_ABORTED") this.#error(sessionId, error); }); break; }
      case "reload": (await this.ensure(command.pageId)).reload(); break;
      case "stop": (await this.ensure(command.pageId)).stop(); break;
      case "back": { const contents = await this.ensure(command.pageId); if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break; }
      case "forward": { const contents = await this.ensure(command.pageId); if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break; }
      case "zoom": { const factor = Math.max(0.25, Math.min(3, command.factor)); (await this.ensure(command.pageId)).setZoomFactor(factor); this.store.update(command.pageId, { zoom: factor }); break; }
      case "find": { const contents = await this.ensure(command.pageId); if (command.text) contents.findInPage(command.text, { forward: command.forward ?? true }); else contents.stopFindInPage("clearSelection"); break; }
      case "viewer": throw new Error("The embedded adapter has no separate same-view native viewer.");
      case "take": await this.#control(sessionId, "human"); break;
      case "return": await this.#control(sessionId, "agent"); break;
      case "release": await this.#control(sessionId, "human"); for (const page of this.pages(sessionId)) { this.#releasedPages.add(page.id); this.store.update(page.id, { status: "released" }); await this.#destroyPage(page.id); } this.store.release(sessionId); break;
      case "devtools": {
        await this.#control(sessionId, "human"); const contents = await this.ensure(command.pageId); this.#stopPicking(this.#pages.get(command.pageId));
        if (contents.isDevToolsOpened()) contents.closeDevTools();
        else { this.store.update(command.pageId, { devtools: true }); if (contents.debugger.isAttached()) contents.debugger.detach(); contents.openDevTools({ mode: "detach", activate: true }); }
        break;
      }
      case "pick": await this.#control(sessionId, "human"); await this.#startPicking(command.pageId); break;
      case "stop-picking": for (const page of this.pages(sessionId)) this.#stopPicking(this.#pages.get(page.id)); break;
      case "space-create": if (!command.name.trim()) throw new Error("Enter a browser space name."); this.store.addSpace(command.name.trim()); break;
      case "settings": {
        if (command.settings.maxTabs !== undefined && (!Number.isInteger(command.settings.maxTabs) || command.settings.maxTabs < 1)) throw new Error("The tab limit must be a positive integer.");
        const settings = { ...command.settings };
        if (settings.downloadDirectory !== undefined) { settings.downloadDirectory = settings.downloadDirectory.trim() || this.options.downloadsDirectory; await mkdir(settings.downloadDirectory, { recursive: true }); }
        this.store.settings(settings); break;
      }
      case "permission-forget": this.store.forgetPermission(command.spaceId, command.origin, command.permission); break;
      case "download-cancel": { const found = this.store.state(sessionId).downloads.find(download => download.id === command.downloadId); if (found) this.#downloads.get(found.id)?.cancel(); break; }
      case "download-open": case "download-reveal": {
        const download = this.store.state(sessionId).downloads.find(value => value.id === command.downloadId);
        if (!download || download.state !== "completed") throw new Error("Download is not complete.");
        if (action === "download-open") { const error = await shell.openPath(download.path); if (error) throw new Error(error); }
        else shell.showItemInFolder(download.path);
        break;
      }
    }
    return this.store.state(sessionId);
  }
  async #favicon(live: LivePage, candidates: readonly string[]): Promise<void> {
    const url = pickFaviconUrl(candidates);
    live.favicon?.abort();
    if (!url || live.closed) return;
    const key = `${live.page.spaceId}\n${url}`, cached = this.#favicons.get(key);
    if (cached !== undefined) { if (cached && live.page.favicon !== cached) this.store.update(live.page.id, { favicon: cached }); return; }
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000);
    live.favicon = abort;
    try {
      const bytes = await loadFavicon(url, (target, init) => this.#space(live.page.spaceId).fetch(target, init), abort.signal);
      const icon = bytes ? faviconDataUrl(bytes, shrinkFavicon) : undefined;
      if (abort.signal.aborted || live.closed) return;
      this.#favicons.set(key, icon ?? "");
      if (this.#favicons.size > 64) this.#favicons.delete(this.#favicons.keys().next().value!);
      if (icon && live.page.favicon !== icon) this.store.update(live.page.id, { favicon: icon });
    } catch { /* An icon is decoration: a failed fetch keeps the previous one. */ }
    finally { clearTimeout(timer); if (live.favicon === abort) delete live.favicon; }
  }
  async #startPicking(pageId: string): Promise<void> {
    const contents = await this.ensure(pageId), live = this.#pages.get(pageId)!;
    if (contents.isDevToolsOpened()) throw new Error("Close DevTools before selecting page elements.");
    this.#stopPicking(live);
    const release = live.activity.hold();
    try {
      await contents.executeJavaScriptInIsolatedWorld(BROWSER_PICKER_WORLD_ID, [{ code: BROWSER_PICKER_START }]);
      live.picking = true;
      live.activity.update({ picking: true });
    } finally { release(); }
    this.#emit({ kind: "picker", sessionId: live.page.sessionId, pageId, active: true });
    let reading = false;
    live.picker = setInterval(() => {
      if (reading || live.closed || !live.picking) return;
      reading = true;
      void (async () => {
        const poll = await contents.executeJavaScriptInIsolatedWorld(BROWSER_PICKER_WORLD_ID, [{ code: BROWSER_PICKER_POLL }]) as BrowserPickerPoll;
        for (const selection of poll.selections) {
          const documentId = live.page.documentId;
          const zoom = contents.getZoomFactor();
          const region = { x: Math.floor(selection.rect.x * zoom), y: Math.floor(selection.rect.y * zoom), width: Math.max(1, Math.ceil(selection.rect.width * zoom)), height: Math.max(1, Math.ceil(selection.rect.height * zoom)) };
          let screenshot: BrowserElementReference["screenshot"];
          try { screenshot = { mimeType: "image/png", data: (await this.capture(pageId, region)).toPNG().toString("base64") }; }
          catch (error) { this.#error(live.page.sessionId, error); }
          if (live.closed || !live.picking) break;
          if (live.page.documentId !== documentId || live.page.url !== selection.url) screenshot = undefined;
          const reference: BrowserElementReference = { ...selection, pageId, id: randomUUID(), note: "", capturedAt: new Date().toISOString(), ...(documentId ? { documentId } : {}), ...(screenshot ? { screenshot } : {}) };
          this.#emit({ kind: "selection", sessionId: live.page.sessionId, reference });
        }
        if (!poll.active) this.#stopPicking(live);
      })().catch(error => { this.#stopPicking(live); this.#error(live.page.sessionId, error); }).finally(() => { reading = false; });
    }, 120);
  }
  #stopPicking(live?: LivePage, clearOverlay = true): void {
    if (!live) return;
    const wasPicking = live.picking;
    if (wasPicking) this.#emit({ kind: "picker", sessionId: live.page.sessionId, pageId: live.page.id, active: false });
    live.picking = false;
    live.activity.update({ picking: false });
    if (live.picker) { clearInterval(live.picker); delete live.picker; }
    if (wasPicking && clearOverlay && !live.closed && !live.view.webContents.isDestroyed()) void live.view.webContents.executeJavaScriptInIsolatedWorld(BROWSER_PICKER_WORLD_ID, [{ code: BROWSER_PICKER_STOP }]).catch(() => undefined);
  }
  async capture(pageId: string, rect?: Electron.Rectangle): Promise<Electron.NativeImage> {
    const contents = await this.ensure(pageId);
    const release = this.holdActivity(pageId);
    const attached = contents.debugger.isAttached();
    try {
      if (!attached) contents.debugger.attach("1.3");
      const result = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png", fromSurface: true });
      const image = nativeImage.createFromBuffer(Buffer.from(result.data as string, "base64"));
      if (!rect) return image;
      const layout = await contents.executeJavaScript("({width:innerWidth,zoom:devicePixelRatio})");
      const factor = image.getSize().width / (Number(layout.width) * contents.getZoomFactor());
      const size = image.getSize(), x = Math.max(0, Math.round(rect.x * factor)), y = Math.max(0, Math.round(rect.y * factor));
      return image.crop({ x, y, width: Math.max(1, Math.min(size.width - x, Math.round(rect.width * factor))), height: Math.max(1, Math.min(size.height - y, Math.round(rect.height * factor))) });
    } finally { release(); if (!attached && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach(); }
  }
  releaseInspectionWindow(owner: string): void { for (const live of this.#pages.values()) void live.inspection?.releaseOwner(owner); }
  async inspect(request: ManagedBrowserInspectionRequest, owner = "local"): Promise<BrowserPageInspection> {
    await this.ready;
    const page = this.#owner(request.sessionId, request.pageId), live = this.#pages.get(page.id);
    if (request.generation && request.generation !== page.descriptor?.generation) throw new Error("The embedded page generation changed; refresh the page before inspecting it.");
    if (request.view !== "console" && request.view !== "network" && request.view !== "downloads") throw new Error("Unknown browser inspection view.");
    if (!live?.inspection) return { view: request.view, rows: [], reason: "The page is dormant. Show it first; inspecting does not load or reopen it." };
    if (!request.visible) return live.inspection.read(request.view, false, owner);
    if (request.view === "downloads") return { view: "downloads", rows: this.store.state(page.sessionId).downloads.filter(row => row.pageId === page.id).slice(-200).map(row => ({ name: row.name, url: row.url, path: row.path, bytes: row.receivedBytes, state: row.state })) };
    return live.inspection.read(request.view, true, owner);
  }
  async downloadOperation(pageId: string, action: "enable" | "list", directory?: string): Promise<unknown> {
    const page = this.store.page(pageId);
    if (!page) throw new Error("Browser page no longer exists.");
    if (action === "enable") { if (directory) { await mkdir(directory, { recursive: true }); this.#downloadDirectories.set(pageId, directory); } return {}; }
    return this.store.state(page.sessionId).downloads.filter(download => download.pageId === pageId).map(download => ({ id: download.id, path: download.path, suggestedFilename: download.name, url: download.url, bytes: download.receivedBytes, state: download.state }));
  }
  async agentCommand(pageId: string, method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    const live = this.#pages.get(pageId);
    if (!live) throw new Error("Managed browser page is not loaded.");
    const release = live.activity.hold();
    const input = method.startsWith("Input.");
    if (method === "Emulation.setFocusEmulationEnabled") {
      if (params?.enabled === true) live.focusEmulation.add(sessionId ?? "");
      else live.focusEmulation.delete(sessionId ?? "");
    }
    if (input) live.agentInputs++;
    try { return await live.view.webContents.debugger.sendCommand(method, params, sessionId); }
    finally { if (input) live.agentInputs--; release(); }
  }
  #download(item: DownloadItem, contents: WebContents): void {
    const page = [...this.#pages.values()].find(live => live.view.webContents === contents)?.page;
    if (!page) { item.cancel(); return; }
    const settings = this.store.state(page.sessionId).settings;
    const targetDirectory = this.#downloadDirectories.get(page.id) ?? settings.downloadDirectory;
    const download: ManagedBrowserDownload = { id: randomUUID(), pageId: page.id, name: basename(item.getFilename()), url: item.getURL(), path: "", receivedBytes: 0, totalBytes: item.getTotalBytes(), state: "progressing" };
    this.#downloads.set(download.id, item);
    if (settings.askDownloadLocation && !this.#downloadDirectories.has(page.id)) item.setSaveDialogOptions({ defaultPath: join(targetDirectory, download.name) });
    else {
      let target = join(targetDirectory, download.name), suffix = 1;
      while (existsSync(target) || [...this.#downloads.values()].some(download => download !== item && download.getSavePath() === target)) target = join(targetDirectory, `${suffix++}-${download.name}`);
      item.setSavePath(target);
    }
    const release = this.holdActivity(page.id);
    const publish = () => { download.path = item.getSavePath(); download.receivedBytes = item.getReceivedBytes(); download.totalBytes = item.getTotalBytes(); this.store.download(page.sessionId, download); };
    item.on("updated", (_event, state) => { download.state = state === "interrupted" ? "interrupted" : "progressing"; publish(); });
    item.once("done", (_event, state) => {
      release();
      download.state = state; publish(); this.#downloads.delete(download.id);
      if (state === "completed" && Notification.isSupported()) {
        const notification = new Notification({ title: "下载完成 / Download complete", body: download.name });
        this.#notifications.set(download.id, notification); notification.once("close", () => this.#notifications.delete(download.id)); notification.show();
      }
    });
    publish();
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#runtime?.dispose();
    for (const pageId of [...this.#pages.keys()]) await this.#destroyPage(pageId);
    for (const item of this.#downloads.values()) item.cancel();
    for (const { space, download } of this.#spaces.values()) { space.removeListener("will-download", download); space.setPermissionCheckHandler(null); space.setPermissionRequestHandler(null); }
    this.#spaces.clear();
    for (const stop of this.#windowStops.values()) stop();
    this.#windowStops.clear();
    this.#parking?.destroy();
    await this.store.flush();
    this.#listeners.clear();
  }
}
