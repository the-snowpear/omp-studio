export type GcCategory = "blobs" | "archive" | "wal" | "stale";
export interface GcPolicy {
	coldDays: number;
	keepGlobal: number;
	keepPerWorkspace: number;
	staleDays: number;
	staleKeep: number;
}
export interface GcSummary {
	applied: boolean;
	checkedAt: number;
	policy: GcPolicy;
	rows: Array<{ category: GcCategory; candidates: number; changed: number; bytes: number; skippedActive: number }>;
	errors: string[];
}
export interface GcPreview {
	token: string;
	expiresAt: number;
	summary: GcSummary;
}
export interface GcStatus {
	phase: "idle" | "previewing" | "applying" | "complete" | "failed";
	preview?: GcPreview;
	summary?: GcSummary;
	error?: string;
}
export interface SessionExportResult {
	format: "archive" | "html";
	members: number;
	warnings: string[];
	id: string;
	createdAt: number;
	asset: { artifactId: string; kind: "export"; name: string; mimeType: string; bytes: number; sha256: string };
}
export interface SessionExportStatus {
	phase: "idle" | "exporting" | "complete" | "failed";
	result?: SessionExportResult;
	error?: string;
}
export interface NativeConnectionCheck {
	checkedAt: number;
	checks: Array<{ id: "bridge" | "session" | "model"; status: "ok" | "warning" | "error"; detail: string }>;
}
export type MaintenanceOperation =
	| { kind: "maintenance.gc.preview"; sessionId: string; categories: GcCategory[] }
	| { kind: "maintenance.gc.apply"; sessionId: string; token: string }
	| { kind: "maintenance.gc.status"; sessionId: string }
	| { kind: "maintenance.session.export"; sessionId: string; format?: "archive" | "html" }
	| { kind: "maintenance.export.status"; sessionId: string }
	| { kind: "maintenance.connection.check"; sessionId: string };
export interface MaintenanceResultMap {
	"maintenance.gc.preview": GcPreview;
	"maintenance.gc.apply": GcSummary;
	"maintenance.gc.status": GcStatus;
	"maintenance.session.export": SessionExportResult;
	"maintenance.export.status": SessionExportStatus;
	"maintenance.connection.check": NativeConnectionCheck;
}
export const MAINTENANCE_OPERATION_KINDS = [
	"maintenance.gc.preview",
	"maintenance.gc.apply",
	"maintenance.gc.status",
	"maintenance.session.export",
	"maintenance.export.status",
	"maintenance.connection.check",
] as const;
export const MAINTENANCE_READ_KINDS = [
	"maintenance.gc.preview",
	"maintenance.gc.status",
	"maintenance.export.status",
	"maintenance.connection.check",
] as const;
export function isMaintenanceKind(kind: string): kind is MaintenanceOperation["kind"] {
	return (MAINTENANCE_OPERATION_KINDS as readonly string[]).includes(kind);
}
const CATEGORIES = ["blobs", "archive", "wal", "stale"];
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw new Error("Invalid maintenance data");
	return value as Record<string, unknown>;
}
function text(value: unknown, limit = 1024): void {
	if (typeof value !== "string" || !value.length || value.length > limit || value.includes("\0"))
		throw new Error("Invalid maintenance text");
}
function integer(value: unknown): void {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid maintenance number");
}
function summary(value: unknown): void {
	const row = record(value, ["applied", "checkedAt", "policy", "rows", "errors"]);
	if (typeof row.applied !== "boolean") throw new Error("Invalid cleanup state");
	integer(row.checkedAt);
	const policy = record(row.policy, ["coldDays", "keepGlobal", "keepPerWorkspace", "staleDays", "staleKeep"]);
	for (const key of ["coldDays", "keepGlobal", "keepPerWorkspace", "staleDays", "staleKeep"]) integer(policy[key]);
	if (!Array.isArray(row.rows) || row.rows.length > 4 || !Array.isArray(row.errors) || row.errors.length > 20)
		throw new Error("Invalid cleanup result");
	row.errors.forEach(error => text(error));
	for (const item of row.rows) {
		const metric = record(item, ["category", "candidates", "changed", "bytes", "skippedActive"]);
		if (!CATEGORIES.includes(metric.category as string)) throw new Error("Unknown cleanup category");
		for (const key of ["candidates", "changed", "bytes", "skippedActive"]) integer(metric[key]);
	}
}
function preview(value: unknown): void {
	const row = record(value, ["token", "expiresAt", "summary"]);
	text(row.token, 128);
	integer(row.expiresAt);
	summary(row.summary);
}
function exported(value: unknown): void {
	const row = record(value, ["id", "createdAt", "asset", "format", "members", "warnings"]);
	if (!["archive", "html"].includes(row.format as string)) throw new Error("Invalid export format");
	integer(row.members);
	if (!Array.isArray(row.warnings) || row.warnings.length > 20) throw new Error("Invalid export warnings");
	row.warnings.forEach(item => text(item));
	text(row.id, 128);
	integer(row.createdAt);
	const asset = record(row.asset, ["artifactId", "kind", "name", "mimeType", "bytes", "sha256"]);
	if (
		asset.kind !== "export" ||
		!/^[a-f0-9-]{36}$/.test(asset.artifactId as string) ||
		!/^[a-f0-9]{64}$/.test(asset.sha256 as string)
	)
		throw new Error("Invalid export artifact");
	text(asset.name, 256);
	text(asset.mimeType, 100);
	integer(asset.bytes);
	if ((asset.bytes as number) > 67108864 || /[\\/]/.test(asset.name as string))
		throw new Error("Export exceeds limit");
}
export function validateMaintenanceOperation(value: unknown): void {
	const row = record(value, ["kind", "sessionId", "categories", "token", "format"]);
	if (
		row.format !== undefined &&
		(row.kind !== "maintenance.session.export" || !["archive", "html"].includes(row.format as string))
	)
		throw new Error("Invalid export format");
	if (typeof row.kind !== "string" || !isMaintenanceKind(row.kind)) throw new Error("Unknown maintenance command");
	text(row.sessionId, 128);
	if (row.kind === "maintenance.gc.preview") {
		if (
			!Array.isArray(row.categories) ||
			!row.categories.length ||
			row.categories.length > 4 ||
			new Set(row.categories).size !== row.categories.length ||
			row.categories.some(cat => !CATEGORIES.includes(cat as string))
		)
			throw new Error("Choose cleanup categories");
	} else if (row.categories !== undefined) throw new Error("Unexpected categories");
	if (row.kind === "maintenance.gc.apply") text(row.token, 128);
	else if (row.token !== undefined) throw new Error("Unexpected cleanup token");
}
export function validateMaintenanceResult(kind: MaintenanceOperation["kind"], value: unknown): void {
	if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32768)
		throw new Error("Maintenance result exceeds limit");
	if (kind === "maintenance.gc.preview") {
		preview(value);
		return;
	}
	if (kind === "maintenance.gc.apply") {
		summary(value);
		return;
	}
	if (kind === "maintenance.session.export") {
		exported(value);
		return;
	}
	if (kind === "maintenance.connection.check") {
		const row = record(value, ["checkedAt", "checks"]);
		integer(row.checkedAt);
		if (!Array.isArray(row.checks) || row.checks.length > 3) throw new Error("Invalid connection checks");
		for (const item of row.checks) {
			const check = record(item, ["id", "status", "detail"]);
			if (
				!["bridge", "session", "model"].includes(check.id as string) ||
				!["ok", "warning", "error"].includes(check.status as string)
			)
				throw new Error("Invalid connection status");
			text(check.detail);
		}
		return;
	}
	if (kind === "maintenance.export.status") {
		const row = record(value, ["phase", "result", "error"]);
		if (!["idle", "exporting", "complete", "failed"].includes(row.phase as string))
			throw new Error("Invalid export status");
		if (row.result !== undefined) exported(row.result);
		if (row.error !== undefined) text(row.error);
		return;
	}
	const row = record(value, ["phase", "preview", "summary", "error"]);
	if (!["idle", "previewing", "applying", "complete", "failed"].includes(row.phase as string))
		throw new Error("Invalid cleanup status");
	if (row.preview !== undefined) preview(row.preview);
	if (row.summary !== undefined) summary(row.summary);
	if (row.error !== undefined) text(row.error);
}
