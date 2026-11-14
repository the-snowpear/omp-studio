import {
	AGENT_BTW_KINDS,
	isAgentBtwKind,
	validateAgentBtwOperation,
	type AgentBtwOperation,
	type AgentBtwResultMap,
} from "./agent-btw-protocol";
import { IDA_KINDS, isIdaKind, validateIdaOperation, type IdaOperation, type IdaResultMap } from "./ida-protocol";
import { validateResourceOperation, type ResourceOperation, type ResourcePage } from "./resources-protocol";
export type SessionTier = "standard" | "slow" | "priority" | "ultrafast";
export interface SessionTierState {
	selector: string;
	configured: string;
	effective: SessionTier;
	choices: Array<{ id: SessionTier; available: boolean; reason?: string }>;
	usageStatus?: string;
}
export interface SessionQueueItem {
	id: string;
	queue: "steering" | "followUp";
	state: "pending" | "delivering" | "recovering";
	text: string;
	imageCount: number;
}
export interface SessionQueueSnapshot {
	sessionId: string;
	items: SessionQueueItem[];
	total: number;
	followUpMode: "all" | "one-at-a-time";
	steeringMode: "all" | "one-at-a-time";
}
export interface QueueImageAsset {
	artifactId: string;
	kind: "image";
	name: string;
	mimeType: string;
	bytes: number;
	sha256: string;
}
export interface QueueTakeback {
	recoveryId?: string;
	removed: boolean;
	text?: string;
	images: QueueImageAsset[];
}
export interface RuntimeSkillIdentity {
	id: string;
	name: string;
	description: string;
	namespace?: string;
	source: string;
	scope?: "workspace" | "global" | "builtin" | "runtime";
	conflict: boolean;
}
export type SessionGuiOperation =
	| ResourceOperation
	| IdaOperation
	| AgentBtwOperation
	| { kind: "prediction.control"; sessionId: string; action: PredictionControlAction }
	| { kind: "session.queue.list"; sessionId: string; offset?: number }
	| { kind: "session.queue.steer"; sessionId: string; id: string }
	| { kind: "session.queue.remove"; sessionId: string; id: string }
	| { kind: "session.queue.ack"; sessionId: string; id: string }
	| { kind: "session.queue.takeback"; sessionId: string; id: string }
	| { kind: "session.tier.get"; sessionId: string }
	| { kind: "session.tier.set"; sessionId: string; selector: string; tier: SessionTier }
	| { kind: "session.skills.list"; sessionId: string };
export interface SessionGuiResultMap extends AgentBtwResultMap, IdaResultMap {
	"resource.read": ResourcePage;
	"prediction.control": PredictionControlState;
	"session.queue.list": SessionQueueSnapshot;
	"session.queue.remove": { removed: boolean };
	"session.queue.steer": { removed: boolean };
	"session.queue.ack": { removed: boolean };
	"session.queue.takeback": QueueTakeback;
	"session.tier.get": SessionTierState;
	"session.tier.set": SessionTierState;
	"session.skills.list": { skills: RuntimeSkillIdentity[]; warnings: string[] };
}
export const SESSION_GUI_KINDS = [
	"resource.read",
	...IDA_KINDS,
	...AGENT_BTW_KINDS,
	"prediction.control",
	"session.queue.list",
	"session.queue.ack",
	"session.queue.remove",
	"session.queue.steer",
	"session.queue.takeback",
	"session.tier.get",
	"session.tier.set",
	"session.skills.list",
] as const;
export const SESSION_GUI_READ_KINDS = [
	"resource.read",
	"ida.status",
	"ida.view",
	"ida.prepare",
	"ida.cancel",
	"agent.btw.read",
	"session.queue.list",
	"session.tier.get",
	"session.skills.list",
] as const;
export function isSessionGuiKind(kind: string): kind is SessionGuiOperation["kind"] {
	return (SESSION_GUI_KINDS as readonly string[]).includes(kind);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid session GUI object");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096, empty = false): void {
	if (typeof value !== "string" || (!empty && !value.length) || value.length > max || value.includes("\0"))
		throw Error("Invalid session GUI text");
}
function number(value: unknown): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw Error("Invalid session GUI count");
}
function tier(value: unknown): void {
	if (!["standard", "slow", "priority", "ultrafast"].includes(value as string)) throw Error("Invalid session tier");
}
export function validateSessionGuiOperation(value: unknown): asserts value is SessionGuiOperation {
	if ((value as { kind?: string })?.kind === "resource.read") {
		validateResourceOperation(value);
		return;
	}
	if (isIdaKind((value as { kind?: string })?.kind ?? "")) {
		validateIdaOperation(value);
		return;
	}
	if (isAgentBtwKind((value as { kind?: string })?.kind ?? "")) {
		validateAgentBtwOperation(value);
		return;
	}
	if ((value as { kind?: string })?.kind === "prediction.control") {
		const row = object(value);
		text(row.sessionId, 512);
		if (!["status", "clear", "import", "download", "cancel"].includes(row.action as string))
			throw Error("Invalid prediction action");
		return;
	}
	const kind = (value as { kind?: unknown })?.kind;
	if (typeof kind !== "string" || !isSessionGuiKind(kind)) throw Error("Invalid session GUI operation");
	const row = object(value);
	text(row.sessionId, 512);
	if (kind === "session.tier.set") {
		text(row.selector);
		tier(row.tier);
	}
	if (
		kind === "session.queue.ack" ||
		kind === "session.queue.steer" ||
		kind === "session.queue.remove" ||
		kind === "session.queue.takeback"
	)
		text(row.id, 128);
	if (row.offset !== undefined) {
		number(row.offset);
		if ((row.offset as number) > 100000) throw Error("Queue offset exceeds budget");
	}
}
import type { PredictionControlAction, PredictionControlState } from "./prediction-protocol";
