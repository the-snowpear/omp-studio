import assert from "node:assert/strict";
import { test } from "node:test";

import { moveToApplicationsStrings, relaunchArguments, shouldOfferMoveToApplications } from "../src/platform/app-lifecycle.js";
import { startAppNapGuard } from "../src/platform/app-nap.js";

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
