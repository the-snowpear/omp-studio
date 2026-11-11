import type { ConversationWorkspaceStore } from "../conversationWorkspace/store";
import { isAgentPanelId, isBrowserPagePanelId, isConversationPanelId, isFilePanelId, panelBaseId, type FixedPanelId, type PanelId } from "./types";

export type WindowTint = "violet" | "blue" | "pink" | "amber" | "teal" | "green" | "indigo" | "orange" | "cyan" | "rose";

const CONVERSATION_TINTS: readonly WindowTint[] = ["violet", "blue", "pink", "amber", "teal", "green", "indigo", "orange"];
const PANEL_TINTS: Record<FixedPanelId, WindowTint> = {
  files: "indigo", changes: "teal", git: "orange", "git-quick": "orange",
  browser: "blue", computer: "cyan", agents: "pink", "agent-detail": "pink",
  environment: "teal", context: "blue", "context-viewer": "blue", annotations: "amber",
  "token-counter": "blue", terminal: "green", jobs: "violet", problems: "rose",
  tests: "green", output: "indigo", logs: "amber", pvlogs: "amber", btw: "violet",
};

/** Document opening order stays put while windows are focused, moved or closed. */
export function conversationWindowTint(documentId: string | undefined, workspace?: ConversationWorkspaceStore | null): WindowTint {
  const documents = workspace?.getSnapshot().documents ?? [];
  const index = documentId === undefined ? documents.length : documents.findIndex(document => document.id === documentId);
  return CONVERSATION_TINTS[index % CONVERSATION_TINTS.length] ?? "violet";
}

/** Instances share their tool's colour; a docked conversation keeps its own. */
export function panelWindowTint(panel: PanelId, workspace?: ConversationWorkspaceStore | null): WindowTint {
  if (isConversationPanelId(panel)) return conversationWindowTint(workspace?.documentFor(panel.slice("conversation:".length))?.id, workspace);
  if (isAgentPanelId(panel)) return "pink";
  if (isBrowserPagePanelId(panel)) return "blue";
  if (isFilePanelId(panel)) return "indigo";
  return PANEL_TINTS[panelBaseId(panel) as FixedPanelId];
}
