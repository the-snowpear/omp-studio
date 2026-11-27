export interface AgentModelInspection {
	agentId: string;
	source: "live" | "saved" | "starting";
	selectedModel?: string;
	servingModel?: string;
	usingFallback?: boolean;
	configuredThinking?: string;
	effectiveThinking?: string;
	candidates?: string[];
	candidatesTruncated?: boolean;
	controllable?: boolean;
	models?: Array<{ selector: string; name: string }>;
	thinkingLevels?: string[];
}
export type AgentModelOperation =
	| { kind: "agent.model.inspect"; sessionId: string; agentId: string }
	| { kind: "agent.model.set"; sessionId: string; agentId: string; model: string }
	| { kind: "agent.effort.set"; sessionId: string; agentId: string; effort: string };
export interface AgentModelResultMap {
	"agent.model.inspect": AgentModelInspection;
	"agent.model.set": AgentModelInspection;
	"agent.effort.set": AgentModelInspection;
}
export const AGENT_MODEL_KINDS = ["agent.model.inspect", "agent.model.set", "agent.effort.set"] as const;
export function isAgentModelKind(kind: string): kind is AgentModelOperation["kind"] {
	return (AGENT_MODEL_KINDS as readonly string[]).includes(kind);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent model payload");
	return value as Record<string, unknown>;
}
function text(value: unknown): void {
	if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f]/u.test(value))
		throw new Error("Invalid agent model text");
}
export function validateAgentModelOperation(value: unknown): void {
	const row = record(value);
	if (typeof row.kind !== "string" || !isAgentModelKind(row.kind)) throw new Error("Unknown agent model operation");
	text(row.sessionId);
	text(row.agentId);
	if (row.kind === "agent.model.set") text(row.model);
	if (row.kind === "agent.effort.set") text(row.effort);
}
