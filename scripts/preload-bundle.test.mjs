import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { DESKTOP_IPC_LIMITS } from "@omp-studio/transport-desktop";
import { bundlePreload, PRELOAD_BUNDLE } from "./preload-bundle.mjs";

/**
 * Execute the shipped bundle with the sandbox's restricted require. In #8 a
 * Host barrel import threw before any of the window bridges were exposed.
 *
 * The bundle runs in its own realm, and Main→preload payloads are realm-native
 * there (Electron deserializes them inside the preload). Every simulated event
 * therefore has to be built *in that realm*: the IPC guards use
 * `Object.getPrototypeOf(value) === Object.prototype`, which a host-realm
 * literal fails. Building them with `JSON.parse` inside the context reproduces
 * what Electron hands the preload.
 */
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
  const context = createContext({
    require: name => { assert.equal(name, "electron"); return electron; },
    process: { platform, env: {} },
    TextEncoder,
    TextDecoder,
    __payload: "",
  });
  runInContext(readFileSync(PRELOAD_BUNDLE, "utf8"), context, { filename: "preload.cjs", timeout: 1000 });
  /** Build a Main→preload payload inside the preload's own realm. */
  const inbound = value => {
    context.__payload = JSON.stringify(value);
    return runInContext("JSON.parse(__payload)", context);
  };

  for (const name of ["ompStudio", "ompStudioChrome", "ompStudioRemote", "ompStudioTerminal"]) {
    assert.ok(globals[name], `${name} must be exposed before the renderer mounts`);
  }
  assert.equal((await globals.ompStudio.bootstrap()).ready, true);
  assert.equal(calls[0][0], "omp-studio:desktop:bootstrap");

  const events = [];
  const unsubscribe = globals.ompStudio.subscribe({ scope: "command", requestId: "request-8" }, event => events.push(event));
  // The bridge picks the subscription id itself and sends it with the
  // registration; Main addresses one event to `{ subscriptionIds }`, so the
  // bundle must deliver it once here and drop envelopes that do not name one of
  // its own ids.
  const registration = calls.find(call => call[0] === "omp-studio:desktop:subscribe");
  assert.ok(registration, "subscribe must reach Main");
  const subscriptionId = registration[1].subscriptionId;
  assert.equal(typeof subscriptionId, "string");

  const eventChannel = "omp-studio:desktop:event";
  assert.ok(listeners.get(eventChannel), `the Host event channel must be listening; saw ${[...listeners.keys()].join(", ")}`);
  const event = { kind: "command.accepted", accepted: { requestId: "request-8" } };
  listeners.get(eventChannel)({}, inbound({ subscriptionIds: ["someone-else"], event }));
  listeners.get(eventChannel)({}, inbound({ subscriptionIds: [subscriptionId], event: { kind: "command.accepted", accepted: { requestId: "other" } } }));
  listeners.get(eventChannel)({}, inbound({ subscriptionIds: [subscriptionId], event }));
  // The delivered event belongs to the preload realm; compare structurally.
  assert.equal(events.length, 1, "one envelope for one subscription");
  assert.deepEqual(JSON.parse(JSON.stringify(events[0])), event);

  // P1-1: Main slices a scope's ids at the same shared limit, so a full-size
  // envelope must be delivered by the SHIPPED bundle — a smaller guard here
  // would silently drop legal events for every listener past the first chunk.
  const filler = Array.from(
    { length: DESKTOP_IPC_LIMITS.maxSubscriptionIdsPerEvent - 1 },
    (_, index) => `filler-${index}`,
  );
  listeners.get(eventChannel)({}, inbound({ subscriptionIds: [...filler, subscriptionId], event }));
  assert.equal(events.length, 2, "a full-size envelope is delivered, not discarded as malformed");

  unsubscribe();
  assert.equal(listeners.size, 0);
  const cancellation = calls.find(call => call[0] === "omp-studio:desktop:unsubscribe");
  assert.deepEqual(JSON.parse(JSON.stringify(cancellation?.[1])), { subscriptionId }, "cancellation names exactly this subscription");
});
