import type { ComposerSnapshot, PromptImage } from "../composer/types";
import type { ConversationState } from "./conversationViewModel";

/** Roster fields the inspect composer needs; matches Agent Hub `caps.chat`. */
export type SubagentComposerAgent = {
  readonly agentId: string;
  readonly kind: string;
  readonly status: string;
  readonly readOnly?: boolean;
  readonly generation?: number;
};

const TERMINAL_STATUS = new Set(["aborted", "failed", "released"]);

/**
 * Whether the inspect / Hub conversation pane may render a ChipComposer.
 * Preview is display-only unless `previewComposer` is on (Hub chat preview);
 * that path still never writes Host.
 */
export function subagentComposerVisible(input: {
  readonly preview: boolean;
  readonly previewComposer?: boolean;
  readonly runtimeConnected: boolean;
  readonly hasClient: boolean;
  readonly canSend: boolean;
  readonly agent: SubagentComposerAgent | undefined;
}): boolean {
  const agent = input.agent;
  if (agent === undefined) return false;
  if (agent.kind === "advisor" || agent.readOnly === true) return false;
  if (TERMINAL_STATUS.has(agent.status)) return false;
  if (input.preview) return input.previewComposer === true;
  if (!input.runtimeConnected || !input.hasClient || !input.canSend) return false;
  return true;
}

export function findSubagentComposerAgent<T extends SubagentComposerAgent>(
  agents: readonly T[],
  agentId: string,
): T | undefined {
  return agents.find((agent) => agent.agentId === agentId);
}

/** Live turn of THIS subagent session — not the parent `snapshot.isStreaming`. */
export function subagentTurnRunning(state: ConversationState): boolean {
  if (Object.keys(state.liveMessages).length > 0) return true;
  if (Object.keys(state.liveTools).length > 0) return true;
  return Object.keys(state.openTurnItems).length > 0;
}

/**
 * Serialized composer payload for `agent.send`.
 * Disk file/image capsules become `@path` in `text`; clipboard images stay in `images`.
 */
export function subagentComposerText(
  snapshot: ComposerSnapshot,
): { kind: "ready"; text: string; images?: readonly PromptImage[] } | { kind: "empty" } {
  const text = snapshot.text.trim();
  if (text.length === 0) return { kind: "empty" };
  if (snapshot.images.length > 0) return { kind: "ready", text, images: snapshot.images };
  return { kind: "ready", text };
}
