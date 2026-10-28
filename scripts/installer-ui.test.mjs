import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const rendererRequire = createRequire(new URL("../apps/renderer/package.json", import.meta.url));
const { JSDOM } = rendererRequire("jsdom");
const html = await readFile(new URL("../packaging/ui/index.html", import.meta.url), "utf8");
const script = await readFile(new URL("../packaging/ui/wizard.js", import.meta.url), "utf8");

function wizard(overrides = {}) {
  const dom = new JSDOM(html, { url: "https://omp-installer/index.html?host=installer", runScripts: "outside-only" });
  const window = dom.window;
  const timers = [];
  let poll;
  const calls = { installs: [], finishes: [], closes: 0, minimizes: 0 };
  let status = { done: false, phase: "files", percent: null };
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  window.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  window.clearTimeout = () => {};
  window.setInterval = callback => { poll = callback; return 1; };
  window.clearInterval = () => {};
  window.installerShell = {
    isLive: true,
    getState: () => ({ version: "0.1.14", runtimeVersion: "18.12.6-studio.9", arch: "arm64", defaultPath: "D:\\开发工具\\Studio", occupancy: null, desktopShortcut: true, spaceRequiredMB: 900, ...overrides.state }),
    statDir: () => ({ exists: false, empty: true, totalBytes: 1e12, freeBytes: 1e11, drive: "D:\\" }),
    startInstall: options => { calls.installs.push(options); return overrides.start ? overrides.start(options) : { ok: true, path: options.path }; },
    poll: () => status,
    finish: options => calls.finishes.push(options),
    close: () => calls.closes++,
    minimize: () => calls.minimizes++,
  };
  if (overrides.noBridge) delete window.installerShell;
  window.eval(script);
  const element = id => window.document.getElementById(id);
  return { dom, window, calls, element, click: id => element(id).click(), poll: next => { status = next; poll(); }, flush: delay => timers.filter(timer => timer.delay === delay).forEach(timer => timer.callback()) };
}

test("the live wizard uses the package architecture, existing shortcut choice and actual completion path", () => {
  for (const desktopShortcut of [true, false]) {
    const w = wizard({ state: { desktopShortcut } });
    try {
      assert.match(w.element("welcomeChip").textContent, /arm64/);
      assert.equal(w.element("optDesktop").checked, desktopShortcut);
      w.click("themeBtn");
      assert.equal(w.calls.minimizes, 0);
      w.click("welcomeNext");
      w.click("installBtn");
      assert.equal(w.calls.installs[0].desktopShortcut, desktopShortcut);
      assert.equal(w.element("pct").textContent, "处理中");
      assert.equal(w.element("tbClose").disabled, true);
      w.poll({ done: false, phase: "files", percent: 37 });
      assert.equal(w.element("pct").textContent, "37 %");
      w.poll({ done: true, path: "D:\\开发工具\\实际安装位置" });
      w.flush(700);
      assert.equal(w.element("sumPath").textContent, "D:\\开发工具\\实际安装位置");
      w.element("runCheck").checked = false;
      w.click("tbClose");
      assert.deepEqual(w.calls.finishes.map(value => value.run), [false]);
      assert.equal(w.calls.closes, 0);
    } finally { w.dom.window.close(); }
  }
});

test("accepting repair still requires a running app to exit, and Retry rechecks it", () => {
  let busy = true;
  const w = wizard({ state: { occupancy: "same", existingVersion: "0.1.14", existingPath: "D:\\Tools\\Studio", running: true }, start: options => busy ? { ok: false, reason: "running" } : { ok: true, path: options.path } });
  try {
    w.click("welcomeNext");
    w.click("occupyOk");
    w.click("installBtn");
    assert.equal(w.element("occupyOv").hidden, false);
    assert.match(w.element("occupyMsg").textContent, /托盘/);
    w.click("occupyOk");
    assert.equal(w.element("occupyOv").hidden, false);
    assert.equal(w.calls.installs.length, 2);
    busy = false;
    w.click("occupyOk");
    assert.equal(w.element("occupyOv").hidden, true);
    assert.equal(w.element("tbClose").disabled, true);
    assert.equal(w.calls.installs.length, 3);
  } finally { w.dom.window.close(); }
});

test("an unwritable install location stays editable and an exited copy engine shows failure", () => {
  let writable = false;
  const w = wizard({ start: options => writable ? { ok: true, path: options.path } : { ok: false, message: "无法写入安装位置：访问被拒绝。" } });
  try {
    w.click("welcomeNext");
    w.click("installBtn");
    assert.equal(w.element("dirError").hidden, false);
    assert.match(w.element("dirError").textContent, /访问被拒绝/);
    assert.equal(w.element("tbClose").disabled, false);
    writable = true;
    w.click("installBtn");
    w.poll({ error: "安装程序已退出，安装未完成。" });
    assert.equal(w.element("progressTitle").textContent, "安装未完成");
    assert.equal(w.element("errorClose").hidden, false);
    assert.notEqual(w.element("pct").textContent, "100 %");
    w.click("errorClose");
    assert.equal(w.calls.closes, 1);
    assert.equal(w.calls.finishes.length, 0);
  } finally { w.dom.window.close(); }
});

test("a missing installer bridge shows a connection failure and disables installation", () => {
  const w = wizard({ noBridge: true });
  try {
    assert.equal(w.element("welcomeNext").disabled, true);
    assert.equal(w.element("welcomeTitle").textContent, "无法连接安装程序");
    w.click("welcomeNext");
    assert.equal(w.calls.installs.length, 0);
    w.element("welcomeTitle").dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(w.element("pathInput").closest(".step").getAttribute("aria-hidden"), "true");
  } finally { w.dom.window.close(); }
});
