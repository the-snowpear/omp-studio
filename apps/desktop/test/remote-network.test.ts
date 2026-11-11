import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer as httpServer, request, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";
import { RemotePeer } from "../src/remote/wire.js";
import { NetworkStreams } from "../src/remote/network-stream.js";
import { RemoteNetworkProxy, connectTcp } from "../src/remote/network-proxy.js";

const execFileAsync = promisify(execFile);

/** URL userinfo is proxy authentication, never the target's Authorization. */
function proxyEndpoint(proxyUrl: string): { endpoint: URL; authorization: string } {
  const endpoint = new URL(proxyUrl);
  const authorization = `Basic ${Buffer.from(`${decodeURIComponent(endpoint.username)}:${decodeURIComponent(endpoint.password)}`).toString("base64")}`;
  endpoint.username = ""; endpoint.password = "";
  return { endpoint, authorization };
}

async function fixture(mode: "remote-first" | "remote-only" | "local-only" = "remote-first") {
  let calls = 0, remoteAttempts = 0, localAttempts = 0;
  const received: IncomingHttpHeaders[] = [];
  const origin = httpServer((req, res) => { calls++; received.push(req.headers); res.writeHead(200); res.write("data: first\n\n"); res.end("data: done\n\n"); });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const a = new PassThrough(), b = new PassThrough();
  const remote = new RemotePeer(a, b), local = new RemotePeer(b, a);
  const localStreams = new NetworkStreams(local, async () => { localAttempts++; return connectTcp("127.0.0.1", (origin.address() as AddressInfo).port); });
  const streams = new NetworkStreams(remote);
  const proxy = new RemoteNetworkProxy(async () => { remoteAttempts++; throw Object.assign(new Error("offline"), { code: "ENETUNREACH" }); });
  proxy.attach(streams); proxy.configure(mode); await proxy.start();
  const get = (authenticate = true, authorization?: string) => new Promise<string>((resolve, reject) => {
    const access = proxyEndpoint(proxy.proxyUrl);
    const headers = { Host: "model.example.test", ...(authenticate ? { "Proxy-Authorization": access.authorization } : {}), ...(authorization ? { Authorization: authorization } : {}) };
    const req = request(access.endpoint, { path: "http://model.example.test/v1/stream", headers }, res => { let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))); });
    req.once("error", reject); req.end();
  });
  return { proxy, get, origin, received, calls: () => ({ calls, remoteAttempts, localAttempts }), async close() { await proxy.close(); streams.close(); localStreams.close(); remote.close(); local.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())); } };
}

function tunnel(proxyUrl: string, authenticate: boolean): Promise<{ status: number; socket: Duplex; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const access = proxyEndpoint(proxyUrl);
    const options: RequestOptions = { method: "CONNECT", path: "model.example.test:443", headers: { Host: "model.example.test:443", ...(authenticate ? { "Proxy-Authorization": access.authorization } : {}) } };
    const req = request(access.endpoint, options);
    req.once("error", reject);
    req.once("connect", (response, socket, head) => resolve({ status: response.statusCode ?? 0, socket, head }));
    req.end();
  });
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

test("unowned HTTP and CONNECT requests receive 407 before either network route is used", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.get(false), /HTTP 407/);
    const connection = await tunnel(f.proxy.proxyUrl, false);
    connection.socket.destroy();
    assert.equal(connection.status, 407);
    assert.deepEqual(f.calls(), { calls: 0, remoteAttempts: 0, localAttempts: 0 });
  } finally { await f.close(); }
});

test("authorized proxy requests preserve the target Bearer and streaming without forwarding proxy credentials", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.get(true, "Bearer model-fixture-token"), "data: first\n\ndata: done\n\n");
    assert.equal(f.received[0]?.authorization, "Bearer model-fixture-token");
    assert.equal(f.received[0]?.["proxy-authorization"], undefined);
    assert.equal(f.received[0]?.host, "model.example.test");
    await f.get();
    assert.equal(f.received[1]?.authorization, undefined);
    assert.equal(f.received[1]?.["proxy-authorization"], undefined);
  } finally { await f.close(); }
});

test("authorized CONNECT retains a usable tunnel and target authorization stays inside it", async () => {
  const f = await fixture();
  let socket: Duplex | undefined;
  try {
    const connection = await tunnel(f.proxy.proxyUrl, true); socket = connection.socket;
    assert.equal(connection.status, 200);
    if (connection.head.length) socket.unshift(connection.head);
    socket.write("GET /v1/stream HTTP/1.1\r\nHost: model.example.test\r\nAuthorization: Bearer tunnel-fixture-token\r\nConnection: close\r\n\r\n");
    const chunks: Buffer[] = []; for await (const data of socket) chunks.push(Buffer.from(data));
    const response = Buffer.concat(chunks).toString();
    assert.match(response, /HTTP\/1\.1 200/); assert.match(response, /data: first/); assert.match(response, /data: done/);
    assert.equal(f.received[0]?.authorization, "Bearer tunnel-fixture-token");
    assert.equal(f.received[0]?.["proxy-authorization"], undefined);
    assert.deepEqual(f.calls(), { calls: 1, remoteAttempts: 1, localAttempts: 1 });
  } finally { socket?.destroy(); await f.close(); }
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
    const access = proxyEndpoint(proxy.proxyUrl);
    await new Promise<void>((resolve, reject) => { const req = request(access.endpoint, { method: "POST", path: "http://model.test/v1/messages", headers: { "Proxy-Authorization": access.authorization } }, res => { assert.equal(res.statusCode, 401); res.resume(); res.once("end", resolve); }); req.once("error", reject); req.end("prompt"); });
    assert.equal(calls, 1); assert.equal(localCalls, 0);
  } finally { await proxy.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())); }
});

test("pinned Bun fetch uses proxy URL credentials without converting them to target credentials", { skip: !process.env.BUN_EXE }, async () => {
  const bun = process.env.BUN_EXE!;
  assert.equal((await execFileAsync(bun, ["--version"], { windowsHide: true })).stdout.trim(), "1.4.4");
  const f = await fixture();
  try {
    const script = `const output = []; for (const authorization of [undefined, "Bearer bun-model-token"]) {
      const response = await fetch(process.env.OMP_TEST_MODEL_URL, { proxy: process.env.OMP_TEST_PROXY_URL, headers: authorization ? { Authorization: authorization } : {} });
      output.push({ status: response.status, text: await response.text() });
    } console.log(JSON.stringify(output));`;
    const run = await execFileAsync(bun, ["-e", script], { windowsHide: true, timeout: 20_000, env: { ...process.env, OMP_TEST_MODEL_URL: "http://model.example.test/v1/stream", OMP_TEST_PROXY_URL: f.proxy.proxyUrl } });
    assert.deepEqual(JSON.parse(run.stdout.trim()), [{ status: 200, text: "data: first\n\ndata: done\n\n" }, { status: 200, text: "data: first\n\ndata: done\n\n" }]);
    assert.equal(f.received[0]?.authorization, undefined);
    assert.equal(f.received[1]?.authorization, "Bearer bun-model-token");
    assert.ok(f.received.every(headers => headers["proxy-authorization"] === undefined));
  } finally { await f.close(); }
});
