import { request } from "node:http";
import { request as secureRequest } from "node:https";
import type { Duplex } from "node:stream";
import { SocksClient } from "socks";
import { connectTcp } from "./network-proxy.js";
import type { NetworkDestination } from "./network-stream.js";

export async function localNetworkConnect(destination: NetworkDestination, proxyUrl?: string, resolveProxy?: (url: string) => Promise<string>): Promise<Duplex> {
  let proxy = proxyUrl;
  if (!proxy && resolveProxy) {
    const rule = (await resolveProxy(`https://${destination.host}:${destination.port}`)).split(";")[0]?.trim() ?? "DIRECT";
    const match = /^(PROXY|HTTPS|SOCKS5?|SOCKS) (.+)$/u.exec(rule);
    if (match) proxy = `${match[1]!.startsWith("SOCKS") ? "socks5" : match[1] === "HTTPS" ? "https" : "http"}://${match[2]}`;
  }
  if (!proxy) return connectTcp(destination.host, destination.port);
  const url = new URL(proxy);
  if (url.protocol.startsWith("socks")) {
    const result = await SocksClient.createConnection({ proxy: { host: url.hostname, port: Number(url.port || 1080), type: 5, ...(url.username ? { userId: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {}) }, command: "connect", destination: { host: destination.host, port: destination.port }, timeout: 10_000 });
    return result.socket;
  }
  return new Promise<Duplex>((resolve, reject) => {
    const send = url.protocol === "https:" ? secureRequest : request;
    const authorization = url.username ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}` : undefined;
    const req = send({ hostname: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), method: "CONNECT", path: `${destination.host}:${destination.port}`, headers: { Host: `${destination.host}:${destination.port}`, ...(authorization ? { "Proxy-Authorization": authorization } : {}) }, agent: false });
    req.setTimeout(10_000, () => req.destroy(new Error("本机上游代理连接超时")));
    req.once("error", reject);
    req.once("connect", (response, socket, head) => {
      req.setTimeout(0);
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`本机上游代理拒绝连接：HTTP ${response.statusCode}`)); return; }
      if (head.length) socket.unshift(head); resolve(socket);
    });
    req.end();
  });
}
