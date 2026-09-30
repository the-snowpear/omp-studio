import assert from "node:assert/strict";
import { test } from "node:test";

import { packagedResourcePaths, resolveDesktopPaths } from "../src/platform/desktop-paths.js";

test("Windows paths reproduce the historic APPDATA / LOCALAPPDATA layout byte for byte", () => {
  const paths = resolveDesktopPaths({
    platform: "win32",
    env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    homedir: "C:\\Users\\ignored",
  });
  assert.deepEqual(paths, {
    appDataRoot: "C:\\Users\\me\\AppData\\Roaming",
    stateRoot: "C:\\Users\\me\\AppData\\Roaming\\omp-studio",
    logsRoot: "C:\\Users\\me\\AppData\\Roaming\\omp-studio\\logs",
    keysRoot: "C:\\Users\\me\\AppData\\Roaming\\omp-studio\\keys",
    runtimesRoot: "C:\\Users\\me\\AppData\\Local\\omp-studio\\runtimes",
    updatesV2Root: "C:\\Users\\me\\AppData\\Local\\omp-studio\\updates-v2",
    legacyStagingRoot: "C:\\Users\\me\\AppData\\Local\\omp-studio\\updates",
    endpointRegistryRoot: "C:\\Users\\me\\AppData\\Roaming\\omp-studio-endpoints",
  });
});

test("Windows falls back to the home directory when the profile variables are missing", () => {
  const paths = resolveDesktopPaths({ platform: "win32", env: {}, homedir: "C:\\Users\\me" });
  assert.equal(paths.stateRoot, "C:\\Users\\me\\AppData\\Roaming\\omp-studio");
  assert.equal(paths.runtimesRoot, "C:\\Users\\me\\AppData\\Local\\omp-studio\\runtimes");
});

test("macOS keeps every writable location under Application Support", () => {
  const paths = resolveDesktopPaths({ platform: "darwin", env: { APPDATA: "ignored", LOCALAPPDATA: "ignored" }, homedir: "/Users/me" });
  assert.deepEqual(paths, {
    appDataRoot: "/Users/me/Library/Application Support",
    stateRoot: "/Users/me/Library/Application Support/omp-studio",
    logsRoot: "/Users/me/Library/Application Support/omp-studio/logs",
    keysRoot: "/Users/me/Library/Application Support/omp-studio/keys",
    runtimesRoot: "/Users/me/Library/Application Support/omp-studio/runtimes",
    updatesV2Root: "/Users/me/Library/Application Support/omp-studio/updates-v2",
    legacyStagingRoot: "/Users/me/Library/Application Support/omp-studio/updates",
    endpointRegistryRoot: "/Users/me/Library/Application Support/omp-studio-endpoints",
  });
});

test("unsupported platforms fail instead of borrowing the Windows layout", () => {
  assert.throws(() => resolveDesktopPaths({ platform: "linux", env: {}, homedir: "/home/me" }), /Unsupported desktop platform: linux/u);
  assert.throws(() => packagedResourcePaths({ platform: "linux", execPath: "/opt/omp/omp-studio" }), /Unsupported/u);
});

test("bundled seeds sit next to the exe on Windows and in Contents/Resources on macOS", () => {
  assert.deepEqual(packagedResourcePaths({ platform: "win32", execPath: "C:\\Program Files\\OMP Studio\\OMP Studio.exe" }), {
    bundledRuntimeRoot: "C:\\Program Files\\OMP Studio\\runtime\\versions",
    bundledKeysRoot: "C:\\Program Files\\OMP Studio\\runtime-keys",
  });
  assert.deepEqual(
    packagedResourcePaths({
      platform: "darwin",
      execPath: "/Applications/OMP Studio.app/Contents/MacOS/OMP Studio",
      resourcesPath: "/Applications/OMP Studio.app/Contents/Resources",
    }),
    {
      bundledRuntimeRoot: "/Applications/OMP Studio.app/Contents/Resources/runtime/versions",
      bundledKeysRoot: "/Applications/OMP Studio.app/Contents/Resources/runtime-keys",
    },
  );
  assert.throws(() => packagedResourcePaths({ platform: "darwin", execPath: "/Applications/OMP Studio.app/Contents/MacOS/OMP Studio" }), /resources path/u);
});
