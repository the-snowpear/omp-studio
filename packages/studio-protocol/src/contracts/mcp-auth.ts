export type McpAuthChallengeKind = "insufficient_scope" | "unauthorized";

export type McpAuthChallengeStatus =
  | "pending"
  | "reauthorizing"
  | "authorized"
  | "cancelled"
  | "refused"
  | "failed";

export type McpAuthServerConnectionStatus = "connected" | "connecting" | "disconnected" | "failed";

export interface McpAuthChallengeSummary {
  kind: McpAuthChallengeKind;
  requiredScopes: string[];
  wwwAuthenticate: string[];
}

export interface McpAuthChallengeState {
  name: string;
  status: McpAuthChallengeStatus;
  authChallenge: McpAuthChallengeSummary;
  requiredScopes: string[];
  serverStatus?: McpAuthServerConnectionStatus;
  authUrl?: string;
  scope?: "project" | "user";
  message?: string;
  updatedAt: number;
}

export interface McpAuthStatusResult {
  available: boolean;
  challenges: McpAuthChallengeState[];
}

export interface McpAuthStepUpResult {
  name: string;
  status: "authorized" | "cancelled" | "refused" | "removed" | "connected" | "failed";
  authUrl?: string;
  scope?: "project" | "user";
  message?: string;
  authChallenge?: McpAuthChallengeSummary;
  requiredScopes?: string[];
  serverStatus?: McpAuthServerConnectionStatus;
}

export type McpAuthOperation =
  | { kind: "mcp.auth.status"; sessionId: string; name?: string }
  | { kind: "mcp.auth.stepUp"; sessionId: string; name: string; wwwAuthenticate?: string[] };

export interface McpAuthResultMap {
  "mcp.auth.status": McpAuthStatusResult;
  "mcp.auth.stepUp": McpAuthStepUpResult;
}

export const MCP_AUTH_KINDS = ["mcp.auth.status", "mcp.auth.stepUp"] as const;
export const MCP_AUTH_READ_KINDS = ["mcp.auth.status"] as const;

export function isMcpAuthKind(kind: string): kind is McpAuthOperation["kind"] {
  return (MCP_AUTH_KINDS as readonly string[]).includes(kind);
}
