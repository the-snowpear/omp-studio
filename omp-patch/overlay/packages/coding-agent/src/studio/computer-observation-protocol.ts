export interface StudioComputerTarget {
	id: string;
	kind: "display" | "window";
	name: string;
	width: number;
	height: number;
}
export interface StudioComputerStatus {
	enabled: boolean;
	available: boolean;
	backend: string;
	capturePermission: string;
	inputPermission: string;
	axPermission: string;
	running: number;
	targets: StudioComputerTarget[];
	reason?: string;
}
export interface StudioComputerCapture {
	captureId: string;
	sessionId: string;
	targetId: string;
	width: number;
	height: number;
	expiresAt: number;
}
export type ComputerObservationOperation =
	| { kind: "computer.status"; sessionId: string }
	| { kind: "computer.configure"; sessionId: string; enabled: boolean }
	| { kind: "computer.capture"; sessionId: string; targetId: string }
	| { kind: "computer.stop"; sessionId: string }
	| { kind: "computer.observe.release"; sessionId: string };
export interface ComputerObservationResultMap {
	"computer.status": StudioComputerStatus;
	"computer.configure": { enabled: boolean };
	"computer.capture": StudioComputerCapture;
	"computer.stop": { stopped: true };
	"computer.observe.release": { released: true };
}
export const COMPUTER_OBSERVATION_KINDS = [
	"computer.status",
	"computer.configure",
	"computer.capture",
	"computer.stop",
	"computer.observe.release",
] as const;
export function isComputerObservationKind(kind: string): kind is ComputerObservationOperation["kind"] {
	return (COMPUTER_OBSERVATION_KINDS as readonly string[]).includes(kind);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw new Error("Invalid computer observation payload");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): void {
	if (typeof value !== "string" || value.length > max || value.includes("\0"))
		throw new Error("Invalid computer observation text");
}
function bool(value: unknown): void {
	if (typeof value !== "boolean") throw new Error("Invalid computer observation boolean");
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
		throw new Error("Invalid computer observation number");
}
export function validateComputerObservationOperation(value: unknown): void {
	const row = object(value, ["kind", "sessionId", "enabled", "targetId"]);
	if (typeof row.kind !== "string" || !isComputerObservationKind(row.kind))
		throw new Error("Unknown computer observation operation");
	text(row.sessionId, 512);
	if (!row.sessionId) throw new Error("Session identity required");
	if (row.kind === "computer.configure") {
		object(row, ["kind", "sessionId", "enabled"]);
		bool(row.enabled);
	} else if (row.kind === "computer.capture") {
		object(row, ["kind", "sessionId", "targetId"]);
		text(row.targetId, 1024);
		if (!row.targetId) throw new Error("Target required");
	} else object(row, ["kind", "sessionId"]);
}
export function validateComputerObservationResult(kind: ComputerObservationOperation["kind"], value: unknown): void {
	if (kind === "computer.configure") {
		bool(object(value, ["enabled"]).enabled);
		return;
	}
	if (kind === "computer.stop" || kind === "computer.observe.release") {
		const flag = kind === "computer.stop" ? "stopped" : "released";
		if (object(value, [flag])[flag] !== true) throw new Error("Computer operation did not complete");
		return;
	}
	if (kind === "computer.capture") {
		const row = object(value, ["captureId", "sessionId", "targetId", "width", "height", "expiresAt"]);
		text(row.captureId, 36);
		if (!/^[a-f0-9-]{36}$/u.test(row.captureId as string)) throw new Error("Invalid capture id");
		text(row.sessionId, 512);
		text(row.targetId, 1024);
		number(row.width, 4096);
		number(row.height, 4096);
		number(row.expiresAt);
		return;
	}
	const row = object(value, [
		"enabled",
		"available",
		"backend",
		"capturePermission",
		"inputPermission",
		"axPermission",
		"running",
		"targets",
		"reason",
	]);
	bool(row.enabled);
	bool(row.available);
	number(row.running, 10000);
	for (const key of ["backend", "capturePermission", "inputPermission", "axPermission"]) text(row[key], 128);
	if (row.reason !== undefined) text(row.reason);
	if (!Array.isArray(row.targets) || row.targets.length > 256) throw new Error("Too many computer targets");
	for (const item of row.targets) {
		const target = object(item, ["id", "kind", "name", "width", "height"]);
		text(target.id, 1024);
		text(target.name);
		if (target.kind !== "display" && target.kind !== "window") throw new Error("Invalid target kind");
		number(target.width, 100000);
		number(target.height, 100000);
	}
}
