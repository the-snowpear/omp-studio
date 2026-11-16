import type { DraftView } from "../commit/selective/draft";

export type SelectiveCommitDraftView = DraftView;
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
export interface SelectiveCommitOptions {
	amend?: boolean;
	noVerify?: boolean;
}
export interface SelectiveCommitOutcome {
	sha: string;
	subject: string;
	paths: string[];
	parent: string | null;
	indexNotes: string[];
}
export type SelectiveCommitOperation =
	| { kind: "commit.draft.prepare"; sessionId: string; scope?: string | string[] }
	| {
			kind: "commit.draft.read";
			sessionId: string;
			draftId: string;
			revision: number;
			body?: SelectiveCommitBodyTarget;
	  }
	| {
			kind: "commit.draft.select";
			sessionId: string;
			draftId: string;
			revision: number;
			selection: SelectiveCommitSelection;
	  }
	| { kind: "commit.draft.preview"; sessionId: string; draftId: string; revision: number }
	| {
			kind: "commit.draft.execute";
			sessionId: string;
			draftId: string;
			revision: number;
			previewId: string;
			message: SelectiveCommitMessage;
			options?: SelectiveCommitOptions;
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
	"commit.draft.prepare",
	"commit.draft.read",
	"commit.draft.preview",
	"commit.draft.release",
] as const;
export const SELECTIVE_COMMIT_COMMAND_KINDS = ["commit.draft.select", "commit.draft.execute"] as const;
export const SELECTIVE_COMMIT_OPERATION_KINDS = [
	...SELECTIVE_COMMIT_QUERY_KINDS,
	...SELECTIVE_COMMIT_COMMAND_KINDS,
] as const;
export type SelectiveCommitQueryInputMap = {
	[K in (typeof SELECTIVE_COMMIT_QUERY_KINDS)[number]]: Omit<Extract<SelectiveCommitOperation, { kind: K }>, "kind">;
};
export type SelectiveCommitQueryResultMap = Pick<
	SelectiveCommitResultMap,
	(typeof SELECTIVE_COMMIT_QUERY_KINDS)[number]
>;
export type SelectiveCommitCommandInputMap = {
	[K in (typeof SELECTIVE_COMMIT_COMMAND_KINDS)[number]]: Omit<Extract<SelectiveCommitOperation, { kind: K }>, "kind">;
};
export type SelectiveCommitCommandResultMap = Pick<
	SelectiveCommitResultMap,
	(typeof SELECTIVE_COMMIT_COMMAND_KINDS)[number]
>;
export function isSelectiveCommitKind(kind: string): kind is SelectiveCommitOperation["kind"] {
	return (SELECTIVE_COMMIT_OPERATION_KINDS as readonly string[]).includes(kind);
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid selective commit input");
	return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): void {
	if (typeof value !== "string" || !value.length || value.length > limit || value.includes("\0")) {
		throw new Error("Invalid selective commit text");
	}
}
function strings(value: unknown, maxItems: number, maxChars: number): void {
	if (!Array.isArray(value) || value.length === 0 || value.length > maxItems)
		throw new Error("Invalid commit selection");
	for (const item of value) text(item, maxChars);
}

/** The single Runtime input check. Host/contracts must not duplicate this check. */
export function validateSelectiveCommitOperation(value: unknown): void {
	const row = record(value);
	if (typeof row.kind !== "string" || !isSelectiveCommitKind(row.kind))
		throw new Error("Unknown selective commit operation");
	text(row.sessionId, 256);
	if (row.kind === "commit.draft.prepare") {
		if (Array.isArray(row.scope)) strings(row.scope, 128, 256);
		else if (row.scope !== undefined) text(row.scope, 256);
		return;
	}
	text(row.draftId, 128);
	if (row.kind === "commit.draft.release") return;
	if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 1) throw new Error("Invalid draft revision");
	if (row.kind === "commit.draft.read" && row.body !== undefined) {
		const body = record(row.body);
		if (body.kind === "file") text(body.path, 4096);
		else if (body.kind === "preview") text(body.previewId, 128);
		else throw new Error("Unknown commit body target");
		if (body.offset !== undefined && (!Number.isSafeInteger(body.offset) || (body.offset as number) < 0)) {
			throw new Error("Invalid commit body offset");
		}
	}
	if (row.kind === "commit.draft.select") {
		const selection = record(row.selection);
		if (selection.action === "only") strings(selection.paths, 1024, 4096);
		else if (selection.action === "take" || selection.action === "drop") {
			text(selection.path, 4096);
			if (selection.units !== undefined) strings(selection.units, 4096, 64);
		} else throw new Error("Unknown commit selection action");
	}
	if (row.kind === "commit.draft.execute") {
		text(row.previewId, 128);
		const message = record(row.message);
		text(message.subject, 4096);
		if (Array.isArray(message.body)) {
			if (message.body.length > 1024) throw new Error("Commit body is too long");
			for (const line of message.body) if (line !== "") text(line, 65536);
			if (message.body.join("\n").length > 65536) throw new Error("Commit body is too long");
		} else if (message.body !== undefined && message.body !== "") text(message.body, 65536);
		if (message.fixes !== undefined) {
			if (!Array.isArray(message.fixes) || message.fixes.length > 128) throw new Error("Invalid issue references");
			for (const reference of message.fixes) {
				if (typeof reference === "number") {
					if (!Number.isSafeInteger(reference) || reference < 1) throw new Error("Invalid issue number");
				} else text(reference, 1024);
			}
		}
		if (row.options !== undefined) {
			const options = record(row.options);
			for (const key of ["amend", "noVerify"]) {
				if (options[key] !== undefined && typeof options[key] !== "boolean")
					throw new Error(`Invalid commit ${key} option`);
			}
		}
	}
}
