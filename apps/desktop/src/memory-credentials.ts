import { createServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretCodec } from "./service-definitions.js";

export interface MemoryCredentialEntry { url: string; token: string }
interface StoredMemoryCredential extends MemoryCredentialEntry { target: string }

/** Match the URL the Runtime actually uses, without sharing credentials between services. */
export function memoryCredentialUrl(url: string): string {
  const parsed = new URL(url.trim());
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid Hindsight service URL");
  return parsed.toString().replace(/\/+$/u, "");
}

/** Encrypted at rest; plaintext is only returned to Main's private Runtime/SSH channel. */
export class MemoryCredentialStore {
  #queue: Promise<unknown> = Promise.resolve();
  #listeners = new Set<(target: string) => void>();
  constructor(readonly file: string, readonly codec: SecretCodec) {}

  async #read(): Promise<StoredMemoryCredential[]> {
    if (!this.codec.available()) throw new Error("Secure storage is unavailable");
    let data: Buffer;
    try { data = await readFile(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    try { return JSON.parse(this.codec.decrypt(data)) as StoredMemoryCredential[]; }
    catch { throw new Error("Secure storage is locked or unavailable"); }
  }

  async list(target: string): Promise<MemoryCredentialEntry[]> {
    await this.#queue.catch(() => {});
    return (await this.#read()).filter(row => row.target === target).map(({ url, token }) => ({ url, token }));
  }

  async has(target: string, url: string): Promise<boolean> {
    const normalized = memoryCredentialUrl(url);
    return (await this.list(target)).some(row => row.url === normalized);
  }

  set(target: string, url: string, token: string | undefined): Promise<void> {
    const normalized = memoryCredentialUrl(url);
    const next = this.#queue.catch(() => {}).then(async () => {
      const rows = (await this.#read()).filter(row => row.target !== target || row.url !== normalized);
      if (token) rows.push({ target, url: normalized, token });
      const encrypted = this.codec.encrypt(JSON.stringify(rows));
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = this.file + ".tmp";
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await rename(temporary, this.file);
      for (const listener of this.#listeners) listener(target);
    });
    this.#queue = next;
    return next;
  }

  subscribe(listener: (target: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export interface MemoryCredentialProvider {
  get(url: string): Promise<string | undefined>;
  subscribe(listener: () => void): () => void;
}

export function localMemoryCredentialProvider(store: MemoryCredentialStore, target: string): MemoryCredentialProvider {
  return {
    async get(url) { const normalized = memoryCredentialUrl(url); return (await store.list(target)).find(row => row.url === normalized)?.token; },
    subscribe(listener) { return store.subscribe(changed => { if (changed === target) listener(); }); },
  };
}

/** Remote Host retains these credentials only in memory, never in provisioning files. */
export class TransientMemoryCredentials implements MemoryCredentialProvider {
  #entries: MemoryCredentialEntry[] = [];
  #listeners = new Set<() => void>();
  #ready: Promise<void>;
  #markReady: () => void = () => {};
  constructor() { this.#ready = new Promise(resolve => { this.#markReady = resolve; }); }
  async get(url: string): Promise<string | undefined> {
    await this.#ready;
    const normalized = memoryCredentialUrl(url);
    return this.#entries.find(row => row.url === normalized)?.token;
  }
  replace(entries: MemoryCredentialEntry[]): void {
    this.#entries = entries.map(row => ({ url: memoryCredentialUrl(row.url), token: row.token }));
    this.#markReady();
    for (const listener of this.#listeners) listener();
  }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
}

/** A private per-worker channel authenticated with that Worker's Bridge token. */
export async function startMemoryCredentialBroker(provider: MemoryCredentialProvider, token: string): Promise<{ url: string; close(): Promise<void> }> {
  let revision = 0;
  const waiting = new Set<ServerResponse>();
  const notify = () => {
    revision++;
    for (const response of waiting) response.end(JSON.stringify({ revision }));
    waiting.clear();
  };
  const unsubscribe = provider.subscribe(notify);
  const server = createServer((request, response) => {
    void (async () => {
      const supplied = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { response.writeHead(401).end(); return; }
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      if (request.method !== "GET") { response.writeHead(405).end(); return; }
      if (url.pathname === "/credential") {
        const credential = await provider.get(url.searchParams.get("url") ?? "");
        response.end(JSON.stringify({ revision, ...(credential ? { token: credential } : {}) }));
        return;
      }
      if (url.pathname === "/watch") {
        if (Number(url.searchParams.get("revision")) !== revision) { response.end(JSON.stringify({ revision })); return; }
        waiting.add(response);
        const timer = setTimeout(() => response.end(JSON.stringify({ revision })), 25_000);
        response.on("close", () => { clearTimeout(timer); waiting.delete(response); });
        return;
      }
      response.writeHead(404).end();
    })().catch(() => { if (!response.headersSent) response.writeHead(503); response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Memory credential channel unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      unsubscribe();
      for (const response of waiting) response.end();
      waiting.clear();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
