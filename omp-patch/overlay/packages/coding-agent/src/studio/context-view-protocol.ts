export type ContextCategoryId =
	| "system-prompt"
	| "skills"
	| "built-in-tools"
	| "custom-tools"
	| "user-messages"
	| "assistant-messages"
	| "assistant-thinking"
	| "tool-calls"
	| "tool-output";
export interface ContextEntrySummary {
	id: string;
	label: string;
	tokens: number;
	bytes: number;
	info?: string;
	path?: string;
	tool?: string;
	interrupted?: boolean;
}
export interface ContextCategorySummary {
	id: ContextCategoryId;
	label: string;
	tokens: number;
	entries: number;
}
export interface ContextViewIndex {
	sessionId: string;
	snapshotId: string;
	capturedAt: string;
	contextWindow: number;
	usedTokens: number;
	freeTokens: number;
	bufferTokens: number;
	thresholdTokens: number | null;
	savedTokens: number;
	truncated: boolean;
	categories: ContextCategorySummary[];
}
export type ContextViewOperation =
	| { kind: "context.view.open"; sessionId: string }
	| {
			kind: "context.view.list";
			sessionId: string;
			snapshotId: string;
			category: ContextCategoryId;
			offset?: number;
			search?: string;
	  }
	| { kind: "context.view.entry"; sessionId: string; snapshotId: string; entryId: string; offset?: number }
	| { kind: "context.view.release"; sessionId: string; snapshotId: string };
export interface ContextViewResultMap {
	"context.view.open": ContextViewIndex;
	"context.view.list": { entries: ContextEntrySummary[]; total: number; nextOffset?: number };
	"context.view.entry": { entryId: string; text: string; totalChars: number; nextOffset?: number; truncated: boolean };
	"context.view.release": { released: boolean };
}
export const CONTEXT_VIEW_KINDS = [
	"context.view.open",
	"context.view.list",
	"context.view.entry",
	"context.view.release",
] as const;
export function isContextViewKind(kind: string): kind is ContextViewOperation["kind"] {
	return (CONTEXT_VIEW_KINDS as readonly string[]).includes(kind);
}
