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
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid session transfer data");
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
export function validateSessionPortabilityOperation(value: unknown): void {
	const row = object(value);
	if (typeof row.kind !== "string" || !isSessionPortabilityKind(row.kind))
		throw Error("Unknown session transfer operation");
	identity(row.sessionId);
	if (row.kind === "session.portability.prepare") {
		uuid(row.artifactId);
		if (row.targetWorkspaceId !== undefined) text(row.targetWorkspaceId, 512);
		if (row.targetCwd !== undefined) text(row.targetCwd, 4096);
		if (row.inputTransfers !== undefined) {
			if (!Array.isArray(row.inputTransfers) || row.inputTransfers.length !== 1)
				throw Error("One archive transfer is required");
			const grant = object(row.inputTransfers[0]);
			uuid(grant.artifactId);
			uuid(grant.transferId);
			if (grant.artifactId !== row.artifactId) throw Error("Archive transfer mismatch");
		}
	} else if (row.kind === "session.portability.status") {
		// No fields beyond the session identity.
	} else if (row.kind === "session.portability.import" || row.kind === "session.portability.cancel") {
		uuid(row.token);
	} else {
		identity(row.targetSessionId);
		if (row.kind === "session.portability.moved") text(row.label, 256);
	}
}
