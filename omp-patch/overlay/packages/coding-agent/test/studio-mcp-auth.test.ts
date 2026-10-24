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
