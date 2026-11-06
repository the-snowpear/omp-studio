import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type {
  ClientBootstrap, ClientCommandRequest, ClientQueryRequest, ClientQueryResponse,
  ClientCommandAccepted, ClientEvent, SubscriptionScope, QueryName, CommandName,
} from "@omp-studio/client-contract";

export interface WebAdapterHost {
  openContext?(scope: import("@omp-studio/client-contract").ClientContextScope): Promise<import("@omp-studio/client-contract").ClientTransport>;
  bootstrap(): Promise<ClientBootstrap>;
  query<T extends QueryName>(request: ClientQueryRequest<T>): Promise<ClientQueryResponse<T>>;
  command<T extends CommandName>(request: ClientCommandRequest<T>): Promise<ClientCommandAccepted<T>>;
  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): () => void;
}

export interface WebAdapterOptions {
  host: WebAdapterHost;
  origins: readonly string[];
  pairingCode?: string;
  pairingTtlMs?: number;
  sessionTtlMs?: number;
  maxBodyBytes?: number;
  maxOutstandingCommands?: number;
  now?: () => number;
}

interface Session { contexts: Map<string, import("@omp-studio/client-contract").ClientTransport>; csrf: string; expiresAt: number; scope: SubscriptionScope; outstanding: number; revoked: boolean }

function token(bytes = 24): string { return randomBytes(bytes).toString("base64url"); }
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string,string> = {}): void {
  const data = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(data);
}
function parseCookies(value: string | undefined): Record<string,string> { const out: Record<string,string> = {}; for (const p of (value ?? "").split(";")) { const i = p.indexOf("="); if (i > 0) out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1).trim()); } return out; }

/** Loopback HTTP adapter implementing pairing, session/CSRF and semantic query/command routes. */
export class LoopbackWebAdapter {
  readonly #options: Required<Pick<WebAdapterOptions,"pairingTtlMs"|"sessionTtlMs"|"maxBodyBytes"|"maxOutstandingCommands">> & WebAdapterOptions;
  readonly #sessions = new Map<string, Session>();
  #pairing: { code: string; expiresAt: number; used: boolean };
  constructor(options: WebAdapterOptions) {
    if (!options.origins.length) throw new TypeError("at least one allowed origin is required");
    this.#options = { pairingTtlMs: 60_000, sessionTtlMs: 3_600_000, maxBodyBytes: 1_048_576, maxOutstandingCommands: 8, ...options };
    this.#pairing = { code: options.pairingCode ?? token(8), expiresAt: this.now() + this.#options.pairingTtlMs, used: false };
  }
  get pairingCode(): string { return this.#pairing.code; }
  private now(): number { return (this.#options.now ?? Date.now)(); }
  private originAllowed(req: IncomingMessage): boolean { const o = req.headers.origin; return typeof o === "string" && this.#options.origins.includes(o); }
  private session(req: IncomingMessage): [string, Session] | undefined { const id = parseCookies(req.headers.cookie).studio_session; if (!id) return; const s = this.#sessions.get(id); if (!s || s.revoked || s.expiresAt <= this.now()) return; return [id,s]; }
  private async body(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; let n=0; for await (const c of req) { n += Buffer.byteLength(c); if (n > this.#options.maxBodyBytes) throw new Error("body_too_large"); chunks.push(Buffer.from(c)); } if (!n) return {}; return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  private auth(req: IncomingMessage, mutate = false): [string,Session] | undefined { if (!this.originAllowed(req)) return; const s = this.session(req); if (!s) return; if (mutate && req.headers["x-studio-csrf"] !== s[1].csrf) return; return s; }
  private target(req: IncomingMessage, session: Session): WebAdapterHost {
    const id = req.headers["x-studio-context"] ?? new URL(req.url ?? "/", "http://localhost").searchParams.get("contextId");
    if (!id) return this.#options.host;
    const context = session.contexts.get(String(id));
    if (!context) throw new Error("context_closed");
    return context;
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === "/health" && req.method === "GET") return json(res, 200, { ok: true, protocolVersion: 1 });
    if (!this.originAllowed(req)) return json(res, 403, { error: "forbidden" });
    const path = (req.url ?? "").split("?")[0];
    try {
      if (path === "/api/v1/pair" && req.method === "POST") {
        const b = await this.body(req); const code = b !== null && typeof b === "object" && "code" in b ? String((b as { code?: unknown }).code ?? "") : "";
        if (this.#pairing.used || this.#pairing.expiresAt <= this.now() || code.length !== this.#pairing.code.length || !timingSafeEqual(Buffer.from(code), Buffer.from(this.#pairing.code))) return json(res, 401, { error: "unauthenticated" });
        this.#pairing.used = true; const sid = token(32), csrf = token(24); const s: Session = { contexts: new Map(), csrf, expiresAt: this.now()+this.#options.sessionTtlMs, scope: { scope: "all" }, outstanding: 0, revoked: false }; this.#sessions.set(sid,s);
        return json(res, 200, { csrf, expiresAt: s.expiresAt }, { "set-cookie": `studio_session=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (path === "/api/v1/context/open" && req.method === "POST") {
        const a = this.auth(req, true); if (!a) return json(res,401,{error:"unauthenticated"});
        if (!this.#options.host.openContext) return json(res,501,{error:"context_unavailable"});
        const context = await this.#options.host.openContext(await this.body(req) as import("@omp-studio/client-contract").ClientContextScope);
        if (a[1].revoked || a[1].expiresAt <= this.now()) { await context.close(); return json(res,401,{error:"unauthenticated"}); }
        const contextId = token(); a[1].contexts.set(contextId, context); return json(res,200,{contextId});
      }
      if (path === "/api/v1/context/close" && req.method === "POST") {
        const a = this.auth(req, true); if (!a) return json(res,401,{error:"unauthenticated"});
        const id = String(req.headers["x-studio-context"] ?? "");
        const context = a[1].contexts.get(id); a[1].contexts.delete(id); await context?.close(); return json(res,200,{closed:true});
      }
      if (path === "/api/v1/session/revoke" && req.method === "POST") { const a = this.auth(req,true); if (!a) return json(res,401,{error:"unauthenticated"}); a[1].revoked=true; this.#sessions.delete(a[0]); const contexts = [...a[1].contexts.values()]; a[1].contexts.clear(); await Promise.all(contexts.map(context => context.close())); return json(res,200,{ok:true}); }
      if (path === "/api/v1/bootstrap" && req.method === "GET") { const a=this.auth(req); if(!a) return json(res,401,{error:"unauthenticated"}); return json(res,200,await this.target(req,a[1]).bootstrap()); }
      if (path === "/api/v1/query" && req.method === "POST") { const a=this.auth(req); if(!a) return json(res,401,{error:"unauthenticated"}); return json(res,200,await this.target(req,a[1]).query(await this.body(req) as ClientQueryRequest)); }
      if (path === "/api/v1/command" && req.method === "POST") { const a=this.auth(req,true); if(!a) return json(res,401,{error:"unauthenticated"}); if(a[1].outstanding>=this.#options.maxOutstandingCommands) return json(res,429,{error:"rate_limited"}); a[1].outstanding++; try { return json(res,202,await this.target(req,a[1]).command(await this.body(req) as ClientCommandRequest)); } finally { a[1].outstanding--; } }
      return json(res,404,{error:"not_found"});
    } catch (e) { return json(res,400,{error: e instanceof Error && e.message === "body_too_large" ? "body_too_large" : "bad_request"}); }
  }
  /** Validate a WebSocket upgrade before accepting it; caller performs actual upgrade. */
  authenticateWebSocket(req: IncomingMessage): { sessionId: string; session: Session; host: WebAdapterHost } | undefined {
    if (!this.originAllowed(req)) return;
    const s = this.session(req);
    if (!s) return;
    // A tab may reconnect after its conversation context has already closed.
    try { return { sessionId: s[0], session: s[1], host: this.target(req, s[1]) }; }
    catch { return; }
  }
}

/** Create a real loopback HTTP server; caller may attach an upgrade handler. */
export function createLoopbackHttpServer(adapter: LoopbackWebAdapter): Server {
  return createServer((req, res) => { void adapter.handle(req, res); });
}
