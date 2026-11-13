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
}
export type AgentModelOperation = { kind: "agent.model.inspect"; sessionId: string; agentId: string };
export interface AgentModelResultMap {
	"agent.model.inspect": AgentModelInspection;
}
export const AGENT_MODEL_KINDS = ["agent.model.inspect"] as const;
export function isAgentModelKind(kind: string): kind is AgentModelOperation["kind"] {
	return kind === "agent.model.inspect";
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
	if (row.kind !== "agent.model.inspect") throw new Error("Unknown agent model operation");
	text(row.sessionId);
	text(row.agentId);
}
