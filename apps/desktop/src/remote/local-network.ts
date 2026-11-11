import { request } from "node:http";
import { request as secureRequest } from "node:https";
import type { Duplex } from "node:stream";
import type { TcpNetConnectOpts } from "node:net";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { SocksClient } from "socks";
import { connectTcp, remotePrivateHost } from "./network-proxy.js";
import type { NetworkDestination } from "./network-stream.js";

export type NetworkLookup = (hostname: string, options: { all: true; order: "ipv4first" }) => Promise<readonly LookupAddress[]>;

export async function localNetworkConnect(destination: NetworkDestination, proxyUrl?: string, resolveProxy?: (url: string) => Promise<string>, resolveHost: NetworkLookup = lookup): Promise<Duplex> {
  // Resolve once at the executing Desktop service. Every actual connection uses
  // only these public addresses, including tunnels through a configured proxy.
  const addresses = (await resolveHost(destination.host, { all: true, order: "ipv4first" }))
    .filter(address => !remotePrivateHost(address.address));
  if (!addresses.length) throw Object.assign(new Error("本机联网出口不连接远端请求的私有地址"), { code: "PRIVATE_NETWORK_DESTINATION" });
  let proxy = proxyUrl;
  if (!proxy && resolveProxy) {
    const rule = (await resolveProxy(`https://${destination.host}:${destination.port}`)).split(";")[0]?.trim() ?? "DIRECT";
    const match = /^(PROXY|HTTPS|SOCKS5?|SOCKS) (.+)$/u.exec(rule);
    if (match) proxy = `${match[1]!.startsWith("SOCKS") ? "socks5" : match[1] === "HTTPS" ? "https" : "http"}://${match[2]}`;
  }
  if (!proxy) {
    const pinnedLookup: NonNullable<TcpNetConnectOpts["lookup"]> = (_host, options, callback) => {
      process.nextTick(() => callback(null, options.all ? [...addresses] : addresses[0]!.address, addresses[0]!.family));
    };
    return connectTcp(destination.host, destination.port, 10_000, pinnedLookup);
  }
  const url = new URL(proxy);
  const proxyHost = url.hostname.replace(/^\[|\]$/gu, "");
  const connectProxy = async (target: string): Promise<Duplex> => {
    if (url.protocol.startsWith("socks")) {
      const result = await SocksClient.createConnection({ proxy: { host: proxyHost, port: Number(url.port || 1080), type: 5, ...(url.username ? { userId: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {}) }, command: "connect", destination: { host: target, port: destination.port }, timeout: 10_000 });
      return result.socket;
    }
    return new Promise<Duplex>((resolve, reject) => {
      const send = url.protocol === "https:" ? secureRequest : request;
      const authorization = url.username ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}` : undefined;
      const authority = `${target.includes(":") ? `[${target}]` : target}:${destination.port}`;
      const req = send({ hostname: proxyHost, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), method: "CONNECT", path: authority, headers: { Host: authority, ...(authorization ? { "Proxy-Authorization": authorization } : {}) }, agent: false });
      req.setTimeout(10_000, () => req.destroy(new Error("本机上游代理连接超时")));
      req.once("error", reject);
      req.once("connect", (response, socket, head) => {
        req.setTimeout(0);
        if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`本机上游代理拒绝连接：HTTP ${response.statusCode}`)); return; }
        if (head.length) socket.unshift(head); resolve(socket);
      });
      req.end();
    });
  };
  let failure: unknown;
  // Try only tunnel establishment; callers have not sent target HTTP or model bytes yet.
  for (const { address } of addresses) {
    try { return await connectProxy(address); }
    catch (error) { failure = error; }
  }
  throw failure;
}
