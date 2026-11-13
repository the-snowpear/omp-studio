import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { ManagedBrowserInspection } from "../src/managed-browser-inspection.js";

function page() {
  const contents = new EventEmitter(), debuggerApi = new EventEmitter();
  const commands: { method: string; params?: Record<string, unknown>; sessionId?: string }[] = [];
  let attached = false, session = 0, detached = 0;
  Object.assign(debuggerApi, {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { detached++; attached = false; },
    sendCommand: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      commands.push({ method, ...(params === undefined ? {} : { params }), ...(sessionId === undefined ? {} : { sessionId }) });
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "actual-page-target" } };
      if (method === "Target.attachToTarget") return { sessionId: `inspection-${++session}` };
      return {};
    },
  });
  Object.assign(contents, { debugger: debuggerApi, isDestroyed: () => false });
  return { contents: contents as unknown as WebContents, events: contents, debuggerApi, commands, detached: () => detached };
}

test("embedded Console keeps a bounded actual-page log without loading another page", async () => {
  const source = page(), inspection = new ManagedBrowserInspection(source.contents, () => false);
  try {
    for (let index = 0; index < 270; index++) source.events.emit("console-message", { level: "info", message: `message-${index}`, sourceId: "app.js", lineNumber: index });
    const value = await inspection.read("console", true, "window-a");
    assert.equal(value.view, "console");
    assert.equal(value.rows.length, 200);
    if (value.view === "console") { assert.equal(value.rows[0]?.text, "message-70"); assert.equal(value.rows.at(-1)?.text, "message-269"); }
    assert.equal(source.commands.length, 0);
  } finally { inspection.dispose(); }
});

test("embedded Network detaches its window session, not the Agent debugger or a newer window's session", async () => {
  const source = page(), inspection = new ManagedBrowserInspection(source.contents, () => true);
  try {
    await inspection.read("network", true, "window-a");
    source.debuggerApi.emit("message", {}, "Network.requestWillBeSent", { requestId: "foreign", request: { method: "GET", url: "https://foreign.test/" } }, "agent-session");
    source.debuggerApi.emit("message", {}, "Network.requestWillBeSent", { requestId: "own", type: "Document", request: { method: "GET", url: "https://same-view.test/" } }, "inspection-1");
    source.debuggerApi.emit("message", {}, "Network.responseReceived", { requestId: "own", response: { status: 200 } }, "inspection-1");
    const rows = await inspection.read("network", true, "window-a");
    assert.equal(rows.view, "network");
    if (rows.view === "network") assert.deepEqual(rows.rows, [{ id: "own", method: "GET", url: "https://same-view.test/", resourceType: "Document", status: 200 }]);
    assert.equal(source.commands.filter(command => command.method === "Target.attachToTarget").length, 1);
    await inspection.read("network", true, "window-b");
    const beforeHide = source.commands.length;
    await inspection.read("network", false, "window-a");
    assert.equal(source.commands.length, beforeHide, "an earlier window must not detach the new window's observation");
    await inspection.read("network", false, "window-b");
    assert.deepEqual(source.commands.filter(command => command.method === "Target.detachFromTarget").map(command => command.params?.sessionId), ["inspection-1", "inspection-2"]);
    assert.equal(source.detached(), 0, "the Agent's shared debugger remains attached");
  } finally { inspection.dispose(); }
});
