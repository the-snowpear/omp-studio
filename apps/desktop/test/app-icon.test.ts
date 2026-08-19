/** Headless tests for development and packaged icon resolution. */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import { resolveAppIconPath } from "../src/app-icon.js";

describe("resolveAppIconPath", () => {
  test("Windows prefers the unpacked ICO next to a packaged asar", () => {
    const appPath = join("tmp", "resources", "app.asar");
    const found = resolveAppIconPath({
      appPath,
      platform: "win32",
      exists: (path) => path.endsWith(join("resources", "icon.ico")),
    });
    assert.equal(found, join("tmp", "resources", "icon.ico"));
  });

  test("development resolves the desktop resources ICO", () => {
    const appPath = join("tmp", "apps", "desktop");
    const found = resolveAppIconPath({
      appPath,
      platform: "win32",
      exists: (path) => path.endsWith(join("desktop", "resources", "icon.ico")),
    });
    assert.equal(found, join(appPath, "resources", "icon.ico"));
  });

  test("development workspace root resolves apps/desktop resources ICO", () => {
    const appPath = join("tmp", "omp-studio");
    const found = resolveAppIconPath({
      appPath,
      platform: "win32",
      exists: (path) => path.endsWith(join("apps", "desktop", "resources", "icon.ico")),
    });
    assert.equal(found, join(appPath, "apps", "desktop", "resources", "icon.ico"));
  });

  test("non-Windows prefers PNG", () => {
    const appPath = join("tmp", "omp-app");
    const found = resolveAppIconPath({
      appPath,
      platform: "darwin",
      exists: (path) => path.endsWith("icon.png") || path.endsWith("icon.ico"),
    });
    assert.equal(found, join(appPath, "..", "icon.png"));
  });

  test("returns undefined when no icon file is present", () => {
    assert.equal(
      resolveAppIconPath({ appPath: "/empty", platform: "win32", exists: () => false }),
      undefined,
    );
  });
});
