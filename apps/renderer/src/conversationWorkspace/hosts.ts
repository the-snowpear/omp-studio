import type { SessionTitleRow } from "@omp-studio/studio-protocol";
import type { PanelHosts } from "../dock/hosts";
import type { DockStore } from "../dock/store";
import type { PanelDefinition } from "../dock/types";

type Part = "element" | "title" | "actions";
export type ConversationHost = {
  element: HTMLDivElement; title: HTMLDivElement; actions: HTMLDivElement;
  surface: Document; listeners: Set<() => void>;
  tools?: { hosts: PanelHosts; store: DockStore };
};
export type ConversationHostSlots = Record<Part, HTMLElement>;
/** What a conversation's tab shows. The conversation publishes it; it is never persisted. */
export type ConversationTabInfo = { title: string; titleRow: SessionTitleRow | undefined; status: { tone: "running" | "waiting" | "error"; label: string } | undefined };
/** What a tool window's tab shows, published by the dock that owns the window. */
export type ToolTabInfo = { windowId: string; title: string; mark: PanelDefinition; count: number; closeTip: string; focus: () => void; close: () => void };

export class DocumentHosts {
  private hosts = new Map<string, ConversationHost>();
  private slots = new Map<string, Partial<ConversationHostSlots>>();
  private previews = new Map<string, Partial<ConversationHostSlots>>();
  private tabs = new Map<string, ConversationTabInfo>();
  private toolTabs = new Map<string, readonly ToolTabInfo[]>();
  private tabListeners = new Set<() => void>();
  private tabRevision = 0;
  tab(id: string) { return this.tabs.get(id); }
  setTab(id: string, info: ConversationTabInfo) {
    if (JSON.stringify(this.tabs.get(id)) === JSON.stringify(info)) return;
    this.tabs.set(id, info); this.notifyTabs();
  }
  toolTab(windowId: string) {
    for (const tabs of this.toolTabs.values()) { const tab = tabs.find(item => item.windowId === windowId); if (tab) return tab; }
    return undefined;
  }
  /** Listeners hear about visible changes only; the stored callbacks are always the latest. */
  setToolTabs(documentId: string, tabs: readonly ToolTabInfo[]) {
    const changed = JSON.stringify(this.toolTabs.get(documentId) ?? []) !== JSON.stringify(tabs);
    if (tabs.length) this.toolTabs.set(documentId, tabs); else this.toolTabs.delete(documentId);
    if (changed) this.notifyTabs();
  }
  private notifyTabs() {
    this.tabRevision++;
    for (const listener of this.tabListeners) listener();
  }
  subscribeTabs = (listener: () => void) => { this.tabListeners.add(listener); return () => { this.tabListeners.delete(listener); }; };
  tabsRevision = () => this.tabRevision;
  get(id: string) {
    let host = this.hosts.get(id);
    if (!host) {
      const element = document.createElement("div"), title = document.createElement("div"), actions = document.createElement("div");
      element.className = "cw-document"; element.dataset.conversationDocument = id;
      title.className = "cw-window-title-content"; actions.className = "cw-window-actions-content";
      title.dataset.conversationOwner = actions.dataset.conversationOwner = id;
      host = { element, title, actions, surface: document, listeners: new Set() };
      this.hosts.set(id, host);
    }
    return host;
  }
  attach(id: string, slot: HTMLElement, part: Part = "element") {
    const slots = this.slots.get(id) ?? {};
    slots[part] = slot; this.slots.set(id, slots);
    this.place(id, part);
    return () => {
      if (slots[part] !== slot) return;
      delete slots[part]; this.place(id, part);
    };
  }
  preview(id: string, slots: Partial<ConversationHostSlots>) {
    this.previews.set(id, slots);
    for (const part of ["element", "title", "actions"] as const) this.place(id, part);
    return () => {
      if (this.previews.get(id) !== slots) return;
      this.previews.delete(id);
      for (const part of ["element", "title", "actions"] as const) this.place(id, part);
    };
  }
  registerTools(id: string, hosts: PanelHosts, store: DockStore) {
    const host = this.get(id), tools = { hosts, store };
    host.tools = tools;
    return () => { if (host.tools === tools) delete host.tools; };
  }
  private place(id: string, part: Part) {
    const host = this.get(id), element = host[part];
    const destination = this.previews.get(id)?.[part] ?? this.slots.get(id)?.[part];
    if (destination && element.parentElement !== destination) {
      const scroll = [element, ...element.querySelectorAll<HTMLElement>("*")].filter(node => node.scrollTop || node.scrollLeft).map(node => ({ node, top: node.scrollTop, left: node.scrollLeft }));
      const movable = destination as HTMLElement & { moveBefore?: (node: Node, before: Node | null) => void };
      if (movable.moveBefore && element.isConnected && destination.isConnected && element.ownerDocument === destination.ownerDocument) movable.moveBefore(element, null);
      else destination.append(element);
      for (const position of scroll) { position.node.scrollTop = position.top; position.node.scrollLeft = position.left; }
    } else if (!destination) {
      element.remove();
      if (element.ownerDocument !== document) document.adoptNode(element);
    }
    if (part === "element" && host.surface !== element.ownerDocument) {
      host.surface = element.ownerDocument;
      for (const listener of host.listeners) listener();
    }
    host.tools?.hosts.flush();
  }
}
