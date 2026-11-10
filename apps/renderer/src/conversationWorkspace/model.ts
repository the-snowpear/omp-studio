import type { DockPinMode, DockRect } from "../dock/types";
import type { ConversationSnapLayout, SnapTemplate } from "./snap";
export type WorkspaceRoute = "home" | "workbench" | "history" | "agent-hub" | "capabilities" | "model-config" | "settings" | "diagnostics" | "media" | "evaluation" | "statistics";
export type ConversationRef = { targetId: string | null; workspaceId?: string | undefined; sessionId?: string | undefined; draftId?: string | undefined; threadId?: string | undefined; historyId?: string | undefined; previewThreadId?: string | undefined; previewProjectId?: string | undefined };
export type ConversationViewId = string;
export type Rect = DockRect;
export type ConversationView = {
  id: ConversationViewId; documentId: string; placement: "main" | "float" | "native" | "docked";
  rect: Rect; minimized: boolean; maximized: boolean; pin: DockPinMode;
  nativeRect?: Rect;
  restoreSnap?: { template: SnapTemplate; cell: number } | undefined;
};
export type ConversationDocument = { id: string; ref: ConversationRef; title: string; projectName?: string | undefined; route?: WorkspaceRoute | undefined; page?: boolean; pagePhase?: "in" | "out" };
export type ConversationWorkspaceLayout = {
  version: 4; coordinateVersion: 1; views: ConversationView[]; documents: ConversationDocument[];
  snap: ConversationSnapLayout | null; snapAssistCell: number | null;
  activeViewId: string | null; activeDocumentId: string | null; sidebarWidth: number; sidebarVisible: boolean; panelWidth: number; bottomHeight: number; railCollapsed: boolean;
};
export const MIN_VIEW = { width: 360, height: 280 };
export const conversationKey = (ref: ConversationRef) => JSON.stringify([ref.targetId, ref.workspaceId, ref.previewThreadId ? ref.draftId && ref.draftId !== "initial" ? ref.draftId : ref.previewThreadId : ref.sessionId ?? ref.historyId ?? ref.draftId ?? "initial"]);

export function conversationVisible(view: ConversationView, state: ConversationWorkspaceLayout): boolean {
  if (view.minimized) return false;
  if (view.placement === "native") return true;
  const active = state.documents.find(doc => doc.id === state.activeDocumentId);
  const own = state.documents.find(doc => doc.id === view.documentId);
  if (view.pin === "workspace") return own?.ref.targetId === active?.ref.targetId && own?.ref.workspaceId === active?.ref.workspaceId;
  return view.pin === "application" || !active?.page;
}
