import type { MCPManager } from "../src/mcp/manager";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioMcpAuthService } from "../src/studio/services/mcp-auth-service";

test("MCP sign-out removes the auth block from the project config that defines the server", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "studio-mcp-auth-"));
	const name = `studio-signout-${crypto.randomUUID()}`;
	const file = path.join(cwd, ".mcp.json");
	await Bun.write(
		file,
		JSON.stringify({
			mcpServers: {
				[name]: {
					type: "http",
					url: "https://mcp.example.invalid/mcp",
					auth: { type: "oauth", credentialId: "not-managed" },
				},
			},
		}),
	);
	try {
		const session = {
			sessionId: "s",
			settings: Settings.isolated(),
			sessionManager: { getCwd: () => cwd },
			modelRegistry: { authStorage: { credentials: { get: () => undefined, remove: async () => {} } } },
		} as unknown as AgentSession;
		const result = await new StudioMcpAuthService(session).unauth(name);
		expect(result).toMatchObject({ name, status: "removed", scope: "project" });
		const written = (await Bun.file(file).json()) as { mcpServers: Record<string, Record<string, unknown>> };
		expect(written.mcpServers[name]).toEqual({ type: "http", url: "https://mcp.example.invalid/mcp" });
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("403 scope challenges survive reconnection until step-up applies the native grant", async () => {
	const config = { type: "http" as const, url: "https://mcp.example.invalid/mcp" };
	let onStatus:
		| ((event: { type: "connected"; serverName: string } | { type: "connecting"; serverNames: string[] }) => void)
		| undefined;
	const challenges: string[][] = [];
	const manager = {
		setAuthHandler: () => {},
		getConnectionStatus: () => "connected" as const,
		addConnectionStatusListener: (callback: typeof onStatus) => {
			onStatus = callback;
			return () => {};
		},
	} as unknown as MCPManager;
	const service = new StudioMcpAuthService(
		{
			sessionId: "s",
			settings: Settings.isolated(),
			sessionManager: { getCwd: () => "/project" },
			modelRegistry: { authStorage: {} },
		} as unknown as AgentSession,
		manager,
		{
			findServer: async () => ({ config, scope: "project", filePath: "/project/.mcp.json", discovered: false }),
			reauthorize: async (_name, _found, options) => {
				challenges.push([...(options.authChallenge?.wwwAuthenticate ?? [])]);
				return {
					config,
					persisted: true,
					credentialId: "credential",
					oauth: { authorizationUrl: "https://auth.invalid/authorize", tokenUrl: "https://auth.invalid/token" },
				};
			},
			reconnectManager: async () => "connected",
			openUrl: () => {},
		},
	);
	const headers = ['Bearer error="insufficient_scope", scope="docs:read docs:write"'];
	service.recordAuthChallenge("docs", { wwwAuthenticate: headers });
	onStatus?.({ type: "connecting", serverNames: ["docs"] });
	onStatus?.({ type: "connected", serverName: "docs" });
	expect(service.status().challenges[0]).toMatchObject({
		status: "pending",
		serverStatus: "connected",
		requiredScopes: ["docs:read", "docs:write"],
	});
	const result = await service.execute({ kind: "mcp.auth.stepUp", sessionId: "s", name: "docs" });
	expect(result).toMatchObject({ status: "authorized", serverStatus: "connected" });
	expect(challenges).toEqual([headers]);
	expect(service.status().challenges[0]?.status).toBe("authorized");
	service.dispose();
});
