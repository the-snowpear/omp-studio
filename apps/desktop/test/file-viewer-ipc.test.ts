import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientTransport, WorkspaceFileInfo, WorkspaceId } from "@omp-studio/client-contract";
import { FileResources } from "../src/file-resources.js";
import { registerFileViewerIpc } from "../src/file-viewer-ipc.js";
import { FILE_VIEWER_CHANNELS as channels } from "../src/file-viewer-shared.js";
import type { OfficeComponent } from "../src/office-component.js";

class Sender extends EventEmitter {
  id = 12; destroyed = false;
  getURL() { return "file:///index.html"; }
  send() {}
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("destroyed"); }
}
const file: WorkspaceFileInfo = { workspaceId: "workspace" as WorkspaceId, id: "file", path: "report.pdf", name: "report.pdf", mime: "application/pdf", size: 10, version: "v1", writable: true };
function setup(read: () => Promise<WorkspaceFileInfo> = async () => file) {
  const handlers = new Map<string, (event: { sender: Sender }, ...args: any[]) => unknown>(), sender = new Sender();
  const resources = new FileResources(() => ({ query: async (request: { queryName: string }) => ({ ok: true, queryName: request.queryName, result: await read() }) }) as Pick<ClientTransport, "query">);
  const controller = registerFileViewerIpc({
    ipc: { handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: channel => { handlers.delete(channel); } },
    trusted: () => true, resources,
    office: { subscribe: () => () => {}, dispose() {} } as unknown as OfficeComponent,
    pickExport: async () => undefined, show() {},
  });
  return { sender, resources, controller, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender }, ...args) };
}

test("closing the renderer releases its files and resolves its pending close confirmation", async () => {
  const source = setup();
  try {
    const lease = await source.invoke(channels.open, { targetId: null, workspaceId: "workspace", path: file.path }) as { id: string; url: string };
    source.invoke(channels.dirty, 1); assert.equal(source.controller.hasDirty(), true);
    const closing = source.controller.requestClose(); source.sender.destroy();
    assert.equal(await closing, false); assert.equal(source.controller.hasDirty(), false);
    assert.equal((await source.resources.response(new Request(lease.url), "null")).status, 404);
  } finally { source.controller.dispose(); }
});

test("closing the renderer during an SSH file inspection cancels the late open", async () => {
  let finish!: (file: WorkspaceFileInfo) => void;
  const source = setup(() => new Promise(resolve => { finish = resolve; }));
  try {
    const opening = source.invoke(channels.open, { targetId: "ssh", workspaceId: "workspace", path: file.path }) as Promise<unknown>;
    source.sender.destroy(); finish(file);
    await assert.rejects(opening, /窗口已关闭/);
  } finally { source.controller.dispose(); }
});

for (const event of ["did-navigate", "render-process-gone"] as const) {
  test(`${event} releases the old files and allows the new document to open files`, async () => {
    const source = setup();
    try {
      const old = await source.invoke(channels.open, { targetId: null, workspaceId: "workspace", path: file.path }) as { id: string; url: string };
      const signal = source.resources.get(old.id).controller.signal;
      source.invoke(channels.dirty, 1);
      const closing = source.controller.requestClose();
      source.sender.emit(event);
      assert.equal(await closing, false);
      assert.equal(source.controller.hasDirty(), false);
      assert.equal(signal.aborted, true);
      assert.equal((await source.resources.response(new Request(old.url, { method: "HEAD" }), "null")).status, 404);
      const fresh = await source.invoke(channels.open, { targetId: null, workspaceId: "workspace", path: file.path }) as { id: string; url: string };
      assert.equal((await source.resources.response(new Request(fresh.url, { method: "HEAD" }), "null")).status, 200);
    } finally { source.controller.dispose(); }
  });

  test(`${event} rejects an old inspection that completes after the new document opens`, async () => {
    let finish!: (file: WorkspaceFileInfo) => void, reads = 0;
    const source = setup(() => ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(file));
    try {
      const opening = source.invoke(channels.open, { targetId: "ssh", workspaceId: "workspace", path: file.path }) as Promise<unknown>;
      const rejected = assert.rejects(opening, /窗口已关闭/);
      source.sender.emit(event);
      const fresh = await source.invoke(channels.open, { targetId: null, workspaceId: "workspace", path: file.path }) as { url: string };
      finish(file);
      await rejected;
      assert.equal((await source.resources.response(new Request(fresh.url, { method: "HEAD" }), "null")).status, 200);
    } finally { source.controller.dispose(); }
  });
}
