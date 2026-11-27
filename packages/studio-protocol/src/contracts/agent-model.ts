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
	/** Live controls use the owning session's native model-selection API. */
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
