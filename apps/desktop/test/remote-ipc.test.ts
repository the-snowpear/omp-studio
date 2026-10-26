import assert from "node:assert/strict";
import { test } from "node:test";
import { registerRemoteIpc } from "../src/remote/ipc.js";
import { REMOTE_CHANNELS } from "../src/remote/shared.js";
import type { RemoteConnectionManager } from "../src/remote/manager.js";

function fixture() {
  type Handler = (event: { sender: typeof sender }, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const sender = { getURL: () => "file:///renderer/index.html", isDestroyed: () => false, send: () => {} };
  const calls = { connect: 0, cancel: 0, disconnect: 0 };
  let confirm = async () => true;
  let connect = async (_id: string, _credentials: unknown, _signal: AbortSignal) => {};
  const manager = {
    list: async () => ({ profiles: [], statuses: [] }), profile: () => ({ id: "target", name: "Test" }),
    connect: async (id: string, credentials: unknown, signal: AbortSignal) => { calls.connect++; await connect(id, credentials, signal); },
    cancelPending: async () => { calls.cancel++; }, disconnect: async () => { calls.disconnect++; },
    onEvent: () => () => {}, onChanged: () => () => {},
  } as unknown as RemoteConnectionManager;
  const ipc = registerRemoteIpc({ ipc: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => { handlers.delete(name); } }, manager,
    isTrusted: () => true, confirmDeployment: () => confirm(), installRuntime: async () => ({ installed: false }) });
  return { ipc, calls, handlers, invoke: (channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)!({ sender }, ...args)),
    setConfirm: (value: typeof confirm) => { confirm = value; }, setConnect: (value: typeof connect) => { connect = value; } };
}

test("renderer navigation cancels a pending deployment confirmation and preserves usable IPC", async () => {
  const f = fixture();
  let release!: (confirmed: boolean) => void;
  f.setConfirm(() => new Promise(resolve => { release = resolve; }));
  const credentials = { password: "test-only" };
  const pending = f.invoke(REMOTE_CHANNELS.connect, "target", credentials);
  const rejected = assert.rejects(pending, /取消/);
  await new Promise(resolve => setImmediate(resolve));
  await f.ipc.cancelPending();
  await rejected;
  assert.equal(credentials.password, ""); assert.equal(f.calls.connect, 0);
  release(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.connect, 0);
  f.setConfirm(async () => true);
  await f.invoke(REMOTE_CHANNELS.connect, "target");
  assert.equal(f.calls.connect, 1);
  assert.ok(f.handlers.has(REMOTE_CHANNELS.connect));
  f.ipc.dispose();
});

test("finishing connect does not abort the established SSH channel", async () => {
  const f = fixture();
  let signal!: AbortSignal;
  f.setConnect(async (_id, _credentials, value) => { signal = value; });
  await f.invoke(REMOTE_CHANNELS.connect, "target");
  assert.equal(signal.aborted, false);
  await f.ipc.cancelPending();
  assert.equal(signal.aborted, false);
  f.ipc.dispose();
});

test("renderer navigation aborts a running connect and a later request is independent", async () => {
  const f = fixture();
  let signal!: AbortSignal;
  f.setConnect(async (_id, _credentials, value) => {
    signal = value;
    await new Promise<void>((_resolve, reject) => value.addEventListener("abort", () => reject(new Error("连接已取消")), { once: true }));
  });
  const credentials = { password: "test-only" };
  const pending = f.invoke(REMOTE_CHANNELS.connect, "target", credentials);
  const rejected = assert.rejects(pending, /取消/);
  await new Promise(resolve => setImmediate(resolve));
  await f.ipc.cancelPending(); await rejected;
  assert.equal(signal.aborted, true); assert.equal(credentials.password, "");
  f.setConnect(async () => {});
  await f.invoke(REMOTE_CHANNELS.connect, "target");
  assert.equal(f.calls.connect, 2);
  f.ipc.dispose();
});
