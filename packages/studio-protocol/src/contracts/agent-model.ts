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
