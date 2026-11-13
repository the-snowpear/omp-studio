export type ContextCategoryId = "system-prompt" | "instruction-files" | "skills" | "built-in-tools" | "custom-tools" | "user-messages" | "assistant-messages" | "assistant-thinking" | "tool-calls" | "tool-output";

/** UTF-16 offsets in a returned page of redacted text; links carry a native entry identity. */
export interface ContextViewSourceMarker { start: number; end: number; category: ContextCategoryId; entryId?: string }

/** Shared reasoning weight of one assistant message with several thinking blocks; member entries carry zero. */
export interface ContextThinkingGroupSummary { id: string; label: string; tokens: number; interrupted?: boolean }

export interface ContextEntrySummary {
  id: string;
  label: string;
  /** Native estimate for this entry; zero for members of a thinking group, whose weight sits on the group. */
  tokens: number;
  bytes: number;
  info?: string;
  path?: string;
  interrupted?: boolean;
  /** Source message timestamp, epoch milliseconds. */
  timestamp?: number;
  callId?: string;
  /** Owning group key, for example `tool-output/tool-0`. */
  childKey?: string;
  thinkingGroup?: ContextThinkingGroupSummary;
  /** Redacted head of the body, so the list previews without fetching every entry. */
  preview?: string;
}

export interface ContextCategorySummary {
  id: ContextCategoryId;
  label: string;
  tokens: number;
  entries: number;
  /** Group key; present on children such as one tool's output group. */
  key?: string;
  /** Overview-only label when the weight differs from the content, for example "System Prompt (excluding Skills)". */
  overviewLabel?: string;
  /** Listed with its weight but never opened. */
  openable?: false;
  children?: ContextCategorySummary[];
}

export interface ContextSnapcompactSummary { visionCapable: boolean; savedTokens: number }
export interface ContextModelSummary { id: string; name?: string }

export interface ContextViewIndex {
  sessionId: string; snapshotId: string; capturedAt: string;
  contextWindow: number; usedTokens: number; freeTokens: number; bufferTokens: number; thresholdTokens: number | null;
  savedTokens: number; truncated: boolean; categories: ContextCategorySummary[];
  model?: ContextModelSummary;
  snapcompact?: ContextSnapcompactSummary;
  /** Native snapshot caveats, not another estimate of the prompt. */
  notices?: string[];
}
export type ContextViewOperation =
  | { kind: "context.view.open"; sessionId: string }
  | { kind: "context.view.list"; sessionId: string; snapshotId: string; category: ContextCategoryId; childKey?: string; offset?: number; search?: string; focusEntryId?: string }
  | { kind: "context.view.entry"; sessionId: string; snapshotId: string; entryId: string; offset?: number }
  | { kind: "context.view.release"; sessionId: string; snapshotId: string };
export interface ContextViewResultMap {
  "context.view.open": ContextViewIndex;
  "context.view.list": { entries: ContextEntrySummary[]; total: number; nextOffset?: number };
  "context.view.entry": { entryId: string; text: string; totalChars: number; nextOffset?: number; truncated: boolean; sourceMarkers?: ContextViewSourceMarker[] };
  "context.view.release": { released: boolean };
}
export const CONTEXT_VIEW_KINDS = ["context.view.open", "context.view.list", "context.view.entry", "context.view.release"] as const;
export function isContextViewKind(kind: string): kind is ContextViewOperation["kind"] { return (CONTEXT_VIEW_KINDS as readonly string[]).includes(kind); }
