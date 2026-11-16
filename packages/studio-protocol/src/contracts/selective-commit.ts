/** Native selective-commit metadata. Patch bodies are transient reads, not snapshot/ledger data. */
export type SelectiveCommitOwnership = "own" | "other" | "review";
export type SelectiveCommitSelectionState = "none" | "partial" | "all";
export type SelectiveCommitPathKind = "text" | "binary" | "non-utf8" | "large" | "symlink" | "mode";
export type SelectiveCommitReason =
  | { kind: "entangled"; with: readonly string[] }
  | { kind: "rewritten"; by: string }
  | { kind: "hunk" }
  | {
      kind: "whole";
      reason: Exclude<SelectiveCommitPathKind, "text">;
      editors: string[];
      hint?: { type: "call"; agent: string; parent?: string; tool: string; start: number; end: number; label: string };
    };
export interface SelectiveCommitUnit {
  /** The native per-file unit ID, e.g. "2b". No GUI-generated ownership IDs. */
  id: string;
  actor: string | null;
  opIds: number[];
  ownership: SelectiveCommitOwnership[];
  selected: SelectiveCommitSelectionState;
  added: number;
  removed: number;
  likely: boolean;
  reasons: SelectiveCommitReason[];
}
export interface SelectiveCommitHunk {
  id: string;
  headStart: number;
  headCount: number;
  workStart: number;
  workCount: number;
  units: SelectiveCommitUnit[];
}
export interface SelectiveCommitPath {
  path: string;
  kind: SelectiveCommitPathKind;
  change: "added" | "modified" | "deleted";
  beforeMode: string | null;
  afterMode: string | null;
  workBytes: number;
  staged: boolean;
  selected: SelectiveCommitSelectionState;
  ownership: SelectiveCommitOwnership[];
  hunks: SelectiveCommitHunk[];
}
export interface SelectiveCommitDraftView {
  id: string;
  revision: number;
  head: string | null;
  branch?: string;
  caller: string;
  scope: string[];
  agents: Array<{ id: string; parent?: string; inScope: boolean; running: boolean }>;
  state: "open" | "busy" | "consumed";
  paths: SelectiveCommitPath[];
  staged: string[];
  skipped: string[];
}
export interface SelectiveCommitDraft {
  sessionId: string;
  runtimeEpoch: number;
  expiresAt: number;
  view: SelectiveCommitDraftView;
}
export interface SelectiveCommitPreview {
  draftId: string;
  revision: number;
  previewId: string;
  head: string | null;
  tree: string;
  bytes: number;
  paths: string[];
  expiresAt: number;
}
export type SelectiveCommitBodyTarget =
  | { kind: "file"; path: string; offset?: number }
  | { kind: "preview"; previewId: string; offset?: number };
export interface SelectiveCommitRead {
  draft: SelectiveCommitDraft;
  body?: {
    kind: "file" | "preview";
    /** Null for whole-file sources, which have no line-attributed text diff. */
    text: string | null;
    offset: number;
    totalChars: number;
    nextOffset?: number;
  };
}
export type SelectiveCommitSelection =
  | { action: "take" | "drop"; path: string; units?: string[] }
  | { action: "only"; paths: string[] };
export interface SelectiveCommitMessage {
  subject: string;
  body?: string | string[];
  fixes?: Array<string | number>;
}
export interface SelectiveCommitOptions { amend?: boolean; noVerify?: boolean }
export interface SelectiveCommitOutcome {
  sha: string;
  subject: string;
  paths: string[];
  parent: string | null;
  indexNotes: string[];
}
export type SelectiveCommitOperation =
  | { kind: "commit.draft.prepare"; sessionId: string; scope?: string | string[] }
  | { kind: "commit.draft.read"; sessionId: string; draftId: string; revision: number; body?: SelectiveCommitBodyTarget }
  | { kind: "commit.draft.select"; sessionId: string; draftId: string; revision: number; selection: SelectiveCommitSelection }
  | { kind: "commit.draft.preview"; sessionId: string; draftId: string; revision: number }
  | {
      kind: "commit.draft.execute"; sessionId: string; draftId: string; revision: number; previewId: string;
      message: SelectiveCommitMessage; options?: SelectiveCommitOptions;
    }
  | { kind: "commit.draft.release"; sessionId: string; draftId: string };
export interface SelectiveCommitResultMap {
  "commit.draft.prepare": SelectiveCommitDraft;
  "commit.draft.read": SelectiveCommitRead;
  "commit.draft.select": SelectiveCommitDraft;
  "commit.draft.preview": SelectiveCommitPreview;
  "commit.draft.execute": SelectiveCommitOutcome;
  "commit.draft.release": { released: boolean };
}
export const SELECTIVE_COMMIT_QUERY_KINDS = [
  "commit.draft.prepare", "commit.draft.read", "commit.draft.preview", "commit.draft.release",
] as const;
export const SELECTIVE_COMMIT_COMMAND_KINDS = ["commit.draft.select", "commit.draft.execute"] as const;
export const SELECTIVE_COMMIT_OPERATION_KINDS = [...SELECTIVE_COMMIT_QUERY_KINDS, ...SELECTIVE_COMMIT_COMMAND_KINDS] as const;
export type SelectiveCommitQueryInputMap = {
  [K in typeof SELECTIVE_COMMIT_QUERY_KINDS[number]]: Omit<Extract<SelectiveCommitOperation, { kind: K }>, "kind">;
};
export type SelectiveCommitQueryResultMap = Pick<SelectiveCommitResultMap, typeof SELECTIVE_COMMIT_QUERY_KINDS[number]>;
export type SelectiveCommitCommandInputMap = {
  [K in typeof SELECTIVE_COMMIT_COMMAND_KINDS[number]]: Omit<Extract<SelectiveCommitOperation, { kind: K }>, "kind">;
};
export type SelectiveCommitCommandResultMap = Pick<SelectiveCommitResultMap, typeof SELECTIVE_COMMIT_COMMAND_KINDS[number]>;
export function isSelectiveCommitKind(kind: string): kind is SelectiveCommitOperation["kind"] {
  return (SELECTIVE_COMMIT_OPERATION_KINDS as readonly string[]).includes(kind);
}
