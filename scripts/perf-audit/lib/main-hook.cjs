/**
 * Perf-audit main-process hook.
 *
 * Loaded with `NODE_OPTIONS=--require <this file>` so it runs before
 * `apps/desktop/dist/src/main.js`. It only records timestamps; it never
 * changes product behaviour. Renderer / GPU / utility processes are ignored
 * (only the Electron main process, `process.type === "browser"`, writes).
 *
 * Output: JSONL appended to $OMP_PERF_HOOK_LOG (one line per mark).
 */
"use strict";

const logPath = process.env.OMP_PERF_HOOK_LOG;

if (!logPath || (process.type && process.type !== "browser")) {
  // Not the main process (or the probe disabled itself): do nothing at all.
  module.exports = {};
} else {
  const fs = require("node:fs");

  const hookLoadHr = Number(process.hrtime.bigint()) / 1e6;
  /** @type {Array<{name: string, epoch: number, hr: number}>} */
  const pending = [];

  function mark(name, extra) {
    const record = {
      name,
      epoch: Date.now(),
      hr: Number(process.hrtime.bigint()) / 1e6,
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      ...(extra || {}),
    };
    try {
      fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
    } catch {
      // Never let instrumentation break the app under audit.
    }
    pending.push(record);
  }

  mark("hook-load", { hrAtHookLoadMs: Math.round(hookLoadHr) });

  // `require("electron")` is not usable yet while NODE_OPTIONS modules load:
  // Electron installs its internal API right before the app entry runs. Do the
  // registration on the next tick, still long before `ready` fires.
  process.nextTick(() => {
    let electron;
    try {
      electron = require("electron");
      if (!electron || !electron.app) throw new Error("electron module not ready");
    } catch (error) {
      mark("hook-electron-unavailable", { message: String((error && error.message) || error) });
      return;
    }
    const { app } = electron;
    mark("hook-registered", { alreadyReady: app.isReady(), type: process.type });

    app.on("ready", () => mark("app-ready", { alreadyReadyAtHook: app.isReady() }));
    app.on("gpu-info-update", () => mark("gpu-info-update"));
    app.on("browser-window-created", (_event, win) => {
      const id = win.id;
      mark("window-created", { windowId: id, visible: idle(() => win.isVisible()) });
      idle(() => {
        const wc = win.webContents;
        const wcId = wc.id;
        mark("window-webcontents", { windowId: id, webContentsId: wcId });
        wc.on("did-start-loading", () => mark("did-start-loading", { windowId: id }));
        wc.on("dom-ready", () => mark("dom-ready", { windowId: id }));
        wc.on("did-finish-load", () => mark("did-finish-load", { windowId: id }));
        wc.on(
          "did-fail-load",
          (_e, errorCode, errorDescription, validatedURL) =>
            mark("did-fail-load", { windowId: id, errorCode, errorDescription, validatedURL }),
        );
        wc.on("render-process-gone", (_e, details) => mark("render-process-gone", { windowId: id, reason: details && details.reason }));
        win.once("ready-to-show", () => mark("ready-to-show", { windowId: id, visible: idle(() => win.isVisible()) }));
        win.on("show", () => mark("window-show", { windowId: id }));
        win.on("minimize", () => mark("window-minimize", { windowId: id }));
        win.on("restore", () => mark("window-restore", { windowId: id }));
      });
    });
    app.on("web-contents-created", (_event, wc) => mark("web-contents-created", { webContentsId: wc.id, type: wc.getType() }));
    app.on("will-quit", () => mark("will-quit"));
    app.on("quit", () => mark("quit"));
    app.whenReady().then(() => mark("whenReady-resolved", { alreadyReady: app.isReady() }));

    function idle(fn) {
      try {
        return fn();
      } catch {
        return undefined;
      }
    }
  });
}
