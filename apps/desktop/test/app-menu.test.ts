import assert from "node:assert/strict";
import { test } from "node:test";

import type { MenuItemConstructorOptions } from "electron";

import { APP_MENU_COMMANDS, type AppMenuCommand } from "../src/app-menu-shared.js";
import { APP_MENU_ACCELERATORS, buildApplicationMenuTemplate } from "../src/platform/app-menu.js";

function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

function build(isPackaged: boolean, locale = "zh-CN") {
  const sent: AppMenuCommand[] = [];
  const calls: string[] = [];
  const template = buildApplicationMenuTemplate({
    isPackaged,
    locale,
    dispatch: (command) => sent.push(command),
    openRepository: () => calls.push("repository"),
    requestQuit: () => calls.push("quit"),
  });
  return { template, items: flatten(template), sent, calls };
}

test("Edit uses roles so text fields and the terminal get ⌘C, ⌘V and ⌘Z", () => {
  const roles = new Set(build(true).items.map((item) => item.role));
  for (const role of ["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"] as const) assert.ok(roles.has(role), role);
});

test("packaged builds have no Reload or Developer Tools; development builds do", () => {
  const packaged = new Set(build(true).items.map((item) => item.role));
  for (const role of ["reload", "forceReload", "toggleDevTools"] as const) assert.equal(packaged.has(role), false, role);
  const development = new Set(build(false).items.map((item) => item.role));
  for (const role of ["reload", "forceReload", "toggleDevTools"] as const) assert.equal(development.has(role), true, role);
});

test("every custom item sends its allowlisted command with the shortcut the renderer yields on macOS", () => {
  const { items, sent } = build(true);
  const byCommand = new Map<AppMenuCommand, MenuItemConstructorOptions>();
  for (const item of items.filter((candidate) => candidate.role === undefined && candidate.click !== undefined)) {
    const before = sent.length;
    (item.click as () => void)();
    if (sent.length > before) byCommand.set(sent[sent.length - 1]!, item);
  }
  assert.deepEqual([...byCommand.keys()].sort(), [...APP_MENU_COMMANDS].sort());
  for (const command of APP_MENU_COMMANDS) assert.equal(byCommand.get(command)?.accelerator, APP_MENU_ACCELERATORS[command], command);
});

test("⌘Q asks through the busy-session gate and Help links to the repository", () => {
  const { items, calls } = build(true, "en-US");
  const quit = items.find((item) => item.accelerator === "Command+Q");
  assert.equal(quit?.role, undefined, "the quit role would skip the busy confirmation");
  (quit?.click as () => void)();
  (items.find((item) => item.label === "OMP Studio on GitHub")?.click as () => void)();
  assert.deepEqual(calls, ["quit", "repository"]);
});

test("menus are labelled in the UI language and mark the Window and Help menus", () => {
  const zh = build(true, "zh-CN").template;
  assert.deepEqual(zh.map((item) => item.label), ["OMP Studio", "文件", "编辑", "显示", "窗口", "帮助"]);
  assert.equal(zh[4]?.role, "window");
  assert.equal(zh[5]?.role, "help");
  assert.deepEqual(build(true, "en-US").template.map((item) => item.label), ["OMP Studio", "File", "Edit", "View", "Window", "Help"]);
});
