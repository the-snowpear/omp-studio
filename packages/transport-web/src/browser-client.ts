import type { ClientBootstrap, ClientCommandAccepted, ClientCommandRequest, ClientEvent, ClientQueryRequest, ClientQueryResponse, ClientTransport, CommandName, QueryName, SubscriptionScope, Unsubscribe, WorkspaceId } from '@omp-studio/client-contract';

export interface MobileBrowserSession { workspaceId: WorkspaceId; workspaceName: string; expiresAt: number; }

export interface WebSocketLike { send(data: string): void; close(): void; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; }
export interface BrowserWebClientOptions {
  baseUrl: string;
  contextId?: string;
  fetcher?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
  mobile?: { onDisconnect: () => void };
}

/** Browser-side ClientTransport over the loopback HTTP/WebSocket adapter. */
export class BrowserWebClientTransport implements ClientTransport {
  #ready?: Promise<void>;
  readonly #options: BrowserWebClientOptions; readonly #base: string; readonly #fetch: typeof fetch; readonly #wsFactory?: (url: string) => WebSocketLike; #csrf?: string; #closed=false; #closing: Promise<void> | undefined; readonly #sockets = new Set<WebSocketLike>();
  constructor(options: BrowserWebClientOptions) {
    this.#options = options;
    this.#base = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetcher ?? globalThis.fetch.bind(globalThis);
    if (options.webSocketFactory) this.#wsFactory = options.webSocketFactory;
  }
  async pair(code: string): Promise<void> { const r = await this.#fetch(this.#base+'/api/v1/pair',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({code})}); if(!r.ok) throw new Error('pair_failed'); const b=await r.json() as {csrf?:string}; if(typeof b.csrf!=='string') throw new Error('pair_failed'); this.#csrf=b.csrf; }
  async restoreSession(): Promise<MobileBrowserSession> {
    const { csrf, ...session } = await this.req("/api/v1/session", "GET") as MobileBrowserSession & { csrf: string };
    this.#csrf = csrf;
    return session;
  }
  async openContext(scope: import('@omp-studio/client-contract').ClientContextScope): Promise<ClientTransport> {
    const result = await this.req('/api/v1/context/open', 'POST', scope) as { contextId: string };
    const client = new BrowserWebClientTransport({ ...this.#options, contextId: result.contextId });
    if (this.#csrf !== undefined) client.#csrf = this.#csrf; return client;
  }
  async bootstrap(): Promise<ClientBootstrap> {
    await this.#ready;
    return this.req('/api/v1/bootstrap','GET') as Promise<ClientBootstrap>;
  }
  async query<T extends QueryName>(request: ClientQueryRequest<T>): Promise<ClientQueryResponse<T>> { return this.req('/api/v1/query','POST',request) as Promise<ClientQueryResponse<T>>; }
  async command<T extends CommandName>(request: ClientCommandRequest<T>): Promise<ClientCommandAccepted<T>> { return this.req('/api/v1/command','POST',request) as Promise<ClientCommandAccepted<T>>; }
  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    if (this.#closed) throw new Error("transport_closed");
    if (!this.#wsFactory) throw new Error("websocket_unavailable");
    const query = this.#options.contextId ? "?contextId=" + encodeURIComponent(this.#options.contextId) : "";
    const socket = this.#wsFactory(this.#base.replace(/^http/, "ws") + "/api/v1/events" + query);
    this.#sockets.add(socket);
    let onReady: () => void = () => {};
    let onFailure: (error: Error) => void = () => {};
    const timeout = this.#options.mobile ? setTimeout(() => socket.close(), 8_000) : undefined;
    if (this.#options.mobile) {
      this.#ready = new Promise<void>((resolve, reject) => { onReady = resolve; onFailure = reject; });
      void this.#ready.catch(() => {});
    } else {
      socket.onopen = () => socket.send(JSON.stringify({ scope }));
    }
    socket.onmessage = ({ data }) => {
      try {
        const frame = JSON.parse(data) as ClientEvent | { kind: "mobile.ready" };
        if (frame.kind === "mobile.ready") {
          clearTimeout(timeout);
          onReady();
        } else listener(frame);
      } catch {}
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      onFailure(new Error("event_stream_closed"));
      if (this.#sockets.delete(socket)) this.#options.mobile?.onDisconnect();
    };
    return () => { this.#sockets.delete(socket); socket.close(); };
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = this.#options.contextId
      ? this.req('/api/v1/context/close', 'POST', {}).then(() => {})
      : Promise.resolve();
    this.#closed = true;
    for (const socket of this.#sockets) {
      this.#sockets.delete(socket);
      socket.close();
    }
    return this.#closing;
  }
  private async req(path:string, method:string, body?:unknown): Promise<unknown> { if(this.#closed) throw new Error('transport_closed'); const headers: Record<string,string> = {}; if(this.#options.contextId) headers["X-Studio-Context"]=this.#options.contextId; const init: RequestInit = {method,credentials:'include',headers}; if(body!==undefined){ headers['content-type']='application/json'; headers['X-Studio-CSRF']=this.#csrf ?? ''; init.body=JSON.stringify(body); } const r=await this.#fetch(this.#base+path,init); if(!r.ok) throw new Error(`http_${r.status}`); return r.json(); }
}
