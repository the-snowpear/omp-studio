import { expect, it } from "bun:test";
import type { AgentSession } from "../src/session/agent-session";
import { StudioRuntimeCatalogService } from "../src/studio/services/runtime-catalog-service";
import type { PromptTemplateRow, McpRuntimeStatus } from "../src/studio/runtime-catalog-protocol";

it("expands the selected loaded template without invoking prompt, and fences changed versions", async () => {
	const templates = [
		{ name: "review", description: "Global", source: "(user)", content: "Global $1" },
		{ name: "review", description: "Project", source: "(project)", content: "Project $1 / $2 / {{arguments}}" },
	];
	const session = {
		sessionId: "s",
		sessionManager: { getCwd: () => "." },
		promptTemplates: templates,
		prompt: () => {
			throw new Error("Must never execute a prompt");
		},
	};
	const service = new StudioRuntimeCatalogService(session as unknown as AgentSession);
	const result = (await service.execute({ kind: "templates.list", sessionId: "s" })) as {
		templates: PromptTemplateRow[];
	};
	const project = result.templates.find(row => row.source === "(project)")!;
	const prepared = (await service.execute({
		kind: "templates.prepare",
		sessionId: "s",
		id: project.id,
		version: project.version,
		arguments: '"two words" third',
	})) as { text: string };
	expect(prepared.text).toBe("Project two words / third / two words third");
	templates[1]!.content = "Updated template";
	const stale = await service
		.execute({ kind: "templates.prepare", sessionId: "s", id: project.id, version: project.version, arguments: "x" })
		.catch(error => error);
	expect(stale).toMatchObject({ code: "COMMAND_BLOCKED" });
	session.sessionId = "new";
	expect(await service.execute({ kind: "templates.list", sessionId: "s" }).catch(error => error)).toMatchObject({
		code: "COMMAND_BLOCKED",
	});
});
it("reports native startup readiness without connecting, probing or exposing credentials", async () => {
	const waits: number[] = [];
	const connections = { ready: { tools: [{ name: "tool" }], config: { token: "must-not-leak" } } };
	const manager = {
		waitForStartup: async (timeout: number) => {
			waits.push(timeout);
			return { connected: ["ready"], pending: ["slow"], failed: [{ name: "failed", error: "token=must-not-leak" }] };
		},
		getAllServerNames: () => ["ready", "slow", "failed"],
		getConnection: (name: keyof typeof connections) => connections[name],
		getConnectionStatus: (name: string) =>
			name === "slow" ? "connecting" : name === "ready" ? "connected" : "disconnected",
	};
	const session = {
		sessionId: "s",
		sessionManager: { getCwd: () => "." },
		settings: { get: () => 250 },
		studioToolSession: { mcpManager: manager },
	};
	const service = new StudioRuntimeCatalogService(session as unknown as AgentSession);
	const result = (await service.execute({ kind: "mcp.runtime.status", sessionId: "s" })) as McpRuntimeStatus;
	expect(waits).toEqual([1]);
	expect(result.ready).toBe(false);
	expect(result.settled).toBe(false);
	expect(result.servers.find(row => row.name === "ready")).toEqual({ name: "ready", state: "ready", tools: 1 });
	expect(JSON.stringify(result)).not.toContain("must-not-leak");
});
