import type { ClientBootstrap, ClientCommandAccepted, ClientCommandRequest, ClientEvent, ClientQueryRequest, ClientQueryResponse, ClientTransport, CommandName, QueryName, SubscriptionScope, Unsubscribe, WorkspaceId } from '@omp-studio/client-contract';

export interface MobileBrowserSession { workspaceId: WorkspaceId; workspaceName: string; expiresAt: number; }

export interface WebSocketLike { send(data: string): void; close(): void; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; }
export interface BrowserWebClientOptions {
  baseUrl: string;
  contextId?: string;
  fetcher?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
  mobile?: { onDisconnect: () => void };
  headers?: () => Record<string, string>;
  onRecovered?: () => void;
  onSessionLost?: () => void;
}

/** Browser-side ClientTransport over the loopback HTTP/WebSocket adapter. */
export class BrowserWebClientTransport implements ClientTransport {
  readonly #connectionListeners = new Set<(connected: boolean) => void>();
  #reconnecting = false;
  #scope?: import('@omp-studio/client-contract').ClientContextScope;
  #contextId: string | undefined;
  readonly #retry = new Set<() => void>();
  readonly #children = new Set<BrowserWebClientTransport>();
  #parent: BrowserWebClientTransport | undefined;
  reconnect(): void { for (const retry of this.#retry) retry(); for (const child of this.#children) child.reconnect(); }
  onConnectionChange(listener: (connected: boolean) => void): Unsubscribe {
    this.#connectionListeners.add(listener);
    return () => { this.#connectionListeners.delete(listener); };
  }
  #ready?: Promise<void>;
  readonly #options: BrowserWebClientOptions; readonly #base: string; readonly #fetch: typeof fetch; readonly #wsFactory?: (url: string) => WebSocketLike; #csrf?: string; #closed=false; #closing: Promise<void> | undefined; readonly #sockets = new Set<WebSocketLike>();
  constructor(options: BrowserWebClientOptions) {
    this.#options = options;
    this.#contextId = options.contextId;
    this.#base = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetcher ?? globalThis.fetch.bind(globalThis);
    if (options.webSocketFactory) this.#wsFactory = options.webSocketFactory;
  }
  async pair(code: string, name?: string): Promise<void> { const r = await this.#fetch(this.#base+'/api/v1/pair',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({code, name})}); if(!r.ok) throw new Error('pair_failed'); const b=await r.json() as {csrf?:string}; if(typeof b.csrf!=='string') throw new Error('pair_failed'); this.#csrf=b.csrf; }
  request(path: string, method = "GET", body?: unknown): Promise<unknown> { return this.req(path, method, body); }
  async restoreSession(): Promise<MobileBrowserSession> {
    const { csrf, ...session } = await this.req("/api/v1/session", "GET") as MobileBrowserSession & { csrf: string };
    this.#csrf = csrf;
    return session;
  }
  async openContext(scope: import('@omp-studio/client-contract').ClientContextScope): Promise<ClientTransport> {
    const result = await this.req('/api/v1/context/open', 'POST', scope) as { contextId: string };
    const client = new BrowserWebClientTransport({ ...this.#options, contextId: result.contextId });
    client.#parent = this;
    this.#children.add(client);
    client.#scope = scope;
    if (this.#csrf !== undefined) client.#csrf = this.#csrf; return client;
  }
  async bootstrap(): Promise<ClientBootstrap> {
    await this.#ready;
    const state = await this.req('/api/v1/bootstrap','GET') as ClientBootstrap;
    if (this.#scope && state.selected.sessionId) this.#scope = { ...this.#scope, sessionId: state.selected.sessionId };
    return state;
  }
  async query<T extends QueryName>(request: ClientQueryRequest<T>): Promise<ClientQueryResponse<T>> { return this.req('/api/v1/query','POST',request) as Promise<ClientQueryResponse<T>>; }
  async command<T extends CommandName>(request: ClientCommandRequest<T>): Promise<ClientCommandAccepted<T>> { return this.req('/api/v1/command','POST',request) as Promise<ClientCommandAccepted<T>>; }
  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    if (this.#options.onRecovered) return this.subscribeRecovering(scope, listener);
    return this.subscribeOnce(scope, listener);
  }
  private subscribeRecovering(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    let stopped = false;
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const connect = async () => {
      try {
        if (attempts) {
          await this.restoreSession();
          if (this.#scope) {
            const previous = this.#contextId;
            if (previous) await this.req('/api/v1/context/close', 'POST', {}).catch(() => {});
            this.#contextId = undefined;
            const result = await this.req('/api/v1/context/open', 'POST', this.#scope) as { contextId: string };
            this.#contextId = result.contextId;
          }
        }
        if (stopped || this.#closed) return;
        off = this.subscribeOnce(scope, listener, lost);
        await this.#ready;
        if (stopped) return;
        this.#reconnecting = false;
        if (attempts) { for (const listener of this.#connectionListeners) listener(true); this.#options.onRecovered?.(); }
        attempts = 0;
      } catch (error) {
        if (error instanceof Error && error.message === "unauthenticated") {
          attempts = 8;
          this.#options.onSessionLost?.();
        }
        lost();
      }
    };
    const lost = () => {
      if (stopped || this.#closed || timer) return;
      off?.(); this.#reconnecting = true; for (const listener of this.#connectionListeners) listener(false);
      this.#options.mobile?.onDisconnect();
      attempts++;
      if (attempts > 8) return;
      timer = setTimeout(() => { timer = undefined; void connect(); }, Math.min(1000 * 2 ** (attempts - 1), 15000));
    };
    const retry = () => { if (stopped || this.#closed) return; clearTimeout(timer); timer = undefined; attempts = 1; off?.(); void connect(); };
    this.#retry.add(retry);
    void connect();
    return () => { stopped = true; clearTimeout(timer); this.#retry.delete(retry); off?.(); };
  }
  private subscribeOnce(scope: SubscriptionScope, listener: (event: ClientEvent) => void, lost?: () => void): Unsubscribe {
    if (this.#closed) throw new Error("transport_closed");
    if (!this.#wsFactory) throw new Error("websocket_unavailable");
    const query = this.#contextId ? "?contextId=" + encodeURIComponent(this.#contextId) : "";
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
        } else {
          if (frame.kind === "snapshot" && this.#scope) this.#scope = { ...this.#scope, sessionId: frame.snapshot.sessionId as import('@omp-studio/client-contract').SessionId };
          listener(frame);
        }
      } catch {}
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      onFailure(new Error("event_stream_closed"));
      if (this.#sockets.delete(socket)) { if (lost) lost(); else this.#options.mobile?.onDisconnect(); }
    };
    return () => { this.#sockets.delete(socket); socket.close(); };
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#parent) this.#parent.#children.delete(this);
    this.#closing = this.#contextId
      ? this.req('/api/v1/context/close', 'POST', {}).then(() => {})
      : Promise.resolve();
    this.#closed = true;
    for (const socket of this.#sockets) {
      this.#sockets.delete(socket);
      socket.close();
    }
    return this.#closing;
  }
  private async req(path: string, method: string, body?: unknown): Promise<unknown> {
    if (this.#closed) throw new Error('transport_closed');
    if (this.#reconnecting && path === '/api/v1/command') throw new Error('connection_lost');
    const headers: Record<string, string> = { ...this.#options.headers?.() };
    if (this.#contextId) headers['X-Studio-Context'] = this.#contextId;
    const init: RequestInit = { method, credentials: 'include', headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['X-Studio-CSRF'] = this.#csrf ?? '';
      init.body = JSON.stringify(body);
    }
    const response = await this.#fetch(this.#base + path, init);
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { message?: string; error?: string };
      throw new Error(error.message ?? error.error ?? `http_${response.status}`);
    }
    return response.json();
  }
}
