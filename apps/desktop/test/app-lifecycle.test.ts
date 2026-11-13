import assert from "node:assert/strict";
import { test } from "node:test";

import { handleMainWindowClose, moveToApplicationsStrings, relaunchArguments, shouldOfferMoveToApplications } from "../src/platform/app-lifecycle.js";
import { createDesktopApplication } from "../src/composition.js";
import type { DesktopHostComposition } from "../src/types.js";
import { startAppNapGuard } from "../src/platform/app-nap.js";

test("closing without a tray asks to save before destroying the window and stopping Host", async () => {
  const events: string[] = [];
  let allow = false;
  const app = createDesktopApplication({
    hostFactory: { create: async () => ({ status: "ready", isBusy: () => false, shutdown: async () => { events.push("shutdown"); } }) as DesktopHostComposition },
    createWindow: async () => ({ show() {}, focus() {}, close() {}, dispose() { events.push("dispose"); } }),
    requestSingleInstanceLock: () => true, onSecondInstance() {}, onBeforeQuit() {}, onAllWindowsClosed() {},
    confirmBeforeQuit: async () => { events.push("save-confirmation"); return allow; },
    quit: () => { events.push("quit"); },
  });
  await app.start();
  const close = () => handleMainWindowClose({ preventDefault() { events.push("prevent-close"); } }, {
    platform: "win32", quitting: false, closeToTray: false, hasFloatingWindows: false,
    hide() { events.push("hide"); }, requestQuit: () => app.requestQuit(),
  });
  close(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["prevent-close", "save-confirmation"]);
  events.length = 0; allow = true;
  close(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["prevent-close", "save-confirmation", "dispose", "shutdown", "quit"]);
});

test("a native close veto leaves the window usable and a later operator quit can proceed", async () => {
  const events: string[] = [];
  let allow = false;
  let activate: (() => void) | undefined;
  const app = createDesktopApplication({
    hostFactory: { create: async () => ({ status: "ready", isBusy: () => false,
      confirmClose: async () => { events.push("native-confirmation"); return allow; },
      shutdown: async () => { events.push("shutdown"); } }) as DesktopHostComposition },
    createWindow: async () => ({ show() { events.push("show"); }, focus() {}, close() {}, dispose() { events.push("dispose"); } }),
    requestSingleInstanceLock: () => true, onSecondInstance() {}, onBeforeQuit() {}, onAllWindowsClosed() {},
    onActivate: (listener) => { activate = listener; },
    confirmBeforeQuit: async () => { events.push("save-confirmation"); return true; },
    beforeShutdown: async () => { events.push("flush"); },
    quit: () => { events.push("quit"); },
  });
  await app.start();
  await app.quit();
  activate?.();
  assert.deepEqual(events, ["save-confirmation", "native-confirmation", "show"]);
  events.length = 0;
  allow = true;
  await app.quit();
  assert.deepEqual(events, ["save-confirmation", "native-confirmation", "dispose", "flush", "shutdown", "quit"]);
});

test("system shutdown does not wait for a native close dialog or honor its late veto", async () => {
  const events: string[] = [];
  let resolveConfirmation!: (allowed: boolean) => void;
  const confirmation = new Promise<boolean>(resolve => { resolveConfirmation = resolve; });
  let systemShutdown: ((event: { preventDefault(): void }) => void) | undefined;
  const app = createDesktopApplication({
    hostFactory: { create: async () => ({ status: "ready", isBusy: () => false,
      confirmClose: async () => { events.push("native-confirmation"); return confirmation; },
      shutdown: async () => { events.push("shutdown"); } }) as DesktopHostComposition },
    createWindow: async () => ({ show() {}, focus() {}, close() {}, dispose() { events.push("dispose"); } }),
    requestSingleInstanceLock: () => true, onSecondInstance() {}, onBeforeQuit() {}, onAllWindowsClosed() {},
    onSystemShutdown: (listener) => { systemShutdown = listener; },
    quit: () => { events.push("quit"); },
  });
  await app.start();
  const closing = app.quit();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["native-confirmation"]);
  systemShutdown?.({ preventDefault() {} });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["native-confirmation", "dispose", "shutdown", "quit"]);
  resolveConfirmation(false);
  await closing;
  assert.deepEqual(events, ["native-confirmation", "dispose", "shutdown", "quit"]);
});

test("macOS Dock, Windows tray and floating windows keep the main window recoverable", () => {
  for (const input of [
    { platform: "darwin" as const, closeToTray: false, hasFloatingWindows: false },
    { platform: "win32" as const, closeToTray: true, hasFloatingWindows: false },
    { platform: "win32" as const, closeToTray: false, hasFloatingWindows: true },
  ]) {
    const events: string[] = [];
    const options = { ...input, quitting: false, hide() { events.push("hide"); }, requestQuit() { events.push("quit"); } };
    handleMainWindowClose({ preventDefault() { events.push("prevent-close"); } }, options);
    assert.deepEqual(events, ["prevent-close", "hide"]);
    events.length = 0;
    handleMainWindowClose({ preventDefault() { events.push("prevent-close"); } }, { ...options, quitting: true });
    assert.deepEqual(events, [], "a confirmed quit must let the native window close");
  }
});

test("a relaunch keeps user arguments, drops macOS process serial numbers and marks one restart", () => {
  assert.deepEqual(relaunchArguments(["OMP Studio", "--omp-baseline"]), ["--omp-baseline", "--omp-restarted"]);
  assert.deepEqual(relaunchArguments(["OMP Studio", "-psn_0_12345", "--omp-restarted"]), ["--omp-restarted"]);
  assert.deepEqual(relaunchArguments(["C:\\OMP Studio.exe"]), ["--omp-restarted"]);
});

test("the move to Applications is offered once, only for a packaged Mac app outside the folder", () => {
  const base = { platform: "darwin" as const, isPackaged: true, inApplicationsFolder: false, declined: false };
  assert.equal(shouldOfferMoveToApplications(base), true);
  assert.equal(shouldOfferMoveToApplications({ ...base, declined: true }), false);
  assert.equal(shouldOfferMoveToApplications({ ...base, inApplicationsFolder: true }), false);
  assert.equal(shouldOfferMoveToApplications({ ...base, isPackaged: false }), false);
  assert.equal(shouldOfferMoveToApplications({ ...base, platform: "win32" }), false);
  assert.match(moveToApplicationsStrings("zh-CN").message, /应用程序/u);
  assert.match(moveToApplicationsStrings("en-US").move, /Applications/u);
});

test("App Nap is held only while a session is busy and released on dispose", () => {
  let busy = false;
  let tick: (() => void) | undefined;
  const events: string[] = [];
  let next = 1;
  const dispose = startAppNapGuard({
    isBusy: () => busy,
    blocker: {
      start: (type) => { events.push(`start:${type}`); return next++; },
      stop: (id) => { events.push(`stop:${id}`); },
    },
    setInterval: (callback) => { tick = callback; return "handle"; },
    clearInterval: (handle) => { events.push(`clear:${String(handle)}`); },
  });
  assert.deepEqual(events, []);
  busy = true;
  tick?.();
  tick?.();
  busy = false;
  tick?.();
  busy = true;
  tick?.();
  dispose();
  assert.deepEqual(events, ["start:prevent-app-suspension", "stop:1", "start:prevent-app-suspension", "clear:handle", "stop:2"]);
});
