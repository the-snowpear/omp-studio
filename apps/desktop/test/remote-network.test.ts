import assert from "node:assert/strict";
import { createServer as httpServer, request } from "node:http";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { RemotePeer } from "../src/remote/wire.js";
import { NetworkStreams } from "../src/remote/network-stream.js";
import { RemoteNetworkProxy, connectTcp } from "../src/remote/network-proxy.js";

async function fixture(mode: "remote-first" | "remote-only" | "local-only" = "remote-first") {
  let calls = 0, remoteAttempts = 0, localAttempts = 0;
  const origin = httpServer((_req, res) => { calls++; res.writeHead(200); res.write("data: first\n\n"); res.end("data: done\n\n"); });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const a = new PassThrough(), b = new PassThrough();
  const remote = new RemotePeer(a, b), local = new RemotePeer(b, a);
  const localStreams = new NetworkStreams(local, async () => { localAttempts++; return connectTcp("127.0.0.1", (origin.address() as AddressInfo).port); });
  const streams = new NetworkStreams(remote);
  const proxy = new RemoteNetworkProxy(async () => { remoteAttempts++; throw Object.assign(new Error("offline"), { code: "ENETUNREACH" }); });
  proxy.attach(streams); proxy.configure(mode); await proxy.start();
  const get = () => new Promise<string>((resolve, reject) => {
    const req = request(proxy.proxyUrl, { path: "http://model.example.test/v1/stream" }, res => { let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))); });
    req.once("error", reject); req.end();
  });
  return { proxy, get, origin, calls: () => ({ calls, remoteAttempts, localAttempts }), async close() { await proxy.close(); streams.close(); localStreams.close(); remote.close(); local.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())); } };
}

test("offline remote falls back before dispatch, preserves streaming and remembers the local route", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.get(), "data: first\n\ndata: done\n\n");
    await f.get();
    assert.deepEqual(f.calls(), { calls: 2, remoteAttempts: 1, localAttempts: 2 });
    f.proxy.reset(); await f.get(); assert.equal(f.calls().remoteAttempts, 2);
  } finally { await f.close(); }
});
test("remote-only never calls the local relay and local-only never attempts the remote network", async () => {
  const remote = await fixture("remote-only");
  try { await assert.rejects(remote.get(), /502/); assert.equal(remote.calls().localAttempts, 0); }
  finally { await remote.close(); }
  const local = await fixture("local-only");
  try { await local.get(); assert.equal(local.calls().remoteAttempts, 0); }
  finally { await local.close(); }
});
test("a large streamed body crosses the separate channel with backpressure", async () => {
  const a = new PassThrough({ highWaterMark: 4096 }), b = new PassThrough({ highWaterMark: 4096 });
  const client = new RemotePeer(a, b), server = new RemotePeer(b, a);
  const payload = Buffer.alloc(2 * 1024 * 1024, 42);
  const origin = httpServer((_req, res) => res.end(payload));
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const remote = new NetworkStreams(client), local = new NetworkStreams(server, () => connectTcp("127.0.0.1", (origin.address() as AddressInfo).port));
  try {
    const stream = await remote.open({ host: "test", port: 80 }); stream.write("GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n");
    const chunks: Buffer[] = []; for await (const bytes of stream) chunks.push(Buffer.from(bytes));
    const data = Buffer.concat(chunks), body = data.subarray(data.indexOf("\r\n\r\n") + 4);
    assert.deepEqual(body, payload);
  } finally { remote.close(); local.close(); client.close(); server.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())); }
});
test("an HTTP rejection is returned without another network route or request replay", async () => {
  let calls = 0, localCalls = 0;
  const origin = httpServer((_req, res) => { calls++; res.writeHead(401).end("no credential"); });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const proxy = new RemoteNetworkProxy(() => connectTcp("127.0.0.1", (origin.address() as AddressInfo).port));
  proxy.report = route => { if (route === "local") localCalls++; }; await proxy.start();
  try {
    await new Promise<void>((resolve, reject) => { const req = request(proxy.proxyUrl, { method: "POST", path: "http://model.test/v1/messages" }, res => { assert.equal(res.statusCode, 401); res.resume(); res.once("end", resolve); }); req.once("error", reject); req.end("prompt"); });
    assert.equal(calls, 1); assert.equal(localCalls, 0);
  } finally { await proxy.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())); }
});
