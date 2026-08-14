import type { ClientBootstrap, ClientCommandAccepted, ClientCommandRequest, ClientEvent, ClientQueryRequest, ClientQueryResponse, ClientTransport, CommandName, QueryName, SubscriptionScope, Unsubscribe } from '@omp-studio/client-contract';

export interface WebSocketLike { send(data: string): void; close(): void; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; }
export interface BrowserWebClientOptions { baseUrl: string; fetcher?: typeof fetch; webSocketFactory?: (url: string) => WebSocketLike; }

/** Browser-side ClientTransport over the loopback HTTP/WebSocket adapter. */
export class BrowserWebClientTransport implements ClientTransport {
  readonly #base: string; readonly #fetch: typeof fetch; readonly #wsFactory?: (url: string) => WebSocketLike; #csrf?: string; #closed=false; readonly #sockets = new Set<WebSocketLike>();
  constructor(options: BrowserWebClientOptions) { this.#base = options.baseUrl.replace(/\/$/, ''); this.#fetch = options.fetcher ?? fetch; if (options.webSocketFactory) this.#wsFactory = options.webSocketFactory; }
  async pair(code: string): Promise<void> { const r = await this.#fetch(this.#base+'/api/v1/pair',{method:'POST',credentials:'include',headers:{'content-type':'application/json','Origin': this.#base},body:JSON.stringify({code})}); if(!r.ok) throw new Error('pair_failed'); const b=await r.json() as {csrf?:string}; if(typeof b.csrf!=='string') throw new Error('pair_failed'); this.#csrf=b.csrf; }
  async bootstrap(): Promise<ClientBootstrap> { return this.req('/api/v1/bootstrap','GET') as Promise<ClientBootstrap>; }
  async query<T extends QueryName>(request: ClientQueryRequest<T>): Promise<ClientQueryResponse<T>> { return this.req('/api/v1/query','POST',request) as Promise<ClientQueryResponse<T>>; }
  async command<T extends CommandName>(request: ClientCommandRequest<T>): Promise<ClientCommandAccepted<T>> { return this.req('/api/v1/command','POST',request) as Promise<ClientCommandAccepted<T>>; }
  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent)=>void): Unsubscribe { if(this.#closed) throw new Error('transport_closed'); if(!this.#wsFactory) throw new Error('websocket_unavailable'); const ws=this.#wsFactory(this.#base.replace(/^http/,'ws')+'/api/v1/events'); this.#sockets.add(ws); ws.onopen=()=>ws.send(JSON.stringify({scope})); ws.onmessage=(e)=>{ try { listener(JSON.parse(e.data)); } catch {} }; ws.onclose=()=>this.#sockets.delete(ws); return ()=>{ this.#sockets.delete(ws); ws.close(); }; }
  async close(): Promise<void> { if(this.#closed)return; this.#closed=true; for(const ws of this.#sockets) ws.close(); this.#sockets.clear(); }
  private async req(path:string, method:string, body?:unknown): Promise<unknown> { if(this.#closed) throw new Error('transport_closed'); const headers: Record<string,string> = {}; const init: RequestInit = {method,credentials:'include',headers}; if(body!==undefined){ headers['content-type']='application/json'; headers['X-Studio-CSRF']=this.#csrf ?? ''; init.body=JSON.stringify(body); } const r=await this.#fetch(this.#base+path,init); if(!r.ok) throw new Error(`http_${r.status}`); return r.json(); }
}
