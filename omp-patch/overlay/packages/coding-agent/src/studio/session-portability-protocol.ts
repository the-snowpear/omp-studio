export interface PortableAsset {
	artifactId: string;
	kind: "export";
	name: string;
	mimeType: string;
	bytes: number;
	sha256: string;
}
export interface PortableExport {
	id: string;
	format: "pack" | "anonymous";
	asset: PortableAsset;
	warnings: string[];
	members: number;
}
export interface SessionImportPreview {
	token: string;
	expiresAt: number;
	sourceSessionId: string;
	title: string;
	sourceDirectory: string;
	destinationDirectory: string;
	upstreamVersion: string;
	messages: number;
	artifacts: number;
	blobs: number;
	conflicts: boolean;
}
export interface SessionPortabilityStatus {
	phase: "idle" | "preparing" | "exporting" | "importing" | "complete" | "failed";
	preview?: SessionImportPreview;
	exported?: PortableExport;
	imported?: { sessionId: string; mode: "created" | "forked"; workspaceId?: string; cwd?: string };
	error?: string;
}
export type SessionPortabilityOperation =
	| { kind: "session.portability.pack"; sessionId: string; targetSessionId: string }
	| { kind: "session.portability.anonymize"; sessionId: string; targetSessionId: string }
	| {
			kind: "session.portability.prepare";
			sessionId: string;
			artifactId: string;
			targetWorkspaceId?: string;
			targetCwd?: string;
			inputTransfers?: Array<{ artifactId: string; transferId: string }>;
	  }
	| { kind: "session.portability.import"; sessionId: string; token: string }
	| { kind: "session.portability.cancel"; sessionId: string; token: string }
	| { kind: "session.portability.moved"; sessionId: string; targetSessionId: string; label: string }
	| { kind: "session.portability.status"; sessionId: string };
export interface SessionPortabilityResultMap {
	"session.portability.pack": PortableExport;
	"session.portability.anonymize": PortableExport;
	"session.portability.prepare": SessionImportPreview;
	"session.portability.import": { sessionId: string; mode: "created" | "forked"; workspaceId?: string; cwd?: string };
	"session.portability.cancel": { cancelled: true };
	"session.portability.moved": { marked: true };
	"session.portability.status": SessionPortabilityStatus;
}
export const SESSION_PORTABILITY_KINDS = [
	"session.portability.pack",
	"session.portability.anonymize",
	"session.portability.prepare",
	"session.portability.import",
	"session.portability.cancel",
	"session.portability.moved",
	"session.portability.status",
] as const;
export function isSessionPortabilityKind(kind: string): kind is SessionPortabilityOperation["kind"] {
	return (SESSION_PORTABILITY_KINDS as readonly string[]).includes(kind);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw Error("Invalid session transfer data");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024): void {
	if (typeof value !== "string" || !value || value.length > max || value.includes("\0"))
		throw Error("Invalid session transfer text");
}
function identity(value: unknown): void {
	text(value, 128);
	if (!/^[a-zA-Z0-9_-]+$/u.test(value as string)) throw Error("Invalid session identity");
}
function uuid(value: unknown): void {
	text(value, 36);
	if (!/^[a-f0-9-]{36}$/u.test(value as string)) throw Error("Invalid transfer identity");
}
function count(value: unknown): void {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw Error("Invalid transfer count");
}
export function validateSessionPortabilityOperation(value: unknown): void {
	const row = object(value, [
		"kind",
		"sessionId",
		"targetSessionId",
		"artifactId",
		"targetWorkspaceId",
		"targetCwd",
		"inputTransfers",
		"token",
		"label",
	]);
	if (typeof row.kind !== "string" || !isSessionPortabilityKind(row.kind))
		throw Error("Unknown session transfer operation");
	identity(row.sessionId);
	if (row.kind === "session.portability.prepare") {
		object(value, ["kind", "sessionId", "artifactId", "targetWorkspaceId", "targetCwd", "inputTransfers"]);
		uuid(row.artifactId);
		if (row.targetWorkspaceId !== undefined) text(row.targetWorkspaceId, 512);
		if (row.targetCwd !== undefined) text(row.targetCwd, 4096);
		if (row.inputTransfers !== undefined) {
			if (!Array.isArray(row.inputTransfers) || row.inputTransfers.length !== 1)
				throw Error("One archive transfer is required");
			const grant = object(row.inputTransfers[0], ["artifactId", "transferId"]);
			uuid(grant.artifactId);
			uuid(grant.transferId);
			if (grant.artifactId !== row.artifactId) throw Error("Archive transfer mismatch");
		}
	} else if (row.kind === "session.portability.status") object(value, ["kind", "sessionId"]);
	else if (row.kind === "session.portability.import" || row.kind === "session.portability.cancel") {
		object(value, ["kind", "sessionId", "token"]);
		uuid(row.token);
	} else {
		object(
			value,
			row.kind === "session.portability.moved"
				? ["kind", "sessionId", "targetSessionId", "label"]
				: ["kind", "sessionId", "targetSessionId"],
		);
		identity(row.targetSessionId);
		if (row.kind === "session.portability.moved") text(row.label, 256);
	}
}
function exported(value: unknown): void {
	const row = object(value, ["id", "format", "asset", "warnings", "members"]);
	uuid(row.id);
	count(row.members);
	if (
		!["pack", "anonymous"].includes(row.format as string) ||
		!Array.isArray(row.warnings) ||
		row.warnings.length > 20
	)
		throw Error("Invalid transfer export");
	row.warnings.forEach(item => text(item));
	const asset = object(row.asset, ["artifactId", "kind", "name", "mimeType", "bytes", "sha256"]);
	uuid(asset.artifactId);
	text(asset.name, 256);
	text(asset.mimeType, 100);
	count(asset.bytes);
	if (
		asset.kind !== "export" ||
		!/^[a-f0-9]{64}$/u.test(asset.sha256 as string) ||
		/[\\/]/u.test(asset.name as string) ||
		(asset.bytes as number) > 67108864
	)
		throw Error("Invalid export asset");
}
function preview(value: unknown): void {
	const row = object(value, [
		"token",
		"expiresAt",
		"sourceSessionId",
		"title",
		"sourceDirectory",
		"destinationDirectory",
		"upstreamVersion",
		"messages",
		"artifacts",
		"blobs",
		"conflicts",
	]);
	uuid(row.token);
	identity(row.sourceSessionId);
	count(row.expiresAt);
	for (const key of ["title", "sourceDirectory", "destinationDirectory", "upstreamVersion"]) text(row[key], 4096);
	for (const key of ["messages", "artifacts", "blobs"]) count(row[key]);
	if (typeof row.conflicts !== "boolean") throw Error("Invalid import conflict state");
}
function imported(value: unknown): void {
	const row = object(value, ["sessionId", "mode", "workspaceId", "cwd"]);
	identity(row.sessionId);
	if (!["created", "forked"].includes(row.mode as string)) throw Error("Import must preserve existing sessions");
	if (row.workspaceId !== undefined) text(row.workspaceId, 512);
	if (row.cwd !== undefined) text(row.cwd, 4096);
}
export function validateSessionPortabilityResult(kind: SessionPortabilityOperation["kind"], value: unknown): void {
	if (JSON.stringify(value).length > 32768) throw Error("Session transfer result exceeds limit");
	if (kind === "session.portability.pack" || kind === "session.portability.anonymize") {
		exported(value);
		return;
	}
	if (kind === "session.portability.prepare") {
		preview(value);
		return;
	}
	if (kind === "session.portability.import") {
		imported(value);
		return;
	}
	if (kind === "session.portability.cancel") {
		if (object(value, ["cancelled"]).cancelled !== true) throw Error("Invalid cancellation");
		return;
	}
	if (kind === "session.portability.moved") {
		if (object(value, ["marked"]).marked !== true) throw Error("Invalid move marker");
		return;
	}
	const row = object(value, ["phase", "preview", "exported", "imported", "error"]);
	if (!["idle", "preparing", "exporting", "importing", "complete", "failed"].includes(row.phase as string))
		throw Error("Invalid transfer phase");
	if (row.preview !== undefined) preview(row.preview);
	if (row.exported !== undefined) exported(row.exported);
	if (row.imported !== undefined) imported(row.imported);
	if (row.error !== undefined) text(row.error);
}
