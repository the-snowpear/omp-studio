/**
 * App icon resolution: Windows prefers ICO, others prefer PNG, missing files
 * stay unset. Headless — no Electron.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import { resolveAppIconPath } from "../src/app-icon.js";

describe("resolveAppIconPath", () => {
  test("Windows prefers icon.ico when both files exist", () => {
    const appPath = join("tmp", "omp-app");
    const found = resolveAppIconPath({
      appPath,
      platform: "win32",
      exists: (path) => path.endsWith("icon.ico") || path.endsWith("icon.png"),
    });
    assert.equal(found, join(appPath, "resources", "icon.ico"));
  });

  test("non-Windows prefers icon.png when both files exist", () => {
    const appPath = join("tmp", "omp-app");
    const found = resolveAppIconPath({
      appPath,
      platform: "darwin",
      exists: (path) => path.endsWith("icon.ico") || path.endsWith("icon.png"),
    });
    assert.equal(found, join(appPath, "resources", "icon.png"));
  });

  test("falls back to the remaining format when the preferred file is missing", () => {
    assert.equal(
      resolveAppIconPath({
        appPath: "/app",
        platform: "win32",
        exists: (path) => path.endsWith("icon.png"),
      }),
      join("/app", "resources", "icon.png"),
    );
    assert.equal(
      resolveAppIconPath({
        appPath: "/app",
        platform: "darwin",
        exists: (path) => path.endsWith("icon.ico"),
      }),
      join("/app", "resources", "icon.ico"),
    );
  });

  test("returns undefined when no icon file is present", () => {
    assert.equal(
      resolveAppIconPath({
        appPath: "/empty",
        platform: "win32",
        exists: () => false,
      }),
      undefined,
    );
  });
});
