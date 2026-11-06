import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedBrowserConnection, ManagedBrowserControl, ManagedBrowserDownload, ManagedBrowserPage, ManagedBrowserPageOpener, ManagedBrowserPermission, ManagedBrowserSettings, ManagedBrowserSpace, ManagedBrowserState } from "@omp-studio/studio-protocol";

interface BrowserSession {
  pages: ManagedBrowserPage[];
  activePageId: string | null;
  control: ManagedBrowserControl | undefined;
  connection: ManagedBrowserConnection;
  downloads: ManagedBrowserDownload[];
}
interface StoredBrowser {
  spaces: ManagedBrowserSpace[];
  settings: ManagedBrowserSettings;
  permissions: ManagedBrowserPermission[];
  sessions: { sessionId: string; pages: Pick<ManagedBrowserPage, "id" | "sessionId" | "spaceId" | "title" | "url" | "zoom" | "favicon">[]; activePageId: string | null; control?: ManagedBrowserControl | undefined }[];
}

export class ManagedBrowserStore {
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #file: string;
  #spaces: ManagedBrowserSpace[] = [{ id: "shared", name: "Shared" }];
  #settings: ManagedBrowserSettings;
  #permissions: ManagedBrowserPermission[] = [];
  #writes: Promise<void> = Promise.resolve();
  #writeQueued = false;
  #dirty = false;

  constructor(readonly options: { directory: string; downloadsDirectory: string; changed?: (sessionId: string) => void }) {
    this.#file = join(options.directory, "browser.json");
    this.#settings = { maxTabs: 16, downloadDirectory: options.downloadsDirectory, askDownloadLocation: false };
  }
  async load(): Promise<void> {
    let text: string;
    try { text = await readFile(this.#file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const stored = JSON.parse(text) as StoredBrowser;
    this.#spaces = stored.spaces;
    this.#settings = stored.settings;
    this.#permissions = stored.permissions;
    this.#sessions.clear();
    for (const session of stored.sessions) this.#sessions.set(session.sessionId, {
      pages: session.pages.map(page => ({ ...page, status: "released", canGoBack: false, canGoForward: false, devtools: false })),
      activePageId: session.activePageId, control: session.control === "waiting" ? "human" : session.control,
      connection: "disconnected", downloads: [],
    });
  }
  state(sessionId: string): ManagedBrowserState {
    const session = this.#sessions.get(sessionId);
    return { sessionId, pages: [...(session?.pages ?? [])], activePageId: session?.activePageId ?? null, spaces: [...this.#spaces], control: session?.control ?? "human", connection: session?.connection ?? "disconnected", settings: { ...this.#settings }, downloads: [...(session?.downloads ?? [])], permissions: [...this.#permissions] };
  }
  initialControl(sessionId: string): ManagedBrowserControl | undefined { return this.#sessions.get(sessionId)?.control; }
  create(sessionId: string, url: string, source: "human" | "agent", spaceId = "shared", opener: Omit<ManagedBrowserPageOpener, "source"> = {}): ManagedBrowserPage {
    const session = this.#session(sessionId);
    if (session.pages.length >= this.#settings.maxTabs) throw new Error(`Browser tab limit (${this.#settings.maxTabs}) reached. Close a tab or raise the limit in browser settings.`);
    const page: ManagedBrowserPage = { id: randomUUID(), sessionId, spaceId, title: url, url, status: "released", canGoBack: false, canGoForward: false, zoom: 1, devtools: false, opener: { source, ...opener } };
    session.control ??= source;
    session.pages.push(page);
    session.activePageId = page.id;
    this.#changed(sessionId);
    return page;
  }
  update(pageId: string, patch: Partial<ManagedBrowserPage>): void {
    const page = this.page(pageId);
    if (!page) return;
    const savedFields = ["id", "sessionId", "spaceId", "title", "url", "zoom", "favicon"] as const;
    const persist = savedFields.some(key => key in patch && patch[key] !== page[key]);
    Object.assign(page, patch);
    if (persist) this.#queueWrite();
    this.options.changed?.(page.sessionId);
  }
  page(pageId: string): ManagedBrowserPage | undefined {
    for (const session of this.#sessions.values()) { const page = session.pages.find(candidate => candidate.id === pageId); if (page) return page; }
    return undefined;
  }
  select(sessionId: string, pageId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session?.pages.some(page => page.id === pageId)) return;
    session.activePageId = pageId;
    this.#changed(sessionId);
  }
  close(sessionId: string, pageId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    const index = session.pages.findIndex(page => page.id === pageId);
    if (index < 0) return;
    session.pages.splice(index, 1);
    if (session.activePageId === pageId) session.activePageId = (session.pages[index] ?? session.pages[index - 1])?.id ?? null;
    this.#changed(sessionId);
  }
  release(sessionId: string): void {
    for (const page of this.#sessions.get(sessionId)?.pages ?? []) {
      page.status = "released"; page.canGoBack = false; page.canGoForward = false; page.devtools = false; delete page.error;
    }
    this.options.changed?.(sessionId);
  }
  control(sessionId: string, control: ManagedBrowserControl): void { this.#session(sessionId).control = control; this.#changed(sessionId); }
  connection(sessionId: string, connection: ManagedBrowserConnection): void { this.#session(sessionId).connection = connection; this.options.changed?.(sessionId); }
  addSpace(name: string): ManagedBrowserSpace { const space = { id: randomUUID(), name }; this.#spaces.push(space); this.#changedAll(); return space; }
  settings(patch: Partial<ManagedBrowserSettings>): void { Object.assign(this.#settings, patch); this.#changedAll(); }
  permissionFor(spaceId: string, origin: string, permission: string): ManagedBrowserPermission | undefined { return this.#permissions.find(entry => entry.spaceId === spaceId && entry.origin === origin && entry.permission === permission); }
  permission(value: ManagedBrowserPermission): void {
    const index = this.#permissions.findIndex(entry => entry.spaceId === value.spaceId && entry.origin === value.origin && entry.permission === value.permission);
    if (index < 0) this.#permissions.push({ ...value }); else this.#permissions[index] = { ...value };
    this.#changedAll();
  }
  forgetPermission(spaceId: string, origin: string, permission: string): void {
    this.#permissions = this.#permissions.filter(entry => entry.spaceId !== spaceId || entry.origin !== origin || entry.permission !== permission);
    this.#changedAll();
  }
  download(sessionId: string, value: ManagedBrowserDownload): void {
    const session = this.#session(sessionId);
    const existing = session.downloads.find(download => download.id === value.id);
    if (existing) Object.assign(existing, value); else session.downloads.push({ ...value });
    this.options.changed?.(sessionId);
  }
  async flush(): Promise<void> {
    let pending: Promise<void>;
    do { pending = this.#writes; await pending; } while (pending !== this.#writes);
  }
  #session(sessionId: string): BrowserSession {
    let session = this.#sessions.get(sessionId);
    if (!session) { session = { pages: [], activePageId: null, control: undefined, connection: "disconnected", downloads: [] }; this.#sessions.set(sessionId, session); }
    return session;
  }
  #changed(sessionId: string): void { this.#queueWrite(); this.options.changed?.(sessionId); }
  #changedAll(): void { this.#queueWrite(); for (const sessionId of this.#sessions.keys()) this.options.changed?.(sessionId); }
  #queueWrite(): void {
    this.#dirty = true;
    if (this.#writeQueued) return;
    this.#writeQueued = true;
    const write = async () => {
      try { while (this.#dirty) { this.#dirty = false; await this.#persist(); } }
      finally { this.#writeQueued = false; }
    };
    this.#writes = this.#writes.then(write, write);
    void this.#writes.catch(() => undefined);
  }
  async #persist(): Promise<void> {
    const stored: StoredBrowser = {
      spaces: this.#spaces, settings: this.#settings, permissions: this.#permissions,
      sessions: Array.from(this.#sessions, ([sessionId, session]) => ({ sessionId, pages: session.pages.map(({ id, sessionId, spaceId, title, url, zoom, favicon }) => ({ id, sessionId, spaceId, title, url, zoom, ...(favicon ? { favicon } : {}) })), activePageId: session.activePageId, control: session.control })),
    };
    const text = JSON.stringify(stored, null, 2) + "\n";
    await mkdir(this.options.directory, { recursive: true });
    await writeFile(this.#file + ".tmp", text, "utf8");
    await rename(this.#file + ".tmp", this.#file);
  }
}
