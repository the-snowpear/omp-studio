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
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw new Error("Invalid agent model payload");
	return value as Record<string, unknown>;
}
function text(value: unknown): void {
	if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f]/u.test(value))
		throw new Error("Invalid agent model text");
}
export function validateAgentModelOperation(value: unknown): void {
	const row = record(value, ["kind", "sessionId", "agentId"]);
	if (row.kind !== "agent.model.inspect") throw new Error("Unknown agent model operation");
	text(row.sessionId);
	text(row.agentId);
}
export function validateAgentModelResult(_kind: AgentModelOperation["kind"], value: unknown): void {
	const row = record(value, [
		"agentId",
		"source",
		"selectedModel",
		"servingModel",
		"usingFallback",
		"configuredThinking",
		"effectiveThinking",
		"candidates",
		"candidatesTruncated",
	]);
	text(row.agentId);
	if (!["live", "saved", "starting"].includes(row.source as string)) throw new Error("Invalid agent model source");
	for (const key of ["selectedModel", "servingModel", "configuredThinking", "effectiveThinking"])
		if (row[key] !== undefined) text(row[key]);
	for (const key of ["usingFallback", "candidatesTruncated"])
		if (row[key] !== undefined && typeof row[key] !== "boolean") throw new Error("Invalid agent model flag");
	if (row.candidates !== undefined) {
		if (!Array.isArray(row.candidates) || row.candidates.length > 16) throw new Error("Invalid model candidates");
		row.candidates.forEach(text);
	}
}
