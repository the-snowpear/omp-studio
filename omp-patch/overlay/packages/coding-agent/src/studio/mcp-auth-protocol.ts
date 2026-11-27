export type McpAuthChallengeKind = "insufficient_scope" | "unauthorized";

export type McpAuthChallengeStatus = "pending" | "reauthorizing" | "authorized" | "cancelled" | "refused" | "failed";

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

function assertText(value: unknown, field: string, max = 512): asserts value is string {
	if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f]/u.test(value) || value.length > max)
		throw new Error(`Invalid ${field}`);
}

export function validateMcpAuthOperation(value: unknown): asserts value is McpAuthOperation {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected an MCP auth operation object");
	const input = value as Record<string, unknown>;
	if (typeof input.kind !== "string" || !isMcpAuthKind(input.kind)) throw new Error("Unknown MCP auth operation");
	assertText(input.sessionId, "sessionId");
	if (input.kind === "mcp.auth.status") {
		if (input.name !== undefined) assertText(input.name, "name");
		return;
	}
	assertText(input.name, "name");
	if (input.wwwAuthenticate !== undefined) {
		if (!Array.isArray(input.wwwAuthenticate) || input.wwwAuthenticate.length > 16)
			throw new Error("Invalid wwwAuthenticate");
		for (const header of input.wwwAuthenticate) assertText(header, "wwwAuthenticate", 4096);
	}
}
