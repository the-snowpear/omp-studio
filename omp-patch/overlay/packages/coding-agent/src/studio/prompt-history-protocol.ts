import { isRecord } from "@oh-my-pi/pi-utils";
import { SessionControlError } from "./services/session-control-service";

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
	"history.prompts.list": {
		sessionId: string;
		scope: PromptHistoryScope;
		items: PromptHistoryItem[];
		truncated: boolean;
	};
	"history.prompts.read": { id: number; revision: string; prompt: string; truncated: boolean };
}
export type PromptHistoryQueryOperation = {
	[K in keyof PromptHistoryQueryInputMap]: { kind: K } & PromptHistoryQueryInputMap[K];
}[keyof PromptHistoryQueryInputMap];
export type PromptHistoryCommandOperation = { kind: "history.prompts.delete" } & PromptHistoryReference;
export interface PromptHistoryCommandResultMap {
	"history.prompts.delete": { id: number; deleted: true };
}
export type PromptHistoryOperation = PromptHistoryQueryOperation | PromptHistoryCommandOperation;
export interface PromptHistoryResultMap extends PromptHistoryQueryResultMap, PromptHistoryCommandResultMap {}
export const PROMPT_HISTORY_QUERY_KINDS = ["history.prompts.list", "history.prompts.read"] as const;
export const PROMPT_HISTORY_COMMAND_KINDS = ["history.prompts.delete"] as const;
export function isPromptHistoryKind(kind: string): kind is PromptHistoryOperation["kind"] {
	return ([...PROMPT_HISTORY_QUERY_KINDS, ...PROMPT_HISTORY_COMMAND_KINDS] as readonly string[]).includes(kind);
}

/** Called once, by the executing history service; no Host-side copy. */
export function validatePromptHistoryOperation(value: unknown): asserts value is PromptHistoryOperation {
	if (
		!isRecord(value) ||
		typeof value.kind !== "string" ||
		!isPromptHistoryKind(value.kind) ||
		typeof value.sessionId !== "string" ||
		!value.sessionId
	)
		throw new SessionControlError("INVALID_ARGUMENT", "Invalid prompt history operation");
	if (value.scope !== undefined && !["profile", "workspace", "session"].includes(value.scope as string))
		throw new SessionControlError("INVALID_ARGUMENT", "Unknown prompt history scope");
	if (value.kind === "history.prompts.list") {
		if (
			value.limit !== undefined &&
			(!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 200)
		)
			throw new SessionControlError("INVALID_ARGUMENT", "Prompt history limit must be between 1 and 200");
		if (value.query !== undefined && (typeof value.query !== "string" || value.query.length > 500))
			throw new SessionControlError("INVALID_ARGUMENT", "Prompt history search is limited to 500 characters");
	} else if (
		value.scope === undefined ||
		!Number.isSafeInteger(value.id) ||
		Number(value.id) < 1 ||
		typeof value.revision !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.revision)
	) {
		throw new SessionControlError("INVALID_ARGUMENT", "Prompt history requires a scoped, versioned row");
	}
}
