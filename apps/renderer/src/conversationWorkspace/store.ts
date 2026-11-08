import { conversationKey, conversationVisible, type ConversationDocument, type ConversationRef, type ConversationView, type ConversationWorkspaceLayout, type Rect } from "./model";
import { conversationPanelId, type DockPinMode, type DockTarget } from "../dock/types";
import type { SessionHistoryEntry, WorkspaceListReadModel } from "@omp-studio/client-contract";
import { ProjectHistoryStore } from "../sidebar/useProjectHistories";
import { WorkbenchWindows, type WindowLayout, type WorkbenchWindow } from "../dock/windows";
import { clampFloat } from "../dock/model";
import { DocumentHosts } from "./hosts";
import { snapTree, WINDOW_MINIMUM, type SnapRatios, type SnapNode, type SnapTemplate, type WindowSnapLayout } from "../dock/snap";

export type ConversationAction = { id: string; kind: "rename" | "fork" | "handoff" | "compact" | "export" | "archive" | "delete"; entry: SessionHistoryEntry; workspaceId: string };
export const WORKSPACE_STORAGE_KEY = "omp.conversation-workspace.v1";
type WorkspaceMetadata = Omit<ConversationWorkspaceLayout, "views" | "snap" | "snapAssistCell">;
const initial = (): WorkspaceMetadata => ({ version: 4, coordinateVersion: 1, documents: [], activeViewId: null, activeDocumentId: null, sidebarWidth: 272, sidebarVisible: true, panelWidth: 480, bottomHeight: 240, railCollapsed: false });
const asView = (record: WorkbenchWindow): ConversationView => ({ id: record.id, documentId: record.content.documentId, placement: record.placement, rect: record.rect, minimized: record.minimized, maximized: record.maximized, pin: record.pin, ...(record.nativeRect ? { nativeRect: record.nativeRect } : {}), restoreSnap: record.restoreSnap });

export class ConversationWorkspaceStore {
  readonly manager = new WorkbenchWindows();
  readonly windows = this.manager.focus;
  readonly hosts = new DocumentHosts();
  private catalogs = new Map<string | null, WorkspaceListReadModel>();
  private histories = new Map<string | null, ProjectHistoryStore>();
  catalog(target: string | null) { return this.catalogs.get(target); }
  rememberCatalog(target: string | null, value: WorkspaceListReadModel) { this.catalogs.set(target, value); }
  history(target: string | null) { let value = this.histories.get(target); if (!value) { value = new ProjectHistoryStore(); this.histories.set(target, value); } return value; }
  cancelDrag?: (() => void) | undefined;
  private legacyCoordinates = false;
  get geometry() { return this.manager.geometry; }
  private actions = new Map<string, ConversationAction>();
  private pendingDock = new Map<string, DockTarget>();
  private metadata = initial();
  private state: ConversationWorkspaceLayout;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly demo: boolean;

  constructor(private storage: Pick<Storage, "getItem" | "setItem"> | null, demo = false, private persistenceEnabled = true) {
    this.demo = demo;
    if (!demo) {
      try {
        const saved = JSON.parse(storage?.getItem(WORKSPACE_STORAGE_KEY) ?? "null") as (ConversationWorkspaceLayout & { windowLayout?: WindowLayout; focus?: ReturnType<WorkbenchWindows["focus"]["checkpoint"]> }) | null;
        if (saved && Array.isArray(saved.documents)) {
          const { views, snap, snapAssistCell, windowLayout, focus, ...metadata } = saved;
          this.metadata = { ...initial(), ...metadata, version: 4, coordinateVersion: 1 };
          this.legacyCoordinates = saved.coordinateVersion !== 1;
          if (windowLayout) this.manager.restore({ ...windowLayout, assist: null });
          else {
            let main = false;
            const records: WorkbenchWindow[] = (views ?? []).map(view => {
              const embedded = view.placement === "main" || (view.placement as string) === "tile";
              const placement = embedded && !main ? "main" : view.placement === "native" ? "native" : "float";
              if (placement === "main") main = true;
              return { ...view, placement, content: { kind: "conversation", documentId: view.documentId }, minimum: WINDOW_MINIMUM, title: saved.documents.find(doc => doc.id === view.documentId)?.title ?? "新对话", pin: view.pin ?? (placement === "native" ? "window" : "none") };
            });
            const legacySnap = snap as (WindowSnapLayout & { ratios?: SnapRatios }) | null;
            this.manager.restore({ records, assist: null, snap: legacySnap ? { template: legacySnap.template, members: legacySnap.members, tree: legacySnap.tree ?? snapTree(legacySnap.template, legacySnap.ratios) } : null });
          }
          if (focus) this.windows.restoreCheckpoint(focus);
        }
      } catch {}
    }
    this.state = this.snapshot();
    this.manager.visible = record => conversationVisible({ ...asView(record), documentId: record.content.documentId }, this.state);
    this.windows.resolveOwner = (id, ownerId) => {
      const record = this.manager.get(id);
      if (record?.content.kind !== "tools") return ownerId;
      const { documentId, groupId } = record.content;
      const layout = this.hosts.get(documentId).tools?.store.getSnapshot().layout;
      const group = layout?.floats.find(group => group.id === groupId);
      const file = group ? layout?.fileViews[group.active] : undefined;
      const active = this.metadata.documents.find(document => document.id === this.metadata.activeDocumentId);
      if (file && (file.scope === "workspace" || group?.pin?.mode === "workspace") && active?.ref.workspaceId === file.workspaceId && (active.ref.targetId ?? null) === file.targetId) return active.id;
      return ownerId;
    };
    this.manager.subscribe(() => this.publish());
    this.windows.subscribe(() => {
      const activeDocumentId = this.windows.getSnapshot().ownerId;
      if (!activeDocumentId) return;
      const activeViewId = this.state.views.find(view => view.documentId === activeDocumentId)?.id ?? null;
      if (activeDocumentId !== this.metadata.activeDocumentId || activeViewId !== this.metadata.activeViewId) {
        this.metadata = { ...this.metadata, activeDocumentId, activeViewId };
        this.publish();
      }
    });
    if (!this.manager.getSnapshot().records.length) this.open({ targetId: null, draftId: "initial" }, "current");
    else if (!this.windows.getSnapshot().activeId && this.state.activeViewId) this.activate(this.state.activeViewId);
  }
  private snapshot(): ConversationWorkspaceLayout {
    const layout = this.manager.getSnapshot();
    return { ...this.metadata, views: layout.records.filter(record => record.content.kind === "conversation").map(asView), snap: layout.snap, snapAssistCell: layout.assist };
  }
  getSnapshot = () => this.state;
  enablePersistence() { this.persistenceEnabled = true; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(save = true) {
    this.state = this.snapshot();
    for (const listener of this.listeners) listener();
    if (!save || this.demo || !this.persistenceEnabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  flush = () => {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.demo || !this.persistenceEnabled) return;
    const windowLayout = this.manager.getSnapshot();
    const open = new Set(windowLayout.records.map(record => record.content.documentId));
    const documents = this.metadata.documents.filter(doc => open.has(doc.id)).map(({ page, pagePhase, ...doc }) => doc.ref.sessionId || doc.ref.historyId ? doc : { ...doc, title: "新对话" });
    const records = windowLayout.records.map(record => record.content.kind === "conversation" ? { ...record, title: documents.find(doc => doc.id === record.content.documentId)!.title } : record);
    const state = { ...this.metadata, documents, windowLayout: { ...windowLayout, records, assist: null }, focus: this.windows.checkpoint() };
    try { this.storage?.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state)); } catch {}
  };
  documentFor(viewId: string | null): ConversationDocument | undefined {
    return this.state.documents.find(doc => doc.id === this.manager.get(viewId ?? "")?.content.documentId);
  }
  viewFor(ref: ConversationRef) {
    const record = this.state.documents.find(doc => conversationKey(doc.ref) === conversationKey(ref));
    return this.state.views.find(view => view.documentId === record?.id);
  }
  actionFor(id: string) { return this.actions.get(id); }
  takeAction(id: string) { const value = this.actions.get(id); this.actions.delete(id); return value; }
  requestAction(ref: ConversationRef, entry: SessionHistoryEntry, kind: ConversationAction["kind"]) {
    const viewId = this.open(ref), document = this.documentFor(viewId)!;
    this.actions.set(document.id, { id: crypto.randomUUID(), kind, entry, workspaceId: ref.workspaceId! });
    this.publish(false);
  }
  setGeometry(workbench: Rect, canvas: Rect) {
    const changed = JSON.stringify(this.geometry) !== JSON.stringify({ workbench, canvas });
    this.manager.geometry = { workbench, canvas };
    if (this.legacyCoordinates && canvas.width && canvas.height) {
      this.legacyCoordinates = false;
      this.manager.transaction(() => { for (const record of this.manager.getSnapshot().records) {
        const rect = clampFloat(record.rect, { width: canvas.width, height: canvas.height }, 280);
        this.manager.patch(record.id, { rect: { ...rect, x: rect.x + canvas.x - workbench.x, y: rect.y + canvas.y - workbench.y } });
      } });
    } else if (changed) this.publish(false);
  }
  activate(id: string) {
    const record = this.manager.get(id);
    if (record?.placement === "docked") this.hosts.get(record.content.documentId).tools?.store.dispatch({ type: "open", panel: conversationPanelId(id) });
    this.manager.activate(id);
  }
  dockPanel(id: string, target: DockTarget) {
    const record = this.manager.get(id);
    if (!record) return;
    const tools = this.hosts.get(record.content.documentId).tools;
    if (!tools) { this.pendingDock.set(id, target); return; }
    tools.store.dispatch({ type: "move", panels: [conversationPanelId(id)], target });
    if (target.region === "left") this.shared({ sidebarVisible: true });
    if (target.region === "bottom" && this.state.bottomHeight < 360) this.shared({ bottomHeight: 360 });
    this.manager.activate(id);
  }
  attachPendingDock(documentId: string) {
    const view = this.state.views.find(view => view.documentId === documentId);
    const target = view && this.pendingDock.get(view.id);
    if (!view || !target) return;
    this.pendingDock.delete(view.id);
    this.dockPanel(view.id, target);
  }
  focus(id: string) { this.activate(id); globalThis.window?.dispatchEvent(new CustomEvent("omp:conversation-focus", { detail: id })); }
  isWindowed() { return this.manager.getSnapshot().records.some(record => record.placement !== "main"); }
  /** The main area holds no conversation: every conversation is in a window. Tool windows do not count. */
  allWindowed = () => this.state.views.length > 0 && !this.state.views.some(view => view.placement === "main");
  /** Conversation views, most recently focused first. */
  recentViews() {
    const recent = this.windows.recentIds();
    const rank = (view: ConversationView) => { const index = recent.indexOf(`conversation:${view.id}`); return index < 0 ? recent.length : index; };
    return [...this.state.views].sort((first, second) => rank(first) - rank(second));
  }
  /** A new draft window that keeps the owner's project and connection (the active conversation by default). */
  openNewWindow(owner = this.state.documents.find(doc => doc.id === this.state.activeDocumentId)) {
    return this.open({ targetId: owner?.ref.targetId ?? null, workspaceId: owner?.ref.workspaceId, previewProjectId: owner?.ref.previewProjectId, draftId: crypto.randomUUID() }, "float", this.nextWindowRect());
  }
  nextWindowRect(size = { width: 720, height: 620 }): Rect {
    const { canvas, workbench } = this.geometry;
    const width = Math.min(size.width, canvas.width), height = Math.min(size.height, canvas.height);
    const count = this.manager.getSnapshot().records.filter(record => record.placement === "float" && !record.minimized).length;
    const offset = count % 5 * 24;
    return clampFloat({ x: canvas.x - workbench.x + (canvas.width - width) / 2 + offset, y: canvas.y - workbench.y + Math.min(64, (canvas.height - height) / 2) + offset, width, height }, { width: workbench.width, height: workbench.height }, 280);
  }
  openFromDirectory(ref: ConversationRef): string {
    const existing = this.viewFor(ref);
    if (existing) { this.focus(existing.id); return existing.id; }
    return this.isWindowed() ? this.open(ref, "float", this.nextWindowRect()) : this.open(ref);
  }
  open(ref: ConversationRef, placement: "current" | "float" = "current", rect?: Rect): string {
    if (this.demo && ref.draftId && ref.draftId !== "initial") ref = { ...ref, previewThreadId: "t0", previewProjectId: ref.workspaceId ?? this.documentFor(this.state.activeViewId)?.ref.previewProjectId };
    const key = conversationKey(ref);
    const document = this.state.documents.find(doc => conversationKey(doc.ref) === key) ?? { id: crypto.randomUUID(), ref, title: "新对话" };
    const existing = this.state.views.find(view => view.documentId === document.id);
    if (existing) { if (placement === "float" && existing.placement === "main") this.float(existing.id, rect); this.focus(existing.id); return existing.id; }
    if (!this.metadata.documents.includes(document)) this.metadata = { ...this.metadata, documents: [...this.metadata.documents, document] };
    // A minimized view is not "current": reusing it would swap out a conversation the user only put away.
    const current = this.state.views.find(view => view.id === this.state.activeViewId && !view.minimized);
    if (placement === "current" && current) {
      this.manager.patch(current.id, { content: { kind: "conversation", documentId: document.id }, title: document.title, minimized: false });
      this.activate(current.id);
      return current.id;
    }
    const id = crypto.randomUUID();
    this.manager.register({ id, content: { kind: "conversation", documentId: document.id }, title: document.title, placement: placement === "float" ? "float" : "main", pin: "none", minimum: WINDOW_MINIMUM, rect: rect ?? { x: 40, y: 40, width: 640, height: 560 }, minimized: false, maximized: false });
    this.activate(id);
    return id;
  }
  updateDocument(id: string, patch: Partial<Pick<ConversationDocument, "ref" | "title" | "projectName" | "page" | "pagePhase">>) {
    const current = this.metadata.documents.find(doc => doc.id === id);
    if (!current || JSON.stringify({ ...current, ...patch }) === JSON.stringify(current)) return;
    this.metadata = { ...this.metadata, documents: this.metadata.documents.map(doc => doc.id === id ? { ...doc, ...patch } : doc) };
    const view = this.state.views.find(view => view.documentId === id);
    if (view && patch.title) this.manager.patch(view.id, { title: patch.title });
    this.publish();
  }
  close(id: string) {
    this.pendingDock.delete(id);
    const record = this.manager.get(id);
    if (record) this.hosts.get(record.content.documentId).tools?.store.removeConversationPanel(id);
    this.manager.remove(id); this.settleActive();
  }
  /** Nothing visible is left: minimized conversations stay (and keep the shared chrome); only an empty workspace starts a new conversation. */
  private settleActive() {
    if (this.windows.getSnapshot().activeId || this.manager.getSnapshot().records.some(record => !record.minimized)) return;
    const next = this.recentViews()[0];
    if (!next) { this.open({ targetId: null, draftId: crypto.randomUUID() }); return; }
    if (next.documentId === this.metadata.activeDocumentId && next.id === this.metadata.activeViewId) return;
    this.metadata = { ...this.metadata, activeDocumentId: next.documentId, activeViewId: next.id };
    this.publish();
  }
  float(id: string, rect?: Rect, native = false) {
    const record = this.manager.get(id);
    if (record?.placement === "docked") this.hosts.get(record.content.documentId).tools?.store.removeConversationPanel(id);
    this.manager.transaction(() => { this.manager.float(id, rect, native); this.manager.patch(id, { pin: native ? "window" : record?.pin === "window" || record?.pin === "topmost" ? "none" : record?.pin ?? "none" }); });
    this.activate(id);
  }
  dock(id: string) {
    const record = this.manager.get(id);
    if (record?.placement === "docked") this.hosts.get(record.content.documentId).tools?.store.removeConversationPanel(id);
    this.manager.transaction(() => {
      for (const record of this.manager.getSnapshot().records) if (record.placement === "main" && record.id !== id) this.manager.remove(record.id);
      this.manager.float(id);
      this.manager.patch(id, { placement: "main", pin: "none" });
    });
    this.activate(id);
  }
  setPin(id: string, pin: DockPinMode) {
    this.manager.setPin(id, pin);
  }
  setWindow(id: string, patch: Partial<Pick<ConversationView, "rect" | "nativeRect" | "minimized" | "maximized">>) {
    this.manager.transaction(() => {
      if (patch.rect) this.manager.float(id, patch.rect);
      if (patch.minimized) this.manager.minimize(id);
      else if (patch.minimized === false) this.manager.activate(id);
      this.manager.patch(id, { ...(patch.nativeRect ? { nativeRect: patch.nativeRect } : {}), ...(patch.maximized !== undefined ? { maximized: patch.maximized } : {}) });
    });
    if (patch.minimized) this.settleActive();
  }
  snapCell(id: string) { return this.manager.cell(id); }
  snapView(id: string, template: SnapTemplate, cell: number) { this.manager.snap(id, { template, cell }); }
  resizeSnap(geometry: SnapRatios | SnapNode) { const snap = this.manager.getSnapshot().snap; if (snap) this.manager.resize("columns" in geometry ? snapTree(snap.template, geometry) : geometry); }
  dismissSnapAssist() { this.manager.dismissAssist(); }
  shared(patch: Partial<Pick<ConversationWorkspaceLayout, "sidebarWidth" | "sidebarVisible" | "panelWidth" | "bottomHeight" | "railCollapsed">>) {
    if (Object.entries(patch).every(([key, value]) => this.metadata[key as keyof WorkspaceMetadata] === value)) return;
    this.metadata = { ...this.metadata, ...patch }; this.publish();
  }
}
