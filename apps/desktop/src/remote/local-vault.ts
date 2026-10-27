import { spawn, exec, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { readFile, watch, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "yaml";
import { MIRRORED_MODEL_SETTINGS, type RemoteProvisioning } from "./provisioning.js";

export interface LocalVaultOptions {
  agentDirectory: () => string;
  brokerFile: () => Promise<string>;
  runtimeExecutable: () => Promise<string>;
}
export class LocalCredentialVault {
  private owned: ChildProcess | undefined;
  private opening: Promise<{ url: string; token: string }> | undefined;
  private relay: Server | undefined;
  private relayEndpoint: Promise<{ url: string; token: string }> | undefined;
  constructor(readonly options: LocalVaultOptions) {}
  async endpoint(): Promise<{ url: string; token: string }> {
    try {
      const value = JSON.parse(await readFile(await this.options.brokerFile(), "utf8")) as { url: string; token: string };
      if ((await fetch(`${value.url}/v1/healthz`, { signal: AbortSignal.timeout(1500) })).ok) return value;
    } catch { /* No local resident: start the native headless vault, with no model call. */ }
    return this.opening ??= this.start().catch(error => { this.opening = undefined; throw error; });
  }
  private async start(): Promise<{ url: string; token: string }> {
    const directory = this.options.agentDirectory();
    const config = parse(await readFile(join(directory, "config.yml"), "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; })) as { auth?: { broker?: { url?: string; token?: string } } };
    if (config?.auth?.broker?.url && config.auth.broker.token) return { url: config.auth.broker.url, token: config.auth.broker.token };
    const port = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = (server.address() as import("node:net").AddressInfo).port; server.close(() => resolve(port)); }); });
    const url = `http://127.0.0.1:${port}`;
    const child = this.owned = spawn(await this.options.runtimeExecutable(), ["auth-broker", "serve", `--bind=127.0.0.1:${port}`], { windowsHide: true, stdio: "ignore", env: { ...process.env, OMP_AGENT_DIR: directory, PI_CODING_AGENT_DIR: directory } });
    let failure: Error | undefined; child.once("error", error => { failure = error; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error("本机凭证服务启动失败，请检查 Runtime 的 Auth Broker 支持");
      try {
        if ((await fetch(`${url}/v1/healthz`, { signal: AbortSignal.timeout(500) })).ok) {
          const token = (await readFile(join(dirname(directory), "auth-broker.token"), "utf8")).trim();
          return { url, token };
        }
      } catch { /* The native service is still opening its credential store. */ }
      await delay(100);
    }
    child.kill(); throw new Error("本机凭证服务启动超时");
  }
  async snapshot(): Promise<RemoteProvisioning> {
    const directory = this.options.agentDirectory();
    const text = await readFile(join(directory, "models.yml"), "utf8").catch(error => { if (error.code === "ENOENT") return "providers: {}\n"; throw error; });
    const models = (parse(text) ?? {}) as { providers?: Record<string, { apiKey?: string }> };
    for (const provider of Object.values(models?.providers ?? {})) {
      if (provider.apiKey && /^[A-Z_][A-Z0-9_]*$/u.test(provider.apiKey) && process.env[provider.apiKey]) provider.apiKey = process.env[provider.apiKey]!;
      if (provider.apiKey?.startsWith("!")) provider.apiKey = (await promisify(exec)(provider.apiKey.slice(1), { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim();
    }
    const native = await this.endpoint();
    const authSnapshot = await fetch(`${native.url}/v1/snapshot`, { headers: { Authorization: `Bearer ${native.token}` } }).then(response => {
      if (!response.ok) throw new Error("无法读取本机模型凭证");
      return response.json() as Promise<{ credentials?: { provider: string; credential: { type?: string; key?: string } }[] }>;
    });
    const providers = models.providers ??= {};
    for (const row of authSnapshot.credentials ?? []) {
      if (row.provider.startsWith("mcp:") || row.credential.type !== "api_key" || !row.credential.key) continue;
      const provider = providers[row.provider] ??= {};
      provider.apiKey ??= row.credential.key;
    }
    const config = parse(await readFile(join(directory, "config.yml"), "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; })) as Record<string, unknown> ?? {};
    const settings = Object.fromEntries(MIRRORED_MODEL_SETTINGS.filter(key => key !== "auth" && Object.hasOwn(config, key)).map(key => [key, config[key]]));
    const endpoint = await this.networkEndpoint();
    return { modelsYml: stringify(models || { providers: {} }), settings, brokerToken: endpoint.token };
  }
  /** Narrow read/refresh relay: MCP secrets and credential-upload APIs never cross SSH. */
  networkEndpoint(): Promise<{ url: string; token: string }> {
    return this.relayEndpoint ??= new Promise((resolve, reject) => {
      const token = randomBytes(32).toString("base64url");
      const server = this.relay = createHttpServer((request, response) => {
        void (async () => {
          if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
          const route = new URL(request.url!, "http://broker");
          if (route.pathname === "/v1/snapshot/stream") { response.writeHead(404).end(); return; }
          const refresh = /^\/v1\/credential\/(\d+)\/refresh$/u.exec(route.pathname);
          const allowedGet = ["/v1/healthz", "/v1/snapshot", "/v1/usage", "/v1/usage/history", "/v1/credentials/disabled"];
          if (!(request.method === "GET" && allowedGet.includes(route.pathname)) && !(request.method === "POST" && (refresh || route.pathname === "/v1/usage/observed" || route.pathname === "/v1/usage/stale"))) { response.writeHead(403).end(); return; }
          const native = await this.endpoint();
          const headers = { Authorization: `Bearer ${native.token}`, "Content-Type": "application/json" };
          if (refresh) {
            const snapshot = await (await fetch(`${native.url}/v1/snapshot`, { headers })).json() as { credentials: { id: number; provider: string }[] };
            if (!snapshot.credentials.some(row => row.id === Number(refresh[1]) && !row.provider.startsWith("mcp:"))) { response.writeHead(403).end(); return; }
          }
          const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const controller = new AbortController(); response.once("close", () => controller.abort());
          const result = await fetch(`${native.url}${route.pathname}${route.search}`, { method: request.method!, headers, signal: controller.signal, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
          const text = await result.text();
          if (result.status === 304) { response.writeHead(304).end(); return; }
          let body: { credentials?: { provider: string }[]; entries?: { provider: string }[]; disabled?: { provider: string }[] };
          try { body = JSON.parse(text); } catch { response.writeHead(result.status).end(text); return; }
          for (const key of ["credentials", "entries", "disabled"] as const) if (Array.isArray(body[key])) body[key] = body[key]!.filter(row => !row.provider.startsWith("mcp:"));
          response.writeHead(result.status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body));
        })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end("Credential service unavailable"); });
      });
      server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, token }));
    });
  }
  follow(changed: () => void): () => void {
    const controller = new AbortController(); let timer: NodeJS.Timeout | undefined;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(changed, 300); };
    void (async () => {
      const directory = this.options.agentDirectory(); await mkdir(directory, { recursive: true });
      for await (const event of watch(directory, { signal: controller.signal })) if (["models.yml", "config.yml"].includes(String(event.filename))) schedule();
    })().catch(() => {});
    void (async () => {
      const file = await this.options.brokerFile();
      for await (const event of watch(dirname(file), { signal: controller.signal })) if (String(event.filename) === "auth-broker.json") schedule();
    })().catch(() => {});
    return () => { controller.abort(); clearTimeout(timer); };
  }
  close(): void { this.owned?.kill(); this.owned = undefined; this.opening = undefined; this.relay?.closeAllConnections(); this.relay?.close(); this.relay = undefined; this.relayEndpoint = undefined; }
}
