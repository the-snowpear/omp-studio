import assert from "node:assert/strict";
import { createServer as httpServer, type IncomingHttpHeaders } from "node:http";
import net, { type AddressInfo, type Socket, type TcpNetConnectOpts } from "node:net";
import type { Duplex } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { localNetworkConnect, type NetworkLookup } from "../src/remote/local-network.js";

async function proxyFixture(rejectedTarget?: string) {
  const requests: Array<{ target: string | undefined; headers: IncomingHttpHeaders }> = [];
  const sockets = new Set<Duplex>();
  const server = httpServer();
  server.on("connect", (req, socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    requests.push({ target: req.url, headers: req.headers });
    socket.end(req.url === rejectedTarget ? "HTTP/1.1 502 Bad Gateway\r\n\r\n" : "HTTP/1.1 200 Connection Established\r\n\r\npinned response");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    requests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test("private DNS results and IPv4-mapped private addresses never reach the Desktop proxy", async () => {
  const proxy = await proxyFixture();
  let lookups = 0;
  try {
    for (const address of ["192.168.4.5", "::ffff:127.0.0.1", "::ffff:a01:203"]) {
      const resolveHost: NetworkLookup = async () => { lookups++; return [{ address, family: address.includes(":") ? 6 : 4 }]; };
      await assert.rejects(localNetworkConnect({ host: "private.example.test", port: 443 }, proxy.url, undefined, resolveHost), { code: "PRIVATE_NETWORK_DESTINATION" });
    }
    assert.equal(lookups, 3); assert.equal(proxy.requests.length, 0);
  } finally { await proxy.close(); }
});

test("the HTTP upstream proxy receives the checked public IP after a single DNS lookup", async () => {
  const proxy = await proxyFixture();
  let lookups = 0;
  const url = new URL(proxy.url); url.username = "upstream-user"; url.password = "upstream-password";
  try {
    const resolveHost: NetworkLookup = async (hostname, options) => {
      lookups++; assert.equal(hostname, "public.example.test"); assert.deepEqual(options, { all: true, order: "ipv4first" });
      return [{ address: "10.0.0.1", family: 4 }, { address: "203.0.113.8", family: 4 }];
    };
    const stream = await localNetworkConnect({ host: "public.example.test", port: 443 }, url.href, undefined, resolveHost);
    const chunks: Buffer[] = []; for await (const data of stream) chunks.push(Buffer.from(data));
    assert.equal(Buffer.concat(chunks).toString(), "pinned response");
    assert.equal(lookups, 1);
    assert.equal(proxy.requests[0]?.target, "203.0.113.8:443");
    assert.equal(proxy.requests[0]?.headers.host, "203.0.113.8:443");
    assert.equal(proxy.requests[0]?.headers.authorization, undefined);
    assert.equal(proxy.requests[0]?.headers["proxy-authorization"], `Basic ${Buffer.from("upstream-user:upstream-password").toString("base64")}`);
  } finally { await proxy.close(); }
});

test("HTTP tunnel establishment tries the next checked public IP without resolving DNS again", async () => {
  const proxy = await proxyFixture("203.0.113.8:443");
  let lookups = 0;
  try {
    const stream = await localNetworkConnect({ host: "public.example.test", port: 443 }, proxy.url, undefined, async () => {
      lookups++;
      return [{ address: "10.0.0.1", family: 4 }, { address: "203.0.113.8", family: 4 }, { address: "203.0.113.9", family: 4 }];
    });
    const chunks: Buffer[] = []; for await (const data of stream) chunks.push(Buffer.from(data));
    assert.equal(Buffer.concat(chunks).toString(), "pinned response");
    assert.equal(lookups, 1);
    assert.deepEqual(proxy.requests.map(request => request.target), ["203.0.113.8:443", "203.0.113.9:443"]);
  } finally { await proxy.close(); }
});

test("checked IPv6 targets retain their bracketed CONNECT authority", async () => {
  const proxy = await proxyFixture();
  try {
    const stream = await localNetworkConnect({ host: "ipv6.example.test", port: 443 }, proxy.url, undefined, async () => [{ address: "2001:db8::8", family: 6 }]);
    for await (const _data of stream) { /* drain the fixture's response */ }
    assert.equal(proxy.requests[0]?.target, "[2001:db8::8]:443");
    assert.equal(proxy.requests[0]?.headers.host, "[2001:db8::8]:443");
  } finally { await proxy.close(); }
});

test("SOCKS tunnel establishment tries checked IPs without resolving DNS again", async () => {
  const sockets = new Set<Socket>(), destinations: Array<{ type: number | undefined; target: string }> = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0), greeted = false;
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (!greeted) {
        if (pending.length < 2 || pending.length < 2 + pending[1]!) return;
        pending = pending.subarray(2 + pending[1]!); greeted = true; socket.write(Buffer.from([5, 0]));
      }
      if (pending.length < 4) return;
      const type = pending[3];
      if (type === 3 && pending.length < 5) return;
      const length = type === 1 ? 10 : type === 3 ? 7 + pending[4]! : 22;
      if (pending.length < length) return;
      const host = type === 1 ? [...pending.subarray(4, 8)].join(".") : pending.subarray(5, 5 + pending[4]!).toString();
      destinations.push({ type, target: `${host}:${pending.readUInt16BE(length - 2)}` });
      if (host === "203.0.113.8") { socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      socket.removeAllListeners("data"); socket.once("data", () => socket.end("socks pinned response"));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let lookups = 0;
  try {
    const stream = await localNetworkConnect({ host: "public.example.test", port: 443 }, `socks5://127.0.0.1:${(server.address() as AddressInfo).port}`, undefined, async () => { lookups++; return [{ address: "203.0.113.8", family: 4 }, { address: "203.0.113.9", family: 4 }]; });
    stream.write("fixture request");
    const chunks: Buffer[] = []; for await (const data of stream) chunks.push(Buffer.from(data));
    assert.equal(Buffer.concat(chunks).toString(), "socks pinned response");
    assert.equal(lookups, 1); assert.deepEqual(destinations, [{ type: 1, target: "203.0.113.8:443" }, { type: 1, target: "203.0.113.9:443" }]);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("direct connections use only the checked lookup results and never perform a second DNS lookup", async context => {
  const server = net.createServer(socket => socket.end("direct pinned response"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port, nativeConnect = net.connect;
  let lookups = 0, pinned: unknown;
  try {
    // Observe the actual pinned lookup, then substitute loopback solely for the local fixture.
    // Every successful native socket in this test still connects to 127.0.0.1.
    context.mock.method(net, "connect", (options: TcpNetConnectOpts) => {
      assert.equal(options.host, "public.example.test"); assert.equal(options.port, port); assert.ok(options.lookup);
      const original = options.lookup;
      const lookup: NonNullable<TcpNetConnectOpts["lookup"]> = (hostname, settings, callback) => {
        original(hostname, settings, (error, address, family) => {
          pinned = address;
          if (error) callback(error, address, family);
          else callback(null, settings.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
        });
      };
      return nativeConnect({ ...options, lookup });
    });
    syncBuiltinESMExports();
    const stream = await localNetworkConnect({ host: "public.example.test", port }, undefined, undefined, async () => { lookups++; return [{ address: "203.0.113.8", family: 4 }]; });
    const chunks: Buffer[] = []; for await (const data of stream) chunks.push(Buffer.from(data));
    assert.equal(Buffer.concat(chunks).toString(), "direct pinned response");
    assert.equal(lookups, 1);
    assert.ok(pinned === "203.0.113.8" || Array.isArray(pinned) && pinned.length === 1 && pinned[0].address === "203.0.113.8");
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
