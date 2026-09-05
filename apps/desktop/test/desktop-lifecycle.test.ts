/**
 * Desktop application lifecycle tests (composition.ts) — headless fakes,
 * no Electron: every OS seam is injected. Covers the close-to-tray
 * lifecycle additions: `isQuitting` handed to the window factory, the tray
 * seam, the busy-quit confirmation gate and the graceful shutdown ordering
 * (tray → window IPC → Host → quit).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createDesktopApplication } from "../src/composition.js";
import type {
  DesktopApplication,
  DesktopApplicationDeps,
  DesktopHostComposition,
  DesktopTray,
  DesktopWindow,
  DesktopWindowContext,
} from "../src/types.js";

interface TrayActions {
  openWindow(): void;
  requestQuit(): void;
}

interface Harness {
  readonly app: DesktopApplication;
  readonly events: string[];
  /** Lets pending quit/confirmation promises settle. */
  flush(): Promise<void>;
  windowContext(): DesktopWindowContext | null;
  trayActions(): TrayActions | null;
  setBusy(busy: boolean): void;
  setConfirmAnswer(answer: boolean): void;
  confirmCalls(): number;
  quitCalls(): number;
  secondInstance(): void;
  /** Emits before-quit; returns whether the handler prevented it. */
  emitBeforeQuit(): boolean;
  emitAllWindowsClosed(): void;
}

async function setup(options: { withTray?: boolean; withConfirm?: boolean; trayThrows?: boolean } = {}): Promise<Harness> {
  const events: string[] = [];
  let busy = false;
  let confirmAnswer = false;
  let confirmCalls = 0;
  let quitCalls = 0;
  let windowContext: DesktopWindowContext | null = null;
  let trayActions: TrayActions | null = null;
  let secondInstanceListener: (() => void) | undefined;
  let beforeQuitListener: ((event: { preventDefault(): void }) => void) | undefined;
  let allWindowsClosedListener: (() => void) | undefined;

  const host = {
    facade: null,
    transport: null,
    status: "ready",
    reload: async () => host,
    rebindWorkspace: async () => undefined,
    shutdown: async () => {
      events.push("host.shutdown");
    },
    isBusy: () => busy,
  } as unknown as DesktopHostComposition;

  const window: DesktopWindow = {
    show: () => events.push("window.show"),
    focus: () => events.push("window.focus"),
    close: () => events.push("window.close"),
    dispose: () => events.push("window.dispose"),
  };

  const tray: DesktopTray = {
    notifyHiddenToTray: () => events.push("tray.notifyHidden"),
    dispose: () => events.push("tray.dispose"),
  };

  const deps: DesktopApplicationDeps = {
    hostFactory: { create: async () => host },
    createWindow: async (context) => {
      windowContext = context;
      return window;
    },
    requestSingleInstanceLock: () => true,
    onSecondInstance: (listener) => {
      secondInstanceListener = listener;
    },
    onBeforeQuit: (listener) => {
      beforeQuitListener = listener;
    },
    onAllWindowsClosed: (listener) => {
      allWindowsClosedListener = listener;
    },
    quit: () => {
      quitCalls += 1;
      events.push("app.quit");
    },
    ...(options.withTray === false
      ? {}
      : {
        createTray: (actions: TrayActions) => {
          if (options.trayThrows === true) throw new Error("tray unavailable");
          trayActions = actions;
          return tray;
        },
      }),
    ...(options.withConfirm === false
      ? {}
      : {
        confirmQuitWhileBusy: () => {
          confirmCalls += 1;
          return Promise.resolve(confirmAnswer);
        },
      }),
  };

  const app = createDesktopApplication(deps);
  await app.start();

  return {
    app,
    events,
    flush: () => new Promise<void>((resolve) => setImmediate(resolve)),
    windowContext: () => windowContext,
    trayActions: () => trayActions,
    setBusy(next: boolean) {
      busy = next;
    },
    setConfirmAnswer(next: boolean) {
      confirmAnswer = next;
    },
    confirmCalls: () => confirmCalls,
    quitCalls: () => quitCalls,
    secondInstance: () => secondInstanceListener?.(),
    emitBeforeQuit: () => {
      let prevented = false;
      beforeQuitListener?.({
        preventDefault: () => {
          prevented = true;
        },
      });
      return prevented;
    },
    emitAllWindowsClosed: () => allWindowsClosedListener?.(),
  };
}

describe("desktop lifecycle", () => {
  test("start hands isQuitting to the window factory and creates the tray", async () => {
    const h = await setup();
    assert.ok(h.windowContext() !== null);
    assert.equal(h.windowContext()?.isQuitting(), false);
    assert.ok(h.trayActions() !== null);
    assert.deepEqual(h.events, []);
  });

  test("second instance and tray open show the window", async () => {
    const h = await setup();
    h.secondInstance();
    h.trayActions()?.openWindow();
    assert.deepEqual(h.events, ["window.show", "window.show"]);
  });

  test("tray quit while idle skips confirmation and quits gracefully in order", async () => {
    const h = await setup();
    h.trayActions()?.requestQuit();
    await h.flush();
    assert.equal(h.confirmCalls(), 0);
    assert.deepEqual(h.events, ["tray.dispose", "window.dispose", "host.shutdown", "app.quit"]);
    assert.equal(h.quitCalls(), 1);
  });

  test("tray quit while busy aborts when the confirmation is declined", async () => {
    const h = await setup();
    h.setBusy(true);
    h.setConfirmAnswer(false);
    h.trayActions()?.requestQuit();
    await h.flush();
    assert.equal(h.confirmCalls(), 1);
    assert.equal(h.quitCalls(), 0);
    assert.equal(h.events.includes("host.shutdown"), false);
    // The app stays alive: the window can still be reopened from the tray.
    h.trayActions()?.openWindow();
    assert.deepEqual(h.events, ["window.show"]);
  });

  test("tray quit while busy proceeds once confirmed", async () => {
    const h = await setup();
    h.setBusy(true);
    h.setConfirmAnswer(true);
    h.trayActions()?.requestQuit();
    await h.flush();
    assert.equal(h.confirmCalls(), 1);
    assert.deepEqual(h.events, ["tray.dispose", "window.dispose", "host.shutdown", "app.quit"]);
    assert.equal(h.quitCalls(), 1);
  });

  test("rapid double quit while busy asks for confirmation only once", async () => {
    const h = await setup();
    h.setBusy(true);
    h.setConfirmAnswer(true);
    h.trayActions()?.requestQuit();
    h.trayActions()?.requestQuit();
    await h.flush();
    assert.equal(h.confirmCalls(), 1);
    assert.equal(h.quitCalls(), 1);
  });

  test("busy quit without a confirmation seam proceeds", async () => {
    const h = await setup({ withConfirm: false });
    h.setBusy(true);
    h.trayActions()?.requestQuit();
    await h.flush();
    assert.equal(h.quitCalls(), 1);
  });

  test("before-quit defers, flips isQuitting, then runs the graceful sequence", async () => {
    const h = await setup();
    assert.equal(h.emitBeforeQuit(), true);
    // The real quit path must let intercepted close events through.
    assert.equal(h.windowContext()?.isQuitting(), true);
    await h.flush();
    assert.deepEqual(h.events, ["tray.dispose", "window.dispose", "host.shutdown", "app.quit"]);
    assert.equal(h.quitCalls(), 1);
  });

  test("window-all-closed still quits directly", async () => {
    const h = await setup();
    h.emitAllWindowsClosed();
    assert.equal(h.quitCalls(), 1);
    assert.deepEqual(h.events, ["app.quit"]);
  });

  test("a failing tray seam leaves the app usable", async () => {
    const h = await setup({ trayThrows: true });
    assert.equal(h.trayActions(), null);
    assert.equal(h.windowContext()?.isQuitting(), false);
    await h.app.quit();
    assert.equal(h.quitCalls(), 1);
  });

  test("without --omp-restarted, lock failure quits immediately without retrying", async () => {
    let lockAttempts = 0;
    let quitCalls = 0;
    const deps: DesktopApplicationDeps = {
      hostFactory: { create: async () => ({} as any) },
      createWindow: async () => ({} as any),
      requestSingleInstanceLock: () => {
        lockAttempts += 1;
        return false;
      },
      onSecondInstance: () => {},
      onBeforeQuit: () => {},
      onAllWindowsClosed: () => {},
      quit: () => { quitCalls += 1; },
      argv: ["node", "main.js"],
    };
    const app = createDesktopApplication(deps);
    await app.start();
    assert.equal(lockAttempts, 1);
    assert.equal(quitCalls, 1);
  });

  test("with --omp-restarted, lock failure retries and succeeds when lock is freed", async () => {
    let lockAttempts = 0;
    let quitCalls = 0;
    let windowCreated = false;
    const deps: DesktopApplicationDeps = {
      hostFactory: { create: async () => ({ status: "ready" } as any) },
      createWindow: async () => {
        windowCreated = true;
        return { show: () => {}, focus: () => {}, close: () => {} } as any;
      },
      requestSingleInstanceLock: () => {
        lockAttempts += 1;
        // Succeed on 3rd attempt
        return lockAttempts >= 3;
      },
      onSecondInstance: () => {},
      onBeforeQuit: () => {},
      onAllWindowsClosed: () => {},
      quit: () => { quitCalls += 1; },
      singleInstanceRetry: { attempts: 5, delayMs: 1 },
      argv: ["node", "main.js", "--omp-restarted"],
    };
    const app = createDesktopApplication(deps);
    await app.start();
    assert.equal(lockAttempts, 3);
    assert.equal(quitCalls, 0);
    assert.equal(windowCreated, true);
  });

  test("with --omp-restarted, lock failure exhausts all retries and quits", async () => {
    let lockAttempts = 0;
    let quitCalls = 0;
    let windowCreated = false;
    const deps: DesktopApplicationDeps = {
      hostFactory: { create: async () => ({} as any) },
      createWindow: async () => {
        windowCreated = true;
        return {} as any;
      },
      requestSingleInstanceLock: () => {
        lockAttempts += 1;
        return false;
      },
      onSecondInstance: () => {},
      onBeforeQuit: () => {},
      onAllWindowsClosed: () => {},
      quit: () => { quitCalls += 1; },
      singleInstanceRetry: { attempts: 4, delayMs: 1 },
      argv: ["node", "main.js", "--omp-restarted"],
    };
    const app = createDesktopApplication(deps);
    await app.start();
    // 1 initial + 4 retries = 5 attempts
    assert.equal(lockAttempts, 5);
    assert.equal(quitCalls, 1);
    assert.equal(windowCreated, false);
  });
});
