import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserPageActivity } from "../src/managed-browser-activity.js";

test("an idle page throttles after 30 seconds and wakes before another operation", context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const changes: boolean[] = [];
  const page = new BrowserPageActivity(value => changes.push(value));
  context.after(() => page.dispose());
  context.mock.timers.tick(29_999);
  assert.deepEqual(changes, [false]);
  context.mock.timers.tick(1);
  assert.deepEqual(changes, [false, true]);
  const release = page.hold();
  assert.equal(changes.at(-1), false);
  context.mock.timers.tick(60_000);
  assert.equal(changes.at(-1), false);
  release();
  context.mock.timers.tick(30_000);
  assert.equal(changes.at(-1), true);
});

test("visibility, loading, media, audio, DevTools and picking each protect a background page", context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let throttled = false;
  const page = new BrowserPageActivity(value => { throttled = value; });
  context.after(() => page.dispose());
  for (const reason of ["visible", "loading", "media", "audible", "devtools", "picking"] as const) {
    page.update({ [reason]: true });
    context.mock.timers.tick(60_000);
    assert.equal(throttled, false, reason);
    page.update({ [reason]: false });
    context.mock.timers.tick(29_999);
    assert.equal(throttled, false, `${reason} grace`);
    // Repeated observations of the same state must not keep the page awake.
    page.update({ [reason]: false });
    context.mock.timers.tick(1);
    assert.equal(throttled, true, `${reason} finished`);
  }
});

test("overlapping operations finish independently; disposal cancels pending wakeups", context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const changes: boolean[] = [];
  const page = new BrowserPageActivity(value => changes.push(value));
  const first = page.hold(), second = page.hold();
  first();
  context.mock.timers.tick(90_000);
  assert.deepEqual(changes, [false]);
  second();
  context.mock.timers.tick(30_000);
  assert.deepEqual(changes, [false, true]);
  const pending = page.hold();
  page.dispose();
  pending();
  context.mock.timers.tick(90_000);
  assert.deepEqual(changes, [false, true, false]);
});
