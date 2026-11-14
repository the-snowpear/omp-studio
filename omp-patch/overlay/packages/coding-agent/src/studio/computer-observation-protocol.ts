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
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
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
export function validateComputerObservationOperation(value: unknown): void {
	const row = object(value);
	if (typeof row.kind !== "string" || !isComputerObservationKind(row.kind))
		throw new Error("Unknown computer observation operation");
	text(row.sessionId, 512);
	if (!row.sessionId) throw new Error("Session identity required");
	if (row.kind === "computer.configure") {
		bool(row.enabled);
	} else if (row.kind === "computer.capture") {
		text(row.targetId, 1024);
		if (!row.targetId) throw new Error("Target required");
	}
}
