/** Native prompt history, not session transcripts. Bodies are transient and never enter the ledger. */
export type PromptHistoryScope = "profile" | "workspace" | "session";
export interface PromptHistoryItem {
  id: number;
  revision: string;
  preview: string;
  createdAt: number;
  useCount: number;
  cwd?: string;
  sourceSessionId?: string;
}
export interface PromptHistoryReference {
  sessionId: string;
  scope: PromptHistoryScope;
  id: number;
  revision: string;
}
export interface PromptHistoryQueryInputMap {
  "history.prompts.list": { sessionId: string; scope?: PromptHistoryScope; limit?: number; query?: string };
  "history.prompts.read": PromptHistoryReference;
}
export interface PromptHistoryQueryResultMap {
  "history.prompts.list": { sessionId: string; scope: PromptHistoryScope; items: PromptHistoryItem[]; truncated: boolean };
  "history.prompts.read": { id: number; revision: string; prompt: string; truncated: boolean };
}
export type PromptHistoryQueryOperation = { [K in keyof PromptHistoryQueryInputMap]: { kind: K } & PromptHistoryQueryInputMap[K] }[keyof PromptHistoryQueryInputMap];
export type PromptHistoryCommandOperation = { kind: "history.prompts.delete" } & PromptHistoryReference;
export interface PromptHistoryCommandResultMap { "history.prompts.delete": { id: number; deleted: true } }
export type PromptHistoryOperation = PromptHistoryQueryOperation | PromptHistoryCommandOperation;
export interface PromptHistoryResultMap extends PromptHistoryQueryResultMap, PromptHistoryCommandResultMap {}
export const PROMPT_HISTORY_QUERY_KINDS = ["history.prompts.list", "history.prompts.read"] as const;
export const PROMPT_HISTORY_COMMAND_KINDS = ["history.prompts.delete"] as const;
export function isPromptHistoryKind(kind: string): kind is PromptHistoryOperation["kind"] {
  return ([...PROMPT_HISTORY_QUERY_KINDS, ...PROMPT_HISTORY_COMMAND_KINDS] as readonly string[]).includes(kind);
}
