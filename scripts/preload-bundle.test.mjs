import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { bundlePreload, PRELOAD_BUNDLE } from "./preload-bundle.mjs";

// Execute the shipped bundle with the sandbox's restricted require. In #8 a
// Host barrel import threw before any of the window bridges were exposed.
for (const platform of ["win32", "darwin"]) test(`${platform} sandboxed preload exposes the desktop bridges and forwards scoped IPC`, async () => {
  bundlePreload();
  const globals = {};
  const listeners = new Map();
  const calls = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { globals[name] = api; } },
    ipcRenderer: {
      invoke: async (...args) => { calls.push(args); return { ready: true }; },
      on: (channel, listener) => { listeners.set(channel, listener); },
      removeListener: (channel, listener) => {
        assert.equal(listeners.get(channel), listener);
        listeners.delete(channel);
      },
    },
    webUtils: { getPathForFile: () => "" },
  };
  runInNewContext(readFileSync(PRELOAD_BUNDLE, "utf8"), {
    require: name => { assert.equal(name, "electron"); return electron; },
    process: { platform, env: {} },
    TextEncoder,
    TextDecoder,
  }, { filename: "preload.cjs", timeout: 1000 });

  for (const name of ["ompStudio", "ompStudioChrome", "ompStudioRemote", "ompStudioTerminal"]) {
    assert.ok(globals[name], `${name} must be exposed before the renderer mounts`);
  }
  assert.equal((await globals.ompStudio.bootstrap()).ready, true);
  assert.equal(calls[0][0], "omp-studio:desktop:bootstrap");
  const events = [];
  const unsubscribe = globals.ompStudio.subscribe({ scope: "command", requestId: "request-8" }, event => events.push(event));
  const eventChannel = [...listeners.keys()][0];
  const event = { kind: "command.accepted", accepted: { requestId: "request-8" } };
  listeners.get(eventChannel)({}, { kind: "command.accepted", accepted: { requestId: "other" } });
  listeners.get(eventChannel)({}, event);
  assert.deepEqual(events, [event]);
  unsubscribe();
  assert.equal(listeners.size, 0);
});
