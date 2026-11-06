import type { BtwSnapshot } from "./btw.js";
import type { BtwHistoryTurn, BtwImage, BtwTopicSummary } from "./runtime-upgrade.js";

/** Child BTW is bound to its target incarnation and never uses the main BTW slot. */
export type AgentBtwOperation =
 | { kind: "agent.btw.read"; sessionId: string; agentId: string; binding?: string; topicId?: string }
 | { kind: "agent.btw.ask"; sessionId: string; agentId: string; binding: string; question: string; topicId?: string; images?: BtwImage[] }
 | { kind: "agent.btw.abort"; sessionId: string; agentId: string; binding: string; ephemeralId: string };
export interface AgentBtwState {
 binding: string; agentId: string; targetSessionId: string;
 snapshot: BtwSnapshot | null;
 topics: BtwTopicSummary[];
 turns: BtwHistoryTurn[];
}
export interface AgentBtwResultMap { "agent.btw.read": AgentBtwState; "agent.btw.ask": AgentBtwState; "agent.btw.abort": AgentBtwState }
export const AGENT_BTW_KINDS = ["agent.btw.read", "agent.btw.ask", "agent.btw.abort"] as const;
export function isAgentBtwKind(kind: string): kind is AgentBtwOperation["kind"] { return (AGENT_BTW_KINDS as readonly string[]).includes(kind); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error("Invalid child BTW fields");
 return value as Record<string, unknown>;
}
function text(value: unknown, max = 512): void {
 if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw Error("Invalid child BTW text");
}
export function validateAgentBtwOperation(value: unknown): asserts value is AgentBtwOperation {
 const kind = (value as { kind?: unknown })?.kind;
 if (typeof kind !== "string" || !isAgentBtwKind(kind)) throw Error("Invalid child BTW operation");
 const row = object(value, ["kind", "sessionId", "agentId", "binding", ...(kind === "agent.btw.abort" ? ["ephemeralId"] : kind === "agent.btw.ask" ? ["question", "topicId", "images"] : ["topicId"])]);
 text(row.sessionId); text(row.agentId);
 if (kind !== "agent.btw.read" || row.binding !== undefined) text(row.binding, 128);
 if (row.topicId !== undefined) text(row.topicId, 128);
 if (kind === "agent.btw.ask") text(row.question, Number.POSITIVE_INFINITY);
 if (kind === "agent.btw.abort") text(row.ephemeralId, 128);
}
/** Check the envelope only; history and images are produced by the Runtime. */
export function validateAgentBtwState(value: unknown): asserts value is AgentBtwState {
 const row = object(value, ["binding", "agentId", "targetSessionId", "snapshot", "topics", "turns"]);
 text(row.binding, 128); text(row.agentId); text(row.targetSessionId);
 if (!Array.isArray(row.topics) || !Array.isArray(row.turns)) throw Error("Invalid child BTW history");
}
