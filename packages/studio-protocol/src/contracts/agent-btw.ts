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
