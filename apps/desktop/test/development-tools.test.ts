import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Input, WebContents } from "electron";
import { installDevelopmentTools } from "../src/development-tools.js";

function fixture(enabled = true) {
  const events = new EventEmitter();
  let opened = false, prevented = 0;
  const opens: unknown[] = [];
  const contents = Object.assign(events, {
    isDevToolsOpened: () => opened,
    openDevTools: (options: unknown) => { opened = true; opens.push(options); },
    closeDevTools: () => { opened = false; },
  });
  installDevelopmentTools(contents as unknown as WebContents, enabled);
  const press = (patch: Partial<Input>) => events.emit("before-input-event", { preventDefault: () => { prevented++; } }, {
    type: "keyDown", key: "F12", control: false, shift: false, alt: false, meta: false, isAutoRepeat: false, ...patch,
  });
  return { press, opens, opened: () => opened, prevented: () => prevented };
}

test("F12 opens detached DevTools without resizing the app, and toggles it closed", () => {
  const view = fixture();
  view.press({});
  assert.equal(view.opened(), true);
  assert.deepEqual(view.opens, [{ mode: "detach", activate: true }]);
  view.press({});
  assert.equal(view.opened(), false);
  assert.equal(view.prevented(), 2);
});

test("Ctrl+Shift+I provides an alternative to hardware function keys", () => {
  const view = fixture();
  view.press({ key: "I", control: true, shift: true });
  assert.equal(view.opened(), true);
  view.press({ key: "i", control: true, shift: true });
  assert.equal(view.opened(), false);
});

test("typing, key-up and held-key repeats are not intercepted", () => {
  const view = fixture();
  view.press({ key: "i" });
  view.press({ key: "I", shift: true });
  view.press({ type: "keyUp" });
  view.press({ isAutoRepeat: true });
  assert.equal(view.opened(), false);
  assert.equal(view.prevented(), 0);
});

test("packaged mode installs no development shortcut", () => {
  const view = fixture(false);
  view.press({});
  view.press({ key: "I", control: true, shift: true });
  assert.equal(view.opened(), false);
  assert.equal(view.prevented(), 0);
});
