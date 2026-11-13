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
 format: "archive" | "html"; members: number; warnings: string[];
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
export interface AutoCompressionStatus { enabled: boolean; ranAt?: number; log: string; }
export type MaintenanceOperation =
	| { kind: "maintenance.compression.auto.status"; sessionId: string }
	| { kind: "maintenance.gc.preview"; sessionId: string; categories: GcCategory[] }
	| { kind: "maintenance.gc.apply"; sessionId: string; token: string }
	| { kind: "maintenance.gc.status"; sessionId: string }
	| { kind: "maintenance.session.export"; sessionId: string; format?: "archive" | "html" }
	| { kind: "maintenance.export.status"; sessionId: string }
	| { kind: "maintenance.connection.check"; sessionId: string };
export interface MaintenanceResultMap {
	"maintenance.compression.auto.status": AutoCompressionStatus;
	"maintenance.gc.preview": GcPreview;
	"maintenance.gc.apply": GcSummary;
	"maintenance.gc.status": GcStatus;
	"maintenance.session.export": SessionExportResult;
	"maintenance.export.status": SessionExportStatus;
	"maintenance.connection.check": NativeConnectionCheck;
}
export const MAINTENANCE_OPERATION_KINDS = [
	"maintenance.compression.auto.status",
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
