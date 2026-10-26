import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isHexColor,
  parseTitlebarThemePayload,
} from "../src/titlebar-overlay-shared.js";

test("parses a theme payload without a tint", () => {
  assert.deepEqual(parseTitlebarThemePayload({ theme: "dark" }), { theme: "dark" });
});

test("parses a valid background tint", () => {
  assert.deepEqual(
    parseTitlebarThemePayload({
      theme: "light",
      tint: { color: "#223344", symbolColor: "#ffffff" },
    }),
    { theme: "light", tint: { color: "#223344", symbolColor: "#ffffff" } },
  );
});

test("drops an invalid tint but keeps the theme", () => {
  for (const tint of [
    { color: "red", symbolColor: "#ffffff" },
    { color: "#12345", symbolColor: "#ffffff" },
    { color: "#123456" },
    { color: 123, symbolColor: "#ffffff" },
    "nope",
    null,
  ]) {
    assert.deepEqual(parseTitlebarThemePayload({ theme: "dark", tint }), { theme: "dark" });
  }
});

test("rejects a missing or unknown theme", () => {
  for (const payload of [undefined, null, {}, { theme: "sepia" }, { theme: 1 }, "light", []]) {
    assert.equal(parseTitlebarThemePayload(payload), undefined);
  }
});

test("validates six-digit hex colours only", () => {
  assert.equal(isHexColor("#a1b2c3"), true);
  assert.equal(isHexColor("#A1B2C3"), true);
  assert.equal(isHexColor("#fff"), false);
  assert.equal(isHexColor("#a1b2c3d4"), false);
  assert.equal(isHexColor("a1b2c3"), false);
  assert.equal(isHexColor(123), false);
});
