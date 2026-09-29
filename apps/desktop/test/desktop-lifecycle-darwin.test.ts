/**
 * macOS lifecycle (composition.ts): the Dock keeps the app alive without
 * windows, activation shows the hidden window, and a logout or power-off
 * quits within a bound without cancelling the logout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createDesktopApplication } from "../src/composition.js";
import type { DesktopApplicationDeps, DesktopHostComposition, DesktopWindow } from "../src/types.js";

function harness(options: { hostShutdown?: () => Promise<void>; busy?: boolean; confirm?: boolean } = {}) {
  const events: string[] = [];
  const listeners: {
    activate?: () => void;
    allClosed?: () => void;
    beforeQuit?: (event: { preventDefault(): void }) => void;
    shutdown?: (event: { preventDefault(): void }) => void;
  } = {};
  const host = {
    facade: null,
    transport: null,
    status: "ready",
    shutdown: options.hostShutdown ?? (async () => { events.push("host.shutdown"); }),
    isBusy: () => options.busy === true,
  } as unknown as DesktopHostComposition;
  const window: DesktopWindow = {
    show: () => events.push("window.show"),
    focus: () => events.push("window.focus"),
    close: () => events.push("window.close"),
    dispose: () => events.push("window.dispose"),
  };
  const deps: DesktopApplicationDeps = {
    platform: "darwin",
    hostFactory: { create: async () => host },
    createWindow: async () => window,
    requestSingleInstanceLock: () => true,
    onSecondInstance: () => {},
    onBeforeQuit: (listener) => { listeners.beforeQuit = listener; },
    onAllWindowsClosed: (listener) => { listeners.allClosed = listener; },
    onActivate: (listener) => { listeners.activate = listener; },
    onSystemShutdown: (listener) => { listeners.shutdown = listener; },
    systemShutdownTimeoutMs: 50,
    confirmQuitWhileBusy: async () => { events.push("confirm"); return options.confirm === true; },
    quit: () => events.push("app.quit"),
  };
  return { app: createDesktopApplication(deps), events, listeners };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("closing the last window keeps a Mac app running and the Dock brings the window back", async () => {
  const { app, events, listeners } = harness();
  await app.start();
  listeners.allClosed?.();
  assert.deepEqual(events, []);
  listeners.activate?.();
  assert.deepEqual(events, ["window.show"]);
});

test("a logout is never cancelled: before-quit passes and a stuck Host shutdown is cut off", async () => {
  const { app, events, listeners } = harness({ hostShutdown: () => new Promise<void>(() => {}) });
  await app.start();
  let delayed = false;
  listeners.shutdown?.({ preventDefault: () => { delayed = true; } });
  assert.equal(delayed, true, "the OS is asked to wait for the bounded shutdown");
  let prevented = false;
  listeners.beforeQuit?.({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, "deferring before-quit would cancel the logout");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(events, ["window.dispose", "app.quit"]);
});

test("⌘Q while a session streams asks first, like the tray", async () => {
  const declined = harness({ busy: true, confirm: false });
  await declined.app.start();
  declined.app.requestQuit();
  await settle();
  assert.deepEqual(declined.events, ["confirm"]);
  const confirmed = harness({ busy: true, confirm: true });
  await confirmed.app.start();
  confirmed.app.requestQuit();
  await settle();
  await settle();
  assert.deepEqual(confirmed.events, ["confirm", "window.dispose", "host.shutdown", "app.quit"]);
});
