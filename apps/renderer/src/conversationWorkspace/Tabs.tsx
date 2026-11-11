import { useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { SessionTitleMark } from "../history/SessionTitleMark";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { MenuItem } from "../menus";
import { formatShortcut, SHORTCUTS } from "../keyboard/shortcuts";
import { useDock } from "../dock/DockContext";
import { DockToolsButton } from "../dock/DockMenus";
import { PanelGlyph, closePanels, definitionFor } from "../dock/panelChrome";
import { floatTitle } from "../dock/workbenchGeometry";
import { conversationWindowTint, panelWindowTint, type WindowTint } from "../dock/windowTint";
import { isConversationPanelId, type PanelId } from "../dock/types";
import type { ToolTabInfo } from "./hosts";
import type { ConversationWorkspaceStore } from "./store";

/** A tool picked from the tab bar's + opens at the dock's usual floating size. */
const TOOL_WINDOW = { width: 560, height: 400 };

function useText() {
  const { resolvedLanguage } = useI18n();
  return (zh: string, en: string) => resolvedLanguage === "zh" ? zh : en;
}

type WindowTab = { key: string; tint: WindowTint; minimized: boolean; title: string; label: string; mark: ReactNode; extra: ReactNode; closeLabel: string; closeTip: string; focus: () => void; close: () => void };

/** Window mode: one tab per window, conversations and tools alike (minimized and desktop windows included), in the order they opened.
    A tab focuses its window where it is; × closes it like the window's own ×. The active conversation's dock fills the + slot. */
export function WindowTabs({ store, addSlot }: { store: ConversationWorkspaceStore; addSlot: (node: HTMLElement | null) => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useSyncExternalStore(store.hosts.subscribeTabs, store.hosts.tabsRevision);
  const focused = useSyncExternalStore(store.windows.subscribe, () => store.windows.getSnapshot().activeId);
  const text = useText();
  const list = useRef<HTMLDivElement>(null);
  const tabs = store.manager.getSnapshot().records.flatMap((record): WindowTab[] => {
    const native = record.placement === "native";
    const where = record.minimized ? text("已最小化", "Minimized") : native ? text("独立窗口", "Desktop window") : undefined;
    if (record.content.kind === "conversation") {
      const info = store.hosts.tab(record.content.documentId);
      const title = info?.title || state.documents.find(doc => doc.id === record.content.documentId)?.title || text("新对话", "New conversation");
      const marked = info?.titleRow?.state === "available" && !!info.titleRow.card && info.titleRow.title === title;
      return [{
        key: `conversation:${record.id}`, tint: conversationWindowTint(record.content.documentId, store), minimized: record.minimized, title, label: [title, info?.status?.label, where].filter(Boolean).join(" · "),
        mark: <>{native ? <Icon name="external" extra="sm" /> : marked ? null : <Icon name="message" extra="sm" />}{marked ? <SessionTitleMark row={info!.titleRow} title={title} /> : null}</>,
        extra: info?.status ? <span className={`cw-window-status ${info.status.tone}`} aria-hidden="true"><span className="dot" /></span> : null,
        closeLabel: text(`关闭 ${title}`, `Close ${title}`), closeTip: text("关闭对话视图", "Close conversation view"),
        focus: () => store.focus(record.id), close: () => store.close(record.id),
      }];
    }
    const info = store.hosts.toolTab(record.id);
    if (!info) return [];
    const tools = info.count > 1 ? text(`${info.count} 个工具`, `${info.count} tools`) : undefined;
    return [{
      key: record.id, tint: panelWindowTint(info.mark.id, store), minimized: record.minimized, title: info.title, label: [info.title, tools, where].filter(Boolean).join(" · "),
      mark: <PanelGlyph definition={info.mark} />, extra: info.count > 1 ? <span className="dock-count" aria-hidden="true">{info.count}</span> : null,
      closeLabel: text(`关闭 ${info.title}`, `Close ${info.title}`), closeTip: info.closeTip,
      // The dock's callbacks change without a visible change; always run the latest ones.
      focus: () => store.hosts.toolTab(record.id)?.focus(), close: () => store.hosts.toolTab(record.id)?.close(),
    }];
  });
  // A focused window wins; with every window minimized, the conversation holding the shared chrome stays selected.
  const owner = state.views.find(view => view.documentId === state.activeDocumentId);
  const activeKey = tabs.some(tab => tab.key === focused) ? focused : owner ? `conversation:${owner.id}` : undefined;
  const focusableKey = tabs.some(tab => tab.key === activeKey) ? activeKey : tabs[0]?.key;
  useLayoutEffect(() => {
    if (activeKey) list.current?.querySelector<HTMLElement>(`[data-window-tab="${activeKey}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey]);
  const focusTab = (key: string | undefined) => list.current?.querySelector<HTMLButtonElement>(`[data-window-tab="${key}"] [role="tab"]`)?.focus();
  const close = (index: number) => {
    const neighbour = tabs[index + 1] ?? tabs[index - 1];
    const hadFocus = !!list.current?.contains(document.activeElement);
    tabs[index]!.close();
    if (hadFocus) requestAnimationFrame(() => focusTab(neighbour?.key));
  };
  // Arrows only move focus: activating a window moves focus into it, which would end keyboard travel along the strip.
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    const count = tabs.length;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      focusTab(tabs[event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + count) % count]?.key);
    } else if (event.key === "Delete") {
      event.preventDefault();
      close(index);
    }
  };
  return <div className="cw-tab-strip">
    <div className="cw-tabs" ref={list} role="tablist" aria-label={text("窗口标签", "Window tabs")}>
      {tabs.map((tab, index) => {
        const active = tab.key === activeKey, focusable = tab.key === focusableKey ? 0 : -1;
        return <div key={tab.key} role="presentation" data-window-tab={tab.key} data-window-tint={tab.tint} className={`cw-tab${active ? " is-active" : ""}${tab.minimized ? " is-minimized" : ""}`}>
          <button type="button" role="tab" className="cw-tab-label" aria-selected={active} tabIndex={focusable} aria-label={tab.label} data-tip={tab.label}
            onClick={tab.focus} onKeyDown={event => keys(event, index)}>
            {tab.mark}<span className="cw-tab-title">{tab.title}</span>{tab.extra}
          </button>
          <button type="button" className="cw-tab-close" tabIndex={focusable} aria-label={tab.closeLabel} data-tip={tab.closeTip}
            onClick={() => close(index)}><Icon name="x" extra="sm" /></button>
        </div>;
      })}
    </div>
    <span className="cw-tab-add-slot" ref={addSlot} />
  </div>;
}

/** Inside a conversation's dock: publishes its tool windows to the window tab bar. */
export function ToolWindowTabs({ workspace, documentId }: { workspace: ConversationWorkspaceStore; documentId: string }) {
  const { layout, definitions, store, conversationTitle } = useDock();
  const text = useText();
  const tabs = layout.floats.filter(group => !isConversationPanelId(group.id)).map((group): ToolTabInfo => {
    const definition = definitionFor(definitions, group.active);
    const several = group.panels.length > 1, pages = group.panels.some(panel => definitionFor(definitions, panel).close);
    return {
      windowId: store.windowId(group.id), title: floatTitle(definition.title, conversationTitle), count: group.panels.length,
      mark: { id: definition.id, title: definition.title, icon: definition.icon, ...(definition.glyph ? { glyph: definition.glyph } : {}), ...(definition.status ? { status: definition.status } : {}), ...(definition.stale ? { stale: true } : {}) },
      closeTip: pages ? several ? text("关闭网页并隐藏其余工具", "Close pages and hide other tools") : text("关闭网页", "Close page") : several ? text("隐藏整组", "Hide group") : text("隐藏工具", "Hide tool"),
      focus: () => store.dispatch({ type: "open", panel: group.active }),
      close: () => closePanels(store, definitions, group.panels),
    };
  });
  useLayoutEffect(() => { workspace.hosts.setToolTabs(documentId, tabs); });
  useLayoutEffect(() => () => workspace.hosts.setToolTabs(documentId, []), [workspace, documentId]);
  return null;
}

/** The window tab bar's +, lent by the active conversation's dock: the sidebar's 「新建标签」 menu with 新建对话 on top.
    A picked tool moves into a window of its own, which is its new tab. */
export function WindowTabAdd({ workspace }: { workspace: ConversationWorkspaceStore }) {
  const { layout, store, preferences } = useDock();
  const text = useText();
  const windowed = layout.floats.filter(group => !isConversationPanelId(group.id)).flatMap(group => group.panels);
  const pick = (panel: PanelId) => {
    // A locked layout keeps every tool where it is, so the tool opens there instead.
    if (!preferences.locked) store.dispatch({ type: "move", panels: [panel], target: { region: "float", rect: workspace.nextWindowRect(TOOL_WINDOW) } });
    store.dispatch({ type: "open", panel });
  };
  return <DockToolsButton className="cw-tab-add" label={text("新建标签", "New tab")} exclude={windowed} onPick={pick}
    leading={close => <><MenuItem icon="message" kbd={formatShortcut(SHORTCUTS.newChat)} onClick={() => { close(); workspace.openNewWindow(); }}>{text("新建对话", "New conversation")}</MenuItem><div className="menu-sep" /></>} />;
}
