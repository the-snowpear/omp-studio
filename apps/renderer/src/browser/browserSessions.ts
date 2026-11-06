import { useSyncExternalStore } from "react";
import type { BrowserElementReference, ManagedBrowserCommand, ManagedBrowserEvent, ManagedBrowserState } from "@omp-studio/studio-protocol";
import { createPreviewBrowserBackend } from "../preview/managedBrowserPreview";

type WithoutSession<Command> = Command extends { sessionId: string } ? Omit<Command, "sessionId"> : never;
export type BrowserAction = WithoutSession<ManagedBrowserCommand>;
/** The desktop API or the preview twin; `present` stays with each pane's own window. */
export interface BrowserBackend {
  read(sessionId: string): Promise<ManagedBrowserState>;
  execute(command: ManagedBrowserCommand): Promise<ManagedBrowserState>;
  subscribe(listener: (event: ManagedBrowserEvent) => void): () => void;
}

export interface BrowserSessionSnapshot {
  state: ManagedBrowserState | null;
  error: string;
  readFailed: boolean;
  /** The side a take / return started here is handing control to, while it runs. */
  controlPending: "human" | "agent" | null;
  /** Pages whose close (with its control handoff) is still running. */
  closing: readonly string[];
  /** Page-level actions in flight, by page id ("" for chat-wide ones). */
  busy: readonly string[];
  /** The page in element-picking mode. */
  picking: string | null;
  references: readonly BrowserElementReference[];
  /** A link that could not open directly; the start page offers to take control and open it. */
  pendingLink: { id: string; url: string } | null;
  /** Ctrl+L / Ctrl+F pressed inside a native page; only that page's pane reacts. */
  shortcut: { id: number; pageId: string; action: "address" | "find" } | null;
  newTabSpaceId: string;
}

const EMPTY: BrowserSessionSnapshot = { state: null, error: "", readFailed: false, controlPending: null, closing: [], busy: [], picking: null, references: [], pendingLink: null, shortcut: null, newTabSpaceId: "shared" };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
let shortcuts = 0;

/** One chat's browser as every pane, tab and the dock sync see it; survives panes unmounting. */
export class BrowserSession {
  #snapshot = EMPTY;
  #listeners = new Set<() => void>();
  #version = 0;
  #reading = false;
  constructor(readonly id: string, private readonly backend: BrowserBackend) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (!this.#snapshot.state && !this.#reading) void this.read();
    return () => { this.#listeners.delete(listener); };
  };
  getSnapshot = (): BrowserSessionSnapshot => this.#snapshot;
  #set(patch: Partial<BrowserSessionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  async read(): Promise<void> {
    const version = this.#version;
    this.#reading = true;
    try {
      const state = await this.backend.read(this.id);
      // A state event that arrived meanwhile is newer than this read.
      if (version === this.#version) this.#set({ state, readFailed: false });
    } catch (cause) { this.#set({ error: message(cause), readFailed: true }); }
    finally { this.#reading = false; }
  }
  receive(event: ManagedBrowserEvent): void {
    if (event.kind === "state") { this.#version++; this.#set({ state: event.state }); return; }
    if (event.kind === "error") this.#set({ error: event.message });
    else if (event.kind === "picker") this.#set({ picking: event.active ? event.pageId : this.#snapshot.picking === event.pageId ? null : this.#snapshot.picking });
    else if (event.kind === "shortcut") this.#set({ shortcut: { id: ++shortcuts, pageId: event.pageId, action: event.action } });
    else if (event.kind === "selection") this.addReference(event.reference);
  }
  /** Same-key actions do not stack (a double click reloads once); other pages stay usable. */
  async execute(action: BrowserAction): Promise<ManagedBrowserState | null> {
    const key = "pageId" in action ? action.pageId : "";
    if (this.#snapshot.busy.includes(key)) return null;
    const version = this.#version;
    this.#set({ busy: [...this.#snapshot.busy, key], error: "" });
    try {
      const state = await this.backend.execute({ ...action, sessionId: this.id } as ManagedBrowserCommand);
      if (version === this.#version) this.#set({ state });
      return state;
    } catch (cause) { this.#set({ error: message(cause) }); return null; }
    finally { this.#set({ busy: this.#snapshot.busy.filter(item => item !== key) }); }
  }
  async setControl(control: "human" | "agent"): Promise<boolean> {
    if (this.#snapshot.controlPending) return false;
    if (this.#snapshot.state?.control === control) return true;
    this.#set({ controlPending: control });
    try { return !!await this.execute({ action: control === "human" ? "take" : "return" }); }
    finally { this.#set({ controlPending: null }); }
  }
  /** Closes from any control state: the desktop waits out the Agent's step and hands control back. */
  async closePage(pageId: string): Promise<boolean> {
    if (this.#snapshot.closing.includes(pageId)) return false;
    this.#set({ closing: [...this.#snapshot.closing, pageId], error: "" });
    try {
      await this.backend.execute({ action: "close-handoff", pageId, sessionId: this.id });
      return true;
    } catch (cause) { this.#set({ error: message(cause) }); return false; }
    finally { this.#set({ closing: this.#snapshot.closing.filter(item => item !== pageId) }); }
  }
  /** Tab focus is never dropped behind a busy page action: it goes straight to the desktop. */
  async select(pageId: string): Promise<void> {
    try { await this.backend.execute({ action: "select", pageId, sessionId: this.id }); }
    catch (cause) { this.#set({ error: message(cause) }); }
  }
  create(url: string, options: { openerPageId?: string | undefined; spaceId?: string | undefined } = {}): Promise<ManagedBrowserState | null> {
    return this.execute({ action: "create", url, spaceId: options.spaceId ?? this.#snapshot.newTabSpaceId, ...(options.openerPageId ? { openerPageId: options.openerPageId } : {}) });
  }
  async startPicking(pageId: string): Promise<void> {
    if (this.#snapshot.picking && this.#snapshot.picking !== pageId) await this.stopPicking();
    await this.execute({ action: "pick", pageId });
  }
  async stopPicking(): Promise<void> {
    await this.execute({ action: "stop-picking" });
    this.#set({ picking: null });
  }
  addReference(reference: BrowserElementReference): void {
    if (!this.#snapshot.references.some(value => value.id === reference.id)) this.#set({ references: [...this.#snapshot.references, reference] });
  }
  updateNote(id: string, note: string): void { this.#set({ references: this.#snapshot.references.map(value => value.id === id ? { ...value, note } : value) }); }
  removeReference(id: string): void { this.#set({ references: this.#snapshot.references.filter(value => value.id !== id) }); }
  clearReferences(pageId: string): void { this.#set({ references: this.#snapshot.references.filter(value => value.pageId !== pageId) }); }
  takeReferences(pageId: string): BrowserElementReference[] {
    const taken = this.#snapshot.references.filter(value => value.pageId === pageId);
    this.clearReferences(pageId);
    return taken;
  }
  setPendingLink(link: { id: string; url: string } | null): void { this.#set({ pendingLink: link }); }
  dismissError(): void { this.#set({ error: "" }); }
  reportError(error: string): void { this.#set({ error }); }
  setNewTabSpace(spaceId: string): void { this.#set({ newTabSpaceId: spaceId }); }
}

/** One subscription per backend; events fan out to the chat they name. */
export class BrowserHub {
  readonly #sessions = new Map<string, BrowserSession>();
  #unsubscribe: (() => void) | undefined;
  constructor(readonly backend: BrowserBackend) {}
  session(id: string): BrowserSession {
    this.#unsubscribe ??= this.backend.subscribe(event => this.#sessions.get(event.kind === "state" ? event.state.sessionId : event.sessionId)?.receive(event));
    let session = this.#sessions.get(id);
    if (!session) this.#sessions.set(id, session = new BrowserSession(id, this.backend));
    return session;
  }
}

const hubs = new WeakMap<object, BrowserHub>();
let previewBackend: BrowserBackend | undefined;
/** Real panes share the desktop API's hub; preview panes share one in-memory demo browser. */
export function browserHub(preview: boolean, api = globalThis.ompStudioChrome?.managedBrowser): BrowserHub | null {
  const backend = preview ? previewBackend ??= createPreviewBrowserBackend() : api;
  if (!backend) return null;
  let hub = hubs.get(backend);
  if (!hub) hubs.set(backend, hub = new BrowserHub(backend));
  return hub;
}

const noSubscribe = () => () => {};
const empty = () => EMPTY;
export function useBrowserSession(session: BrowserSession | null): BrowserSessionSnapshot {
  return useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getSnapshot ?? empty);
}
