import { randomUUID } from "node:crypto";
import type { BrowserWindow, IpcMain, Rectangle, WebContents } from "electron";
import { FLOAT_WINDOW_CHANNELS as CHANNELS, type FloatWindowControl, type FloatWindowEvent, type FloatWindowPrepare, type FloatWindowTicket } from "./floating-windows-shared.js";
import { isExternalWebLink, isTrustedRendererUrl, secureWebPreferences } from "./security.js";

type Entry = { key: string; url: string; input: FloatWindowPrepare; window?: BrowserWindow; closing: boolean };
export function visibleWindowBounds(rect: Rectangle, areas: readonly Rectangle[]): Rectangle {
  const area = areas.find(a => rect.x < a.x + a.width && rect.x + rect.width > a.x && rect.y < a.y + a.height && rect.y + rect.height > a.y) ?? areas[0]!;
  const width = Math.min(Math.max(320, Math.round(rect.width)), area.width);
  const height = Math.min(Math.max(200, Math.round(rect.height)), area.height);
  return { x: Math.round(Math.max(area.x, Math.min(rect.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(rect.y, area.y + area.height - height))), width, height };
}

/** The opener owns business state; these windows only host the existing panel DOM. */
export function registerFloatingWindows(options: {
  parent: BrowserWindow; ipcMain: Pick<IpcMain, "handle" | "removeHandler">; allowedOrigin: string; preloadPath: string;
  areas: () => Rectangle[]; isQuitting: () => boolean; openExternal: (url: string) => void;
  onWindow?: (window: BrowserWindow) => void; onVisibility?: (window: BrowserWindow) => void; onClosed?: (contents: WebContents) => void;
  onWillClose?: (window: BrowserWindow) => void;
}) {
  const { parent, ipcMain } = options;
  const entries = new Map<string, Entry>();
  const destroy = (window: BrowserWindow) => { options.onWillClose?.(window); window.destroy(); };
  const send = (event: FloatWindowEvent) => { if (!parent.webContents.isDestroyed()) parent.webContents.send(CHANNELS.changed, event); };
  const owns = (sender: { getURL(): string }) => [...entries.values()].some(entry => entry.window?.webContents === sender);
  const visible = () => [...entries.values()].some(entry => entry.window?.isVisible() && !entry.window.isMinimized());
  const refreshThrottle = () => { if (!parent.webContents.isDestroyed()) parent.webContents.setBackgroundThrottling(!visible()); };
  const showMain = () => { if (parent.isMinimized()) parent.restore(); parent.show(); parent.focus(); };

  ipcMain.handle(CHANNELS.prepare, (event, input: FloatWindowPrepare): FloatWindowTicket => {
    if (event.sender !== parent.webContents || !isTrustedRendererUrl(event.sender.getURL(), options.allowedOrigin)) throw new Error("Untrusted floating window request");
    if (!input || typeof input.id !== "string" || typeof input.title !== "string") throw new Error("Invalid floating window request");
    const existing = [...entries.values()].find(entry => entry.input.id === input.id);
    if (existing) return { key: existing.key, url: existing.url };
    const key = randomUUID();
    const url = new URL(parent.webContents.getURL());
    url.searchParams.set("dockHost", key); url.hash = "";
    entries.set(key, { key, url: url.href, input, closing: false });
    return { key, url: url.href };
  });

  parent.webContents.setWindowOpenHandler((details) => {
    const entry = [...entries.values()].find(item => !item.window && item.url === details.url && details.frameName === item.key);
    if (!entry) { if (isExternalWebLink(details.url)) options.openExternal(details.url); return { action: "deny" }; }
    const fallback = parent.getContentBounds(), zoom = parent.webContents.getZoomFactor(), source = entry.input.sourceRect;
    const initial = source ? { x: fallback.x + source.x * zoom, y: fallback.y + source.y * zoom, width: source.width * zoom, height: source.height * zoom } : { x: fallback.x + 100, y: fallback.y + 100, width: 560, height: 400 };
    const rect = visibleWindowBounds(entry.input.rect ?? initial, options.areas());
    return { action: "allow", outlivesOpener: true, overrideBrowserWindowOptions: { ...rect, useContentSize: false, minWidth: entry.input.minWidth ?? 320, minHeight: entry.input.minHeight ?? 200, show: false, frame: false, resizable: true, minimizable: true, maximizable: true, fullscreenable: false, skipTaskbar: false, title: entry.input.title, alwaysOnTop: entry.input.topmost, webPreferences: secureWebPreferences(options.preloadPath) } };
  });

  const didCreate = (child: BrowserWindow, details: { frameName: string }) => {
    const entry = entries.get(details.frameName);
    if (!entry) { child.destroy(); return; }
    entry.window = child;
    const contents = child.webContents;
    child.webContents.setWindowOpenHandler(({ url }) => { if (isExternalWebLink(url)) options.openExternal(url); return { action: "deny" }; });
    child.webContents.on("will-navigate", (event, url) => { if (url !== entry.url) event.preventDefault(); });
    const publish = () => {
      if (child.isDestroyed() || entry.closing) return;
      refreshThrottle(); options.onVisibility?.(child);
      send({ key: entry.key, id: entry.input.id, kind: "state", rect: child.getNormalBounds(), minimized: child.isMinimized(), maximized: child.isMaximized(), visible: child.isVisible() && !child.isMinimized() });
    };
    child.on("move", publish); child.on("resize", publish); child.on("maximize", publish); child.on("unmaximize", publish);
    child.on("minimize", publish); child.on("restore", publish); child.on("show", publish); child.on("hide", publish);
    child.on("close", event => {
      if (options.isQuitting() || entry.closing) { options.onWillClose?.(child); return; }
      event.preventDefault(); send({ key: entry.key, id: entry.input.id, kind: "close-request" });
    });
    child.on("closed", () => { entries.delete(entry.key); options.onClosed?.(contents); refreshThrottle(); send({ key: entry.key, id: entry.input.id, kind: "closed" }); });
    options.onWindow?.(child);
  };
  parent.webContents.on("did-create-window", didCreate);
  const closeWindows = () => {
    for (const entry of entries.values()) { entry.closing = true; if (entry.window && !entry.window.isDestroyed()) destroy(entry.window); }
    entries.clear();
  };
  parent.webContents.once("destroyed", closeWindows);

  ipcMain.handle(CHANNELS.control, (event, input: FloatWindowControl) => {
    if (event.sender !== parent.webContents || !isTrustedRendererUrl(event.sender.getURL(), options.allowedOrigin)) throw new Error("Untrusted floating window control");
    if (!input || typeof input.key !== "string") throw new Error("Invalid floating window control");
    if (input.action === "showMain") { showMain(); return; }
    const entry = entries.get(input.key), child = entry?.window;
    if (input.action === "close") { if (entry) entry.closing = true; if (child && !child.isDestroyed()) destroy(child); entries.delete(input.key); refreshThrottle(); return; }
    if (!entry || !child || child.isDestroyed()) throw new Error("Floating window is unavailable");
    switch (input.action) {
      case "ready": child.show(); if (entry.input.maximized) child.maximize(); if (entry.input.minimized) child.minimize(); break;
      case "focus": if (child.isMinimized()) child.restore(); child.show(); child.focus(); break;
      case "minimize": child.minimize(); break;
      case "maximize": if (child.isMaximized()) child.unmaximize(); else child.maximize(); break;
      case "topmost": child.setAlwaysOnTop(input.topmost === true); break;
    }
  });
  return {
    windowFor: (key?: string) => key ? entries.get(key)?.window : parent,
    owns, hasWindows: () => [...entries.values()].some(entry => !!entry.window),
    dispose() {
      parent.webContents.removeListener("did-create-window", didCreate);
      parent.webContents.removeListener("destroyed", closeWindows);
      closeWindows();
      ipcMain.removeHandler(CHANNELS.prepare); ipcMain.removeHandler(CHANNELS.control);
    },
  };
}
