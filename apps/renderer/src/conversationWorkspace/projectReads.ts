import type { ClientEvent, ConversationTranscriptReadPage, QueryInput, QueryName, QueryResult, SessionId, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { sessionSwitchPerformance } from "../sessionSwitchPerformance";

type ReadClient = Pick<StudioClient, "query" | "subscribe">;
type Entry<T> = { value: T; bytes: number; used: number; expires: number };
const MiB = 1024 * 1024;

/** Display data only. An entry owns no engine, DOM, Runtime state or subscription. */
export class DisplayCache<T> {
  readonly entries = new Map<string, Entry<T>>();
  bytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly maxEntries: number, readonly maxBytes: number, readonly maxEntryBytes = maxBytes) {}
  get(key: string, ttl?: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) { this.delete(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry); entry.used = Date.now();
    if (ttl) { entry.expires = entry.used + ttl; this.#schedule(); }
    return entry.value;
  }
  set(key: string, value: T, ttl: number): void {
    const bytes = JSON.stringify(value).length * 2;
    this.delete(key);
    if (bytes > this.maxEntryBytes) return;
    this.entries.set(key, { value, bytes, used: Date.now(), expires: Date.now() + ttl }); this.bytes += bytes;
    this.prune();
  }
  delete(key: string): void { this.bytes -= this.entries.get(key)?.bytes ?? 0; this.entries.delete(key); }
  clear(): void { this.entries.clear(); this.bytes = 0; clearTimeout(this.#timer); }
  #schedule(): void {
    clearTimeout(this.#timer);
    if (this.entries.size) this.#timer = setTimeout(() => this.prune(), Math.max(1, Math.min(...[...this.entries.values()].map(entry => entry.expires)) - Date.now() + 1));
  }
  prune(): void {
    for (const [key, entry] of this.entries) if (entry.expires <= Date.now()) this.delete(key);
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value!);
    this.#schedule();
  }
}

const targets = new WeakMap<StudioClient, ConnectionReads>();
const bindings = new WeakMap<ReadClient, ProjectReads>();
const bodySignals = new WeakMap<ReadClient, () => void>();
export function bindProjectReads(client: ReadClient, reads: ProjectReads): void { bindings.set(client, reads); }
export function projectReadsFor(client: ReadClient): ProjectReads | undefined { return bindings.get(client); }
export function cachedProjectReads(target: StudioClient, workspaceId: WorkspaceId): ProjectReads | undefined { return targets.get(target)?.projects.get(workspaceId); }
export function bindBodyReady(client: ReadClient, ready: () => void): void { bodySignals.set(client, ready); }
export function conversationBodyReady(client: ReadClient): void { bodySignals.get(client)?.(); }

const metadataTtl: Partial<Record<QueryName, number>> = {
  "models.get": 30_000, "skills.get": 30_000, "projects.list": 5_000,
  "history.list": 3_000, "workspace.fileTree": 3_000, "git.repository.get": 3_000, "git.repository.summary": 3_000,
};
export function isProjectRead(name: QueryName): boolean { return name in metadataTtl; }
export function isAuxiliaryRead(name: QueryName): boolean {
  return isProjectRead(name) || name === "session.telemetry.read" || name === "session.agents.list" || name.startsWith("evaluations.");
}

class ConnectionReads {
  readonly projects = new Map<WorkspaceId, ProjectReads>();
  readonly metadata = new DisplayCache<unknown>(128, 16 * MiB);
  readonly pages = new DisplayCache<ConversationTranscriptReadPage>(4, 8 * MiB, 2 * MiB);
  readonly pending = new Map<string, Promise<unknown>>();
  foreground = 0;
  background: Promise<unknown> = Promise.resolve();
  prefetchSupported = true;
  epoch = 0;
  authorityEpoch: string | undefined;
  #offRoot: (() => void) | undefined;
  #rootTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly target: StudioClient) {}
  retainRoot() {
    clearTimeout(this.#rootTimer);
    this.#offRoot ??= this.target.subscribe({ scope: "all" }, event => { for (const project of this.projects.values()) project.observe(event); });
  }
  releaseRoot() {
    if ([...this.projects.values()].some(project => project.users > 0)) return;
    this.#rootTimer = setTimeout(() => { this.#offRoot?.(); this.#offRoot = undefined; }, 30_000);
  }
  invalidate() { this.epoch++; this.metadata.clear(); this.pages.clear(); this.pending.clear(); }
  trim() {
    this.metadata.prune(); this.pages.prune();
    const inactive = [...this.projects.values()].filter(project => project.users === 0).sort((a, b) => a.used - b.used);
    for (const project of inactive) if (inactive.indexOf(project) < inactive.length - 4 || Date.now() - project.used > 300_000) {
      project.dispose(); this.projects.delete(project.workspaceId);
    }
  }
}

export function acquireProjectReads(target: StudioClient, workspaceId: WorkspaceId): { reads: ProjectReads; release: () => void } {
  let owner = targets.get(target);
  if (!owner) { owner = new ConnectionReads(target); targets.set(target, owner); }
  let reads = owner.projects.get(workspaceId);
  if (!reads) { reads = new ProjectReads(owner, workspaceId); owner.projects.set(workspaceId, reads); }
  reads.retain(); owner.trim();
  return { reads, release: () => reads!.release() };
}

export class ProjectReads {
  users = 0;
  used = Date.now();
  #client: Promise<StudioClient> | undefined;
  #off: (() => void) | undefined;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  #warm: AbortController | undefined;
  #unregister: (() => void) | undefined;
  constructor(readonly owner: ConnectionReads, readonly workspaceId: WorkspaceId) {}
  retain(): void {
    this.users++; this.used = Date.now(); clearTimeout(this.#closeTimer); clearTimeout(this.#expiryTimer);
    this.owner.retainRoot();
    this.#unregister ??= sessionSwitchPerformance.register(() => ({ projectReadConsumers: this.users,
      projectMetadataBytes: this.owner.metadata.bytes, transcriptCacheBytes: this.owner.pages.bytes,
      transcriptCacheEntries: this.owner.pages.entries.size, projectReadFlights: this.owner.pending.size }));
  }
  release(): void {
    this.users--; this.used = Date.now();
    if (this.users) return;
    this.#warm?.abort(); this.#warm = undefined;
    this.owner.releaseRoot();
    this.#closeTimer = setTimeout(() => this.#close(), 30_000);
    this.#expiryTimer = setTimeout(() => this.owner.trim(), 300_001);
    this.owner.trim();
  }
  #close(): void {
    this.#off?.(); this.#off = undefined;
    const client = this.#client; this.#client = undefined;
    if (client) void client.then(value => value.close()).catch(() => {});
    this.#unregister?.(); this.#unregister = undefined;
  }
  dispose(): void {
    clearTimeout(this.#closeTimer); clearTimeout(this.#expiryTimer); this.#warm?.abort(); this.#close();
    this.owner.epoch++;
    for (const key of this.owner.metadata.entries.keys()) if (key.startsWith(`${this.workspaceId}\0`)) this.owner.metadata.delete(key);
    for (const key of this.owner.pages.entries.keys()) if (key.startsWith(`${this.workspaceId}\0`)) this.owner.pages.delete(key);
  }
  async client(): Promise<StudioClient> {
    return this.#client ??= this.owner.target.openContext!({ workspaceId: this.workspaceId }).then(client => {
      this.#off = client.subscribe({ scope: "all" }, event => this.observe(event));
      return client;
    }).catch(error => { this.#client = undefined; throw error; });
  }
  observe(event: ClientEvent): void {
    const authority = String(event.authorityEpoch);
    if (this.owner.authorityEpoch !== undefined && this.owner.authorityEpoch !== authority) this.owner.invalidate();
    this.owner.authorityEpoch = authority;
    if (event.kind === "resync.required") this.owner.invalidate();
    if (event.kind === "git.repository.changed") this.invalidate("git.");
    if (event.kind === "command.receipt" && event.receipt.status === "completed") {
      const name = event.receipt.commandName;
      if (/^(models\.|skills\.|plugins\.|config\.|runtime\.install)/.test(name)) this.owner.metadata.clear();
      if (/^(session\.|timeTravel\.|core\.prompt)/.test(name)) { this.invalidate("history.list"); this.owner.pages.clear(); }
      if (/^(git\.|github\.|workspace\.)/.test(name)) { this.invalidate("git."); this.invalidate("workspace.fileTree"); this.invalidate("projects.list"); }
    }
  }
  invalidate(prefix: string): void {
    this.owner.epoch++;
    for (const key of this.owner.metadata.entries.keys()) if (key.startsWith(`${this.workspaceId}\0${prefix}`)) this.owner.metadata.delete(key);
    for (const key of this.owner.pending.keys()) if (key.startsWith(`${this.workspaceId}\0${prefix}`)) this.owner.pending.delete(key);
  }
  async read<K extends QueryName>(name: K, input: QueryInput<K>, background = false): Promise<QueryResult<K>> {
    const key = `${this.workspaceId}\0${name}\0${JSON.stringify(input)}`, epoch = this.owner.epoch;
    const cached = this.owner.metadata.get(key);
    if (cached !== undefined) { sessionSwitchPerformance.mark("project.cache.hit"); return cached as QueryResult<K>; }
    const pending = this.owner.pending.get(key);
    if (pending) return pending as Promise<QueryResult<K>>;
    if (!background) this.owner.foreground++;
    const task = this.client().then(client => client.query(name, input)).then(result => {
      if (epoch === this.owner.epoch) this.owner.metadata.set(key, result, metadataTtl[name] ?? 3_000);
      return result;
    }).finally(() => {
      if (!background) this.owner.foreground--;
      if (this.owner.pending.get(key) === task) this.owner.pending.delete(key);
    });
    this.owner.pending.set(key, task); return task;
  }
  page(sessionId: SessionId, revision?: string): ConversationTranscriptReadPage | undefined {
    const page = this.owner.pages.get(`${this.workspaceId}\0${sessionId}`, 60_000);
    return page && (!revision || page.transcriptRevision === revision) ? page : undefined;
  }
  savePage(page: ConversationTranscriptReadPage): ConversationTranscriptReadPage {
    const key = `${this.workspaceId}\0${page.sessionId}`, previous = this.owner.pages.get(key);
    if (previous?.transcriptRevision === page.transcriptRevision && previous.headCursor === page.headCursor) {
      this.owner.pages.set(key, previous, 60_000); return previous;
    }
    // Full-page reconciliation only; streaming deltas never stringify/compare rows.
    const byId = new Map(previous?.items.map(item => [item.itemId, item]));
    const shared = { ...page, items: page.items.map(item => {
      const old = byId.get(item.itemId); return old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
    }) };
    this.owner.pages.set(key, shared, 60_000); return shared;
  }
  warm(current?: SessionId): void {
    this.#warm?.abort();
    const controller = new AbortController(); this.#warm = controller;
    const signal = controller.signal;
    let lastInput = performance.now();
    const input = () => { lastInput = performance.now(); };
    for (const name of ["pointerdown", "keydown", "wheel"]) window.addEventListener(name, input, { passive: true, signal });
    const wait = (ms: number) => new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
    });
    const idle = async () => {
      while (!signal.aborted && (this.owner.foreground > 0 || performance.now() - lastInput < 500 || document.visibilityState === "hidden")) await wait(250);
      return !signal.aborted && this.users > 0;
    };
    this.owner.background = this.owner.background.catch(() => {}).then(async () => {
      if (signal.aborted) return;
      await wait(2000);
      for (const name of ["models.get", "skills.get"] as const) { if (!await idle()) return; await this.read(name, {}, true).catch(() => {}); }
      if (!await idle()) return;
      const history = await this.read("history.list", { workspaceId: this.workspaceId, limit: 6, status: "active" }, true);
      if (!await idle()) return;
      await this.read("git.repository.summary", { workspaceId: this.workspaceId }, true).catch(() => {});
      if (!this.owner.prefetchSupported) return;
      let warmed = 0;
      for (const row of history.entries.slice(0, 6)) {
        if (!row.sessionId || row.sessionId === current || warmed === 2) continue;
        if (!await idle()) return;
        if (this.page(row.sessionId)) { warmed++; continue; }
        try {
          const epoch = this.owner.epoch;
          const result = await (await this.client()).query("session.transcript.prefetch", { sessionId: row.sessionId });
          if (signal.aborted || epoch !== this.owner.epoch) return;
          if (result.status === "ready") { this.savePage(result.page); warmed++; }
        } catch (error) {
          if (["INVALID_ARGUMENT", "CAPABILITY_UNAVAILABLE"].includes((error as { code?: string }).code ?? "")) { this.owner.prefetchSupported = false; return; }
        }
      }
    }).catch(() => {}).finally(() => controller.abort());
  }
}
