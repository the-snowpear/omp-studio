export const IDA_VIEWS = [
	"overview",
	"pseudocode",
	"asm",
	"functions",
	"strings",
	"imports",
	"exports",
	"xrefs",
] as const;
export type IdaView = (typeof IDA_VIEWS)[number];
export type IdaEdit =
	| { action: "open"; path: string }
	| { action: "save"; dbId: string }
	| { action: "close"; dbId: string; save: boolean }
	| { action: "rename"; dbId: string; target: string; name: string }
	| { action: "comment"; dbId: string; target: string; text: string; repeatable: boolean }
	| { action: "set_type"; dbId: string; target: string; decl: string }
	| { action: "make_function"; dbId: string; target: string }
	| { action: "exec"; dbId: string; code: string };
export interface IdaRow {
	id: string;
	label: string;
	state: "opening" | "open";
	dirty: boolean;
	busy: boolean;
	identity?: string;
	version?: number;
}
export interface IdaState {
	available: boolean;
	reason?: string;
	databases: IdaRow[];
}
export type IdaOperation =
	| { kind: "ida.status"; sessionId: string }
	| {
			kind: "ida.view";
			sessionId: string;
			dbId: string;
			identity: string;
			version: number;
			view: IdaView;
			target?: string;
			offset?: number;
	  }
	| { kind: "ida.prepare"; sessionId: string; edit: IdaEdit }
	| { kind: "ida.commit"; sessionId: string; token: string }
	| { kind: "ida.cancel"; sessionId: string };
export interface IdaResultMap {
	"ida.status": IdaState;
	"ida.view": { text: string; total: number; offset: number; nextOffset?: number; truncated: boolean };
	"ida.prepare": { token: string; edit: IdaEdit; identity?: string; version?: number; expiresAt: number };
	"ida.commit": { text: string };
	"ida.cancel": { cancelled: boolean };
}
export const IDA_KINDS = ["ida.status", "ida.view", "ida.prepare", "ida.commit", "ida.cancel"] as const;
export function isIdaKind(kind: string): kind is IdaOperation["kind"] {
	return (IDA_KINDS as readonly string[]).includes(kind);
}
function obj(v: unknown): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Invalid IDA fields");
	return v as Record<string, unknown>;
}
function text(v: unknown, max = 4096, empty = false): void {
	if (typeof v !== "string" || (!empty && !v.trim()) || v.length > max || v.includes("\0"))
		throw Error("Invalid IDA text");
}
function num(v: unknown): void {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw Error("Invalid IDA number");
}
export function validateIdaEdit(value: unknown): asserts value is IdaEdit {
	const a = (value as { action?: string })?.action;
	const fields: Record<string, string[]> = {
		open: ["path"],
		save: ["dbId"],
		close: ["dbId", "save"],
		rename: ["dbId", "target", "name"],
		comment: ["dbId", "target", "text", "repeatable"],
		set_type: ["dbId", "target", "decl"],
		make_function: ["dbId", "target"],
		exec: ["dbId", "code"],
	};
	if (!a || !Object.hasOwn(fields, a)) throw Error("Invalid IDA action");
	const row = obj(value);
	for (const k of fields[a]!) {
		if (k === "save" || k === "repeatable") {
			if (typeof row[k] !== "boolean") throw Error("Invalid IDA flag");
		} else text(row[k], k === "code" ? 65536 : k === "text" ? 16384 : 4096, k === "text");
	}
}
export function validateIdaOperation(value: unknown): asserts value is IdaOperation {
	const kind = (value as { kind?: string })?.kind;
	if (!kind || !isIdaKind(kind)) throw Error("Invalid IDA operation");
	const r = obj(value);
	text(r.sessionId, 512);
	if (kind === "ida.prepare") validateIdaEdit(r.edit);
	if (kind === "ida.commit") text(r.token, 128);
	if (kind === "ida.view") {
		text(r.dbId);
		text(r.identity, 128);
		num(r.version);
		if (!IDA_VIEWS.includes(r.view as IdaView)) throw Error("Invalid IDA view");
		if (r.target !== undefined) text(r.target);
		if (r.offset !== undefined) num(r.offset);
	}
}
