export type PredictionMethod = "off" | "auto" | "ngram" | "smollm" | "apple";
export interface PredictionSettings {
	method: PredictionMethod;
	effective: "off" | "ngram" | "smollm" | "apple";
	source: string;
	download: {
		state: "idle" | "downloading" | "ready" | "failed" | "cancelled";
		bytes: number;
		total: number;
		error?: string;
	};
}
export interface PredictionChannel {
	protocolVersion?: 2;
	channelId: string;
	sessionId: string;
	expiresAt: number;
}
export type PredictionChannelOperation =
	| { kind: "prediction.status"; sessionId: string }
	| {
			kind: "prediction.configure";
			sessionId: string;
			method: PredictionMethod;
			scope: "session" | "global";
	  }
	| { kind: "prediction.clearOverride"; sessionId: string }
	| { kind: "prediction.download.cancel"; sessionId: string }
	| { kind: "prediction.prepare"; sessionId: string; protocolVersion?: 2 }
	| { kind: "prediction.release"; sessionId: string; channelId: string };
export interface PredictionResultMap {
	"prediction.status": PredictionSettings;
	"prediction.configure": PredictionSettings;
	"prediction.clearOverride": PredictionSettings;
	"prediction.download.cancel": PredictionSettings;
	"prediction.prepare": PredictionChannel;
	"prediction.release": { released: true };
}
export const PREDICTION_KINDS = [
	"prediction.status",
	"prediction.configure",
	"prediction.clearOverride",
	"prediction.download.cancel",
	"prediction.prepare",
	"prediction.release",
] as const;
export function isPredictionKind(kind: string): kind is PredictionChannelOperation["kind"] {
	return (PREDICTION_KINDS as readonly string[]).includes(kind);
}
export type PredictionInput =
	| { kind: "next"; revision: number; empty: boolean; text?: string }
	| { kind: "next.shown"; revision: number }
	| { kind: "next.accepted"; revision: number; rank: number }
	| { kind: "update"; revision: number; text: string; caret: number }
	| { kind: "feedback"; revision: number; accepted: boolean }
	| { kind: "ping" }
	| { kind: "import"; requestId: string; transferId: string };
export type PredictionEvent =
	| {
			kind: "next";
			channelId: string;
			revision: number;
			suffix: string | null;
			choices?: readonly string[];
			rank?: number;
	  }
	| {
			kind: "suggestion";
			channelId: string;
			revision: number;
			suffix: string | null;
	  }
	| { kind: "error"; channelId: string; message: string; requestId?: string }
	| { kind: "closed"; channelId: string }
	| {
			kind: "imported";
			channelId: string;
			requestId: string;
			count: number;
			truncated: boolean;
	  };
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid prediction data");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024, empty = false): void {
	if (typeof value !== "string" || (!empty && !value) || value.length > max || value.includes("\0"))
		throw new Error("Invalid prediction text");
}
function id(value: unknown): void {
	if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new Error("Invalid prediction identity");
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max)
		throw new Error("Invalid prediction number");
}
export function validatePredictionChannelOperation(value: unknown): void {
	const row = object(value);
	if (typeof row.kind !== "string" || !isPredictionKind(row.kind)) throw new Error("Unknown prediction command");
	text(row.sessionId, 128);
	if (row.kind === "prediction.configure") {
		if (
			!["off", "auto", "ngram", "smollm", "apple"].includes(row.method as string) ||
			!["session", "global"].includes(row.scope as string)
		)
			throw new Error("Invalid prediction settings");
	} else if (row.method !== undefined || row.scope !== undefined) throw new Error("Unexpected prediction setting");
	if (row.kind === "prediction.release") id(row.channelId);
	else if (row.channelId !== undefined) throw new Error("Unexpected prediction channel");
}
export function validatePredictionInput(value: unknown): asserts value is PredictionInput {
	const row = object(value);
	switch (row.kind) {
		case "next":
			integer(row.revision);
			if (typeof row.empty !== "boolean") throw new Error("Invalid next-message state");
			break;
		case "next.shown":
			integer(row.revision);
			break;
		case "next.accepted":
			integer(row.revision);
			integer(row.rank, 3);
			break;
		case "update":
			integer(row.revision);
			text(row.text, 4096, true);
			integer(row.caret, (row.text as string).length);
			break;
		case "feedback":
			integer(row.revision);
			if (typeof row.accepted !== "boolean") throw new Error("Invalid prediction feedback");
			break;
		case "ping":
			break;
		case "import":
			id(row.requestId);
			id(row.transferId);
			break;
		default:
			throw new Error("Invalid prediction message");
	}
}
