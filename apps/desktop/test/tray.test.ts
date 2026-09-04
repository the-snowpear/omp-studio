/**
 * Tray contract tests — headless, no Electron: `createAppTray` receives a
 * fake Electron surface (Tray/Menu/nativeImage). Covers locale copy, menu
 * wiring, icon fallback, the one-time first-hide balloon and its persisted
 * marker file (throwaway temp directory).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, test } from "node:test";

import {
  createAppTray,
  firstHideBalloonStrings,
  markTrayHintShown,
  quitBusyDialogStrings,
  quitBusyMessageBoxOptions,
  TRAY_HINT_FILE_NAME,
  trayHintShown,
  trayMenuTemplate,
  trayStrings,
  type MenuLike,
  type MenuItemTemplate,
  type NativeImageLike,
  type TrayElectronSurface,
  type TrayLike,
} from "../src/tray.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeImage implements NativeImageLike {
  constructor(private readonly empty: boolean) {}
  isEmpty(): boolean {
    return this.empty;
  }
}

interface BalloonCall {
  readonly icon: NativeImageLike;
  readonly title: string;
  readonly content: string;
}

class FakeTray implements TrayLike {
  readonly balloonCalls: BalloonCall[] = [];
  readonly clickListeners: Array<() => void> = [];
  menu: { template: readonly MenuItemTemplate[] } | null = null;
  toolTip = "";
  destroyed = false;

  setToolTip(toolTip: string): void {
    this.toolTip = toolTip;
  }

  setContextMenu(menu: MenuLike): void {
    this.menu = menu as { template: readonly MenuItemTemplate[] };
  }

  on(_event: "click", listener: () => void): void {
    this.clickListeners.push(listener);
  }

  displayBalloon(options: { icon?: NativeImageLike; title: string; content: string }): void {
    this.balloonCalls.push({ icon: options.icon as NativeImageLike, title: options.title, content: options.content });
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
  }

  click(): void {
    for (const listener of [...this.clickListeners]) listener();
  }
}

function fakeElectron(options: { imageEmpty?: boolean } = {}): {
  surface: TrayElectronSurface;
  tray: FakeTray;
  image: FakeImage;
} {
  const image = new FakeImage(options.imageEmpty === true);
  const tray = new FakeTray();
  const surface: TrayElectronSurface = {
    createImageFromPath(iconPath: string): NativeImageLike {
      assert.equal(iconPath, "icon.ico");
      return image;
    },
    buildMenu(template: readonly MenuItemTemplate[]): MenuLike {
      return { template };
    },
    createTrayFromImage(passed: NativeImageLike): TrayLike {
      assert.equal(passed, image);
      return tray;
    },
  };
  return { surface, tray, image };
}

async function withTempPersistRoot(run: (persistRoot: string) => Promise<void>): Promise<void> {
  const persistRoot = await mkdtemp(path.join(tmpdir(), "omp-tray-hint-"));
  try {
    await run(persistRoot);
  } finally {
    await rm(persistRoot, { recursive: true, force: true });
  }
}

/** Waits a bounded number of macrotasks for a condition (async fs writes). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe("tray copy", () => {
  test("zh locales use Chinese, everything else English", () => {
    assert.deepEqual(trayStrings("zh-CN"), { tooltip: "OMP Studio", open: "打开页面", quit: "退出" });
    assert.deepEqual(trayStrings("zh_TW"), trayStrings("zh-CN"));
    assert.deepEqual(trayStrings("en-US"), { tooltip: "OMP Studio", open: "Open", quit: "Quit" });
    assert.deepEqual(trayStrings("de-DE"), trayStrings("en-US"));
  });

  test("quit dialog: cancel is the default, quit must be explicit", () => {
    const zh = quitBusyDialogStrings("zh-CN");
    assert.equal(zh.quit, "退出");
    const options = quitBusyMessageBoxOptions(zh);
    assert.equal(options.type, "warning");
    assert.deepEqual(options.buttons, ["取消", "退出"]);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    assert.equal(options.noLink, true);
    assert.equal(options.title, zh.title);
    assert.equal(options.message, zh.message);
    const en = quitBusyDialogStrings("en-US");
    assert.deepEqual([en.cancel, en.quit], ["Cancel", "Quit"]);
  });

  test("first-hide balloon copy exists for both locales", () => {
    assert.match(firstHideBalloonStrings("zh-CN").content, /系统托盘/u);
    assert.match(firstHideBalloonStrings("en-US").content, /tray/u);
  });
});

// ---------------------------------------------------------------------------
// Menu template
// ---------------------------------------------------------------------------

test("menu template wires open and quit through a separator", () => {
  const calls: string[] = [];
  const template = trayMenuTemplate(trayStrings("zh-CN"), {
    open: () => calls.push("open"),
    quit: () => calls.push("quit"),
  });
  assert.equal(template.length, 3);
  const [open, separator, quit] = template;
  assert.ok(open !== undefined && quit !== undefined);
  assert.deepEqual(
    [open, separator, quit].map((item) => (item === undefined ? undefined : "type" in item ? item.type : item.label)),
    ["打开页面", "separator", "退出"],
  );
  assert.ok("click" in open);
  assert.ok("click" in quit);
  open.click();
  quit.click();
  assert.deepEqual(calls, ["open", "quit"]);
});

// ---------------------------------------------------------------------------
// createAppTray
// ---------------------------------------------------------------------------

describe("createAppTray", () => {
  test("returns undefined without an icon path or with an empty image", () => {
    const { surface } = fakeElectron();
    assert.equal(createAppTray({
      electron: surface,
      iconPath: undefined,
      persistRoot: "unused",
      locale: "zh-CN",
      platform: "win32",
      onOpen: () => {},
      onQuit: () => {},
    }), undefined);
    const empty = fakeElectron({ imageEmpty: true });
    assert.equal(createAppTray({
      electron: empty.surface,
      iconPath: "icon.ico",
      persistRoot: "unused",
      locale: "zh-CN",
      platform: "win32",
      onOpen: () => {},
      onQuit: () => {},
    }), undefined);
  });

  test("wires tooltip, context menu and click to open/quit", async () => {
    await withTempPersistRoot(async (persistRoot) => {
      const calls: string[] = [];
      const { surface, tray } = fakeElectron();
      const handle = createAppTray({
        electron: surface,
        iconPath: "icon.ico",
        persistRoot,
        locale: "zh-CN",
        platform: "win32",
        onOpen: () => calls.push("open"),
        onQuit: () => calls.push("quit"),
      });
      assert.ok(handle !== undefined);
      assert.equal(tray.toolTip, "OMP Studio");
      assert.ok(tray.menu !== null);
      const items = tray.menu.template;
      assert.equal(items[0]?.label, "打开页面");
      assert.equal(items[2]?.label, "退出");
      items[0]?.click?.();
      items[2]?.click?.();
      tray.click();
      assert.deepEqual(calls, ["open", "quit", "open"]);
    });
  });

  test("first-hide balloon shows once on windows, persists the marker, never off-windows", async () => {
    await withTempPersistRoot(async (persistRoot) => {
      const { surface, tray, image } = fakeElectron();
      const handle = createAppTray({
        electron: surface,
        iconPath: "icon.ico",
        persistRoot,
        locale: "zh-CN",
        platform: "win32",
        onOpen: () => {},
        onQuit: () => {},
      });
      assert.ok(handle !== undefined);
      assert.ok(handle.notifyHiddenToTray !== undefined);
      handle.notifyHiddenToTray();
      handle.notifyHiddenToTray();
      assert.equal(tray.balloonCalls.length, 1);
      assert.equal(tray.balloonCalls[0]?.icon, image);
      assert.equal(tray.balloonCalls[0]?.title, firstHideBalloonStrings("zh-CN").title);
      // The marker write is async; wait it out, then the latch must hold.
      await until(() => trayHintShown(persistRoot));
      assert.equal(trayHintShown(persistRoot), true);
      handle.notifyHiddenToTray();
      assert.equal(tray.balloonCalls.length, 1);
    });

    await withTempPersistRoot(async (persistRoot) => {
      const { surface, tray } = fakeElectron();
      const handle = createAppTray({
        electron: surface,
        iconPath: "icon.ico",
        persistRoot,
        locale: "zh-CN",
        platform: "darwin",
        onOpen: () => {},
        onQuit: () => {},
      });
      assert.ok(handle !== undefined);
      handle.notifyHiddenToTray?.();
      assert.equal(tray.balloonCalls.length, 0);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(trayHintShown(persistRoot), false);
    });
  });

  test("dispose destroys the tray exactly once", async () => {
    await withTempPersistRoot(async (persistRoot) => {
      const { surface, tray } = fakeElectron();
      const handle = createAppTray({
        electron: surface,
        iconPath: "icon.ico",
        persistRoot,
        locale: "zh-CN",
        platform: "win32",
        onOpen: () => {},
        onQuit: () => {},
      });
      assert.ok(handle !== undefined);
      handle.dispose?.();
      handle.dispose?.();
      assert.equal(tray.destroyed, true);
    });
  });
});

// ---------------------------------------------------------------------------
// Marker persistence
// ---------------------------------------------------------------------------

test("hint marker round-trips under the %APPDATA% root", async () => {
  await withTempPersistRoot(async (persistRoot) => {
    assert.equal(trayHintShown(persistRoot), false);
    await markTrayHintShown(persistRoot);
    assert.equal(trayHintShown(persistRoot), true);
    const stat = await fs.stat(path.join(persistRoot, TRAY_HINT_FILE_NAME));
    assert.equal(stat.isFile(), true);
  });
});
