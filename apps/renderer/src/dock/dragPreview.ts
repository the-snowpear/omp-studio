import { useSyncExternalStore } from "react";
import type { PanelHosts } from "./hosts";
import type { DockLayout, DockRect, DockTarget, PanelId } from "./types";
import type { CardPlacement } from "./cardDrag";
import type { ConversationHostSlots } from "../conversationWorkspace/hosts";
import type { WindowLayout, WorkbenchWindows } from "./windows";

export type DragSource = { hosts: PanelHosts; panels: PanelId[]; rect: DockRect; snapped: boolean; cards: Partial<Record<PanelId, DockRect>> };

export type DragPreview = {
  kind?: "tool" | "conversation";
  source: DragSource;
  hosts: PanelHosts;
  layout: DockLayout;
  panels: PanelId[];
  target: DockTarget;
  rect: DockRect;
  label: string;
  snapped: boolean;
  cards?: CardPlacement;
  settling?: boolean;
  workspace?: { manager: WorkbenchWindows; layout: WindowLayout; sourceId: string };
  conversation?: {
    title: string;
    documentId?: string | undefined;
    sourceElement?: HTMLElement | undefined;
    attach?: ((slots: Partial<ConversationHostSlots>) => () => void) | undefined;
    loadingLabel: string;
  };
};

// Only the preview subscribes to pointer geometry; the workbench and transcript do not.
let current: DragPreview | null = null;
const listeners = new Set<() => void>();
export const dragPreview = {
  snapshot: () => current,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  show(value: DragPreview | null) { current = value; for (const listener of listeners) listener(); },
  settle() { if (current) this.show({ ...current, settling: true }); },
};

export function useDragSource(hosts: PanelHosts) {
  return useSyncExternalStore(dragPreview.subscribe, () => current?.hosts === hosts ? current.source : null);
}

export function useDragRegion(hosts: PanelHosts) {
  return useSyncExternalStore(dragPreview.subscribe, () => current?.hosts === hosts ? current.target.region : null);
}

export function sourceActive(group: { panels: PanelId[]; active: PanelId }, source: DragSource | null): PanelId {
  if (!source?.panels.includes(group.active)) return group.active;
  const remaining = group.panels.filter(id => !source.panels.includes(id));
  return remaining[Math.min(group.panels.indexOf(group.active), remaining.length - 1)] ?? group.active;
}
