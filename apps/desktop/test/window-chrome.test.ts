import assert from "node:assert/strict";
import { test } from "node:test";

import { TITLEBAR_OVERLAY, TITLEBAR_OVERLAY_HEIGHT } from "../src/titlebar-overlay-shared.js";
import { TRAFFIC_LIGHT_POSITION, canRecolorTitleBarOverlay, windowChromeOptions } from "../src/platform/window-chrome.js";

test("Windows keeps its colored caption-button overlay exactly as before", () => {
  assert.deepEqual(windowChromeOptions("win32"), {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#fbfbfc", symbolColor: "#1d2129", height: 36 },
  });
  assert.deepEqual(windowChromeOptions("win32", "dark").titleBarOverlay, { ...TITLEBAR_OVERLAY.dark, height: TITLEBAR_OVERLAY_HEIGHT });
  assert.equal(canRecolorTitleBarOverlay("win32"), true);
});

test("macOS keeps the traffic lights, centred in the same bar height, with no colors to set", () => {
  const options = windowChromeOptions("darwin", "dark");
  assert.deepEqual(options, {
    titleBarStyle: "hidden",
    titleBarOverlay: { height: 36 },
    trafficLightPosition: { x: 14, y: 12 },
  });
  assert.equal(TRAFFIC_LIGHT_POSITION.y * 2 + 12, TITLEBAR_OVERLAY_HEIGHT);
  assert.equal(canRecolorTitleBarOverlay("darwin"), false);
});
