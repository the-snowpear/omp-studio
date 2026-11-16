import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { BrowserWindow, IpcMain } from "electron";
import { registerFloatingWindows, visibleWindowBounds } from "../src/floating-windows.js";
import { FLOAT_WINDOW_CHANNELS as CHANNELS, type FloatWindowEvent, type FloatWindowTicket } from "../src/floating-windows-shared.js";

class Contents extends EventEmitter {
  url = "http://localhost:5173/";
  events: FloatWindowEvent[] = [];
  throttled = true;
  handler!: (details: { url: string; frameName: string }) => { action: string; overrideBrowserWindowOptions?: Record<string, unknown> };
  getURL() { return this.url; }
  getZoomFactor() { return 1.25; }
  isDestroyed() { return false; }
  send(_channel: string, event: FloatWindowEvent) { this.events.push(event); }
  setBackgroundThrottling(value: boolean) { this.throttled = value; }
  setWindowOpenHandler(handler: typeof this.handler) { this.handler = handler; }
}
class Window extends EventEmitter {
  webContents = new Contents();
  shown = false; minimized = false; maximized = false; destroyed = false; topmost = false; focused = false;
  getBounds() { return { x: 20, y: 20, width: 1200, height: 800 }; }
  getContentBounds() { return this.getBounds(); }
  getNormalBounds() { return { x: 100, y: 100, width: 600, height: 400 }; }
  isVisible() { return this.shown; }
  isMinimized() { return this.minimized; }
  isMaximized() { return this.maximized; }
  isDestroyed() { return this.destroyed; }
  show() { this.shown = true; this.emit("show"); }
  hide() { this.shown = false; this.emit("hide"); }
  focus() { this.focused = true; }
  restore() { this.minimized = false; this.emit("restore"); }
  minimize() { this.minimized = true; this.emit("minimize"); }
  maximize() { this.maximized = true; this.emit("maximize"); }
  unmaximize() { this.maximized = false; this.emit("unmaximize"); }
  setAlwaysOnTop(value: boolean) { this.topmost = value; }
  destroy() { this.destroyed = true; this.emit("closed"); }
}
function setup(restoreMainOnLastClose = false) {
  const parent = new Window();
  const handlers = new Map<string, (event: { sender: Contents }, input: unknown) => unknown>();
  const ipc = { handle: (key: string, handler: (event: { sender: Contents }, input: unknown) => unknown) => handlers.set(key, handler), removeHandler: (key: string) => handlers.delete(key) };
  let quitting = false;
  const manager = registerFloatingWindows({ parent: parent as unknown as BrowserWindow, ipcMain: ipc as unknown as IpcMain, allowedOrigin: "http://localhost:5173", preloadPath: "preload.js", areas: () => [{ x: 0, y: 0, width: 1920, height: 1040 }], isQuitting: () => quitting, openExternal: () => {}, restoreMainOnLastClose });
  const call = (channel: string, input: unknown) => handlers.get(channel)!({ sender: parent.webContents }, input);
  const ticket = call(CHANNELS.prepare, { id: "real:group", title: "Terminal", topmost: false, minimized: false, maximized: false, sourceRect: { x: 80, y: 60, width: 640, height: 480 } }) as FloatWindowTicket;
  const creation = parent.webContents.handler({ url: ticket.url, frameName: ticket.key });
  const child = new Window(); child.webContents.url = ticket.url;
  parent.webContents.emit("did-create-window", child, { frameName: ticket.key });
  const control = (action: string, extra = {}) => call(CHANNELS.control, { key: ticket.key, action, ...extra });
  return { parent, child, manager, control, creation, quit: () => { quitting = true; } };
}
test("independent windows remain interactive while the main window is hidden; topmost toggles the same window", () => {
  const { parent, child, manager, control, creation } = setup();
  assert.equal(creation.action, "allow"); assert.equal(creation.overrideBrowserWindowOptions?.parent, undefined);
  assert.equal(creation.overrideBrowserWindowOptions?.width, 800); assert.equal(creation.overrideBrowserWindowOptions?.x, 120);
  control("ready"); parent.hide();
  assert.equal(child.isVisible(), true); assert.equal(parent.webContents.throttled, false);
  control("topmost", { topmost: true }); assert.equal(child.topmost, true);
  control("topmost", { topmost: false }); assert.equal(child.topmost, false); assert.equal(child.destroyed, false);
  control("minimize"); assert.equal(child.minimized, true); assert.equal(parent.webContents.throttled, true);
  control("focus"); assert.equal(child.minimized, false); assert.equal(child.focused, true);
  control("showMain"); assert.equal(parent.shown, true);
  manager.dispose();
});
test("native close first requests panel handback; only acknowledgement destroys the window", () => {
  const { parent, child, manager, control } = setup();
  control("ready");
  let prevented = false;
  child.emit("close", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(child.destroyed, false);
  assert.equal(parent.webContents.events.at(-1)?.kind, "close-request");
  control("close"); assert.equal(child.destroyed, true); assert.equal(manager.hasWindows(), false);
  manager.dispose();
});
test("explicit application quit does not send a user close request that would erase saved pins", () => {
  const { parent, child, manager, quit } = setup(true);
  quit(); let prevented = false;
  child.emit("close", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false); assert.equal(parent.webContents.events.some(event => event.kind === "close-request"), false);
  manager.dispose();
  assert.equal(parent.shown, false);
});
test("closing the last Linux floating window restores the hidden workbench", () => {
  const { parent, manager, control } = setup(true);
  control("ready"); parent.hide();
  control("close");
  assert.equal(manager.hasWindows(), false);
  assert.equal(parent.shown, true);
  assert.equal(parent.focused, true);
  manager.dispose();
});
test("saved native geometry survives negative-coordinate monitors and returns on screen after removal", () => {
  const areas = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1600, y: 0, width: 1600, height: 860 }];
  const rect = { x: -1500, y: 80, width: 900, height: 600 };
  assert.deepEqual(visibleWindowBounds(rect, areas), rect);
  assert.deepEqual(visibleWindowBounds(rect, areas.slice(0, 1)), { ...rect, x: 0 });
});
