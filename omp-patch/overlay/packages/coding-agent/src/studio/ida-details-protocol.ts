export interface StudioIdaDatabase {
	id: string;
	ref: string;
	name: string;
	path: string;
	state: "opening" | "open";
	module: string;
	format: string;
	arch: string;
	bitness: number;
	busy: boolean;
	dirty: boolean;
	current?: { method: string; startedAt: number };
}
export interface StudioIdaStatus {
	enabled: boolean;
	installDir: string;
	python: string;
	detectedInstall?: string;
	detectedPython?: string;
	available: boolean;
	reason?: string;
	databases: StudioIdaDatabase[];
}
export type StudioIdaOperation =
	| { kind: "ida.status.details"; sessionId: string }
	| { kind: "ida.configure"; sessionId: string; enabled: boolean; installDir: string; python: string }
	| { kind: "ida.open"; sessionId: string; path: string }
	| { kind: "ida.save"; sessionId: string; id: string }
	| { kind: "ida.close"; sessionId: string; id: string }
	| { kind: "ida.run"; sessionId: string; id: string; code: string; timeoutMs: number }
	| { kind: "ida.database.cancel"; sessionId: string; id: string };
export interface StudioIdaResultMap {
	"ida.status.details": StudioIdaStatus;
	"ida.configure": StudioIdaStatus;
	"ida.open": { database: StudioIdaDatabase };
	"ida.save": { saved: true; backup: string };
	"ida.close": { closed: true; backup: string };
	"ida.run": {
		output: string;
		value: string | null;
		error: string | null;
		truncated: boolean;
		backup: string;
		resultFile: string;
	};
	"ida.database.cancel": { cancelled: boolean };
}
export const IDA_OPERATION_KINDS = [
	"ida.status.details",
	"ida.configure",
	"ida.open",
	"ida.save",
	"ida.close",
	"ida.run",
	"ida.database.cancel",
] as const;
export function isIdaOperationKind(kind: string): kind is StudioIdaOperation["kind"] {
	return (IDA_OPERATION_KINDS as readonly string[]).includes(kind);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid IDA payload");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): void {
	if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error("Invalid IDA text");
}
function bool(value: unknown): void {
	if (typeof value !== "boolean") throw new Error("Invalid IDA boolean");
}
function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error("Invalid IDA number");
}
export function validateStudioIdaOperation(value: unknown): void {
	const input = object(value);
	if (typeof input.kind !== "string" || !isIdaOperationKind(input.kind)) throw new Error("Unknown IDA operation");
	text(input.sessionId, 512);
	if (!input.sessionId) throw new Error("Session identity required");
	const fields =
		input.kind === "ida.status.details"
			? []
			: input.kind === "ida.configure"
				? ["enabled", "installDir", "python"]
				: input.kind === "ida.open"
					? ["path"]
					: input.kind === "ida.run"
						? ["id", "code", "timeoutMs"]
						: ["id"];
	for (const field of fields) {
		if (field === "enabled") bool(input[field]);
		else if (field === "timeoutMs") number(input[field], 100, 300_000);
		else text(input[field], field === "code" ? 65536 : 4096);
	}
	if (
		(fields.includes("id") && !input.id) ||
		(fields.includes("path") && !input.path) ||
		(fields.includes("code") && !input.code)
	)
		throw new Error("IDA target or code is empty");
}
