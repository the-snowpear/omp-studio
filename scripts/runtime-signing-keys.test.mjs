import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDesktopPaths } from "../apps/desktop/dist/src/platform/desktop-paths.js";
import { defaultRuntimeKeysDirectory } from "./runtime-signing-keys.mjs";

test("the signing command writes keys where Desktop looks for them on each platform", () => {
  for (const input of [
    { platform: "win32", home: "C:\\Users\\me", env: { APPDATA: "D:\\Profile" } },
    { platform: "darwin", home: "/Users/me", env: {} },
    { platform: "linux", home: "/home/me", env: {} },
    { platform: "linux", home: "/home/me", env: { XDG_CONFIG_HOME: "/home/me/custom-config" } },
    { platform: "linux", home: "/home/me", env: { XDG_CONFIG_HOME: "" } },
    { platform: "linux", home: "/home/me", env: { XDG_CONFIG_HOME: "local-config" } },
  ]) {
    assert.equal(defaultRuntimeKeysDirectory(input), resolveDesktopPaths({ ...input, homedir: input.home }).keysRoot);
  }
});
