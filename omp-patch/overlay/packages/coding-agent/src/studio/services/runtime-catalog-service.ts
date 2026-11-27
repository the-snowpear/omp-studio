import type { StudioMcpAuthService } from "./mcp-auth-service";
import type { MCPManager } from "../../mcp/manager";
import { normalizeMCPTransportError } from "../../mcp/errors";
import { cfgMcpIdleStopMinutes, cfgMcpShared, cfgMcpStartupTimeoutMs } from "../../mcp/settings";
import { createHash } from "node:crypto";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { expandPromptTemplate, type PromptTemplate } from "../../config/prompt-templates";
import { resolveMCPStartupTimeoutMs } from "../../mcp/timeout";
import type { AgentSession } from "../../session/agent-session";
import {
	type McpRuntimeStatus,
	type McpServerRuntimeStatus,
	type PromptTemplateRow,
	type RuntimeCatalogOperation,
} from "../runtime-catalog-protocol";
import { SessionControlError } from "./session-control-service";

const clean = (value: string, max = 512) => sanitizeText(value).replaceAll("\0", "").slice(0, max);
const sanitizeStderr = (value: string) =>
	clean(value, 2000)
		.replace(/(Bearer\s+)\S+/giu, "$1[redacted]")
		.replace(/([?&](?:token|key|secret|password|auth|code)=)[^&\s]+/giu, "$1[redacted]")
		.replace(/((?:token|secret|password)\s*[:=]\s*)\S+/giu, "$1[redacted]");
function describe(template: PromptTemplate): PromptTemplateRow {
	const version = createHash("sha256").update(JSON.stringify(template)).digest("hex");
	return {
		id: "template-" + version,
		name: clean(template.name),
		description: clean(template.description, 2000),
		source: clean(template.source),
		version,
	};
}
/** Loaded Runtime templates and MCP facts, never Host discovery/probe guesses. */
export class StudioRuntimeCatalogService {
	constructor(
		readonly session: AgentSession,
		readonly manager?: MCPManager,
		readonly auth?: StudioMcpAuthService,
	) {}
	async execute(operation: RuntimeCatalogOperation): Promise<unknown> {
		const cwd = this.session.sessionManager.getCwd();
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The active session changed; reload the Runtime catalog");
		const result = await this.#execute(operation);
		if (operation.sessionId !== this.session.sessionId || cwd !== this.session.sessionManager.getCwd())
			throw new SessionControlError("COMMAND_BLOCKED", "The active session changed; reload the Runtime catalog");
		return result;
	}
	async #execute(operation: RuntimeCatalogOperation): Promise<unknown> {
		if (operation.kind === "mcp.runtime.status") {
			const manager = this.manager;
			const startupTimeoutMs = resolveMCPStartupTimeoutMs(cfgMcpStartupTimeoutMs.get(this.session.settings));
			const shared = cfgMcpShared.get(this.session.settings);
			const rawIdleStop = cfgMcpIdleStopMinutes.get(this.session.settings);
			const idleStopMinutes = Number.isFinite(rawIdleStop) && rawIdleStop >= 0 ? rawIdleStop : 5;
			if (!manager)
				return {
					available: false,
					startupTimeoutMs,
					shared,
					idleStopMinutes,
					ready: false,
					settled: false,
					servers: [],
					total: 0,
				};
			// A one-millisecond bounded observation waits for no new discovery and never changes policy.
			const status = await manager.waitForStartup(1);
			const pending = new Set(status.pending);
			const drops = manager.getBuiltinDrops?.() ?? new Map();
			const failed = new Map(status.failed.map(server => [server.name, server.error]));
			const names = [
				...new Set([
					...manager.getAllServerNames(),
					...status.connected,
					...status.pending,
					...failed.keys(),
					...drops.keys(),
				]),
			].sort();
			const servers: McpRuntimeStatus["servers"] = names.slice(0, 500).map(name => {
				const connection = manager.getConnection(name);
				const config = manager.getServerConfig(name);
				const dropped = drops.get(name);
				const source = manager.getSource(name) ?? dropped?.source;
				const namespace = this.session.mcpEvalNamespaceForServer(name);
				const transport = config ? (config.type ?? "stdio") : undefined;
				const failure = failed.get(name);
				const upstream = manager.getServerRuntime?.(name);
				const runtime: McpServerRuntimeStatus | undefined = upstream
					? {
							era: upstream.era,
							state: upstream.state,
							...(upstream.pid !== undefined ? { pid: upstream.pid } : {}),
							links: upstream.links,
							...(upstream.exit
								? {
										exit: {
											...(upstream.exit.code !== undefined ? { code: upstream.exit.code } : {}),
											...(upstream.exit.signal !== undefined ? { signal: upstream.exit.signal } : {}),
											stderr: sanitizeStderr(upstream.exit.stderr),
										},
									}
								: {}),
						}
					: undefined;
				return {
					name: clean(name),
					replacedByBuiltin: dropped?.reason,
					evalNamespaceUri: namespace ? "help://eval/" + namespace : undefined,
					state: pending.has(name)
						? "pending"
						: failed.has(name)
							? "failed"
							: connection?.tools !== undefined
								? "ready"
								: manager.getConnectionStatus(name) === "connecting"
									? "pending"
									: "disconnected",
					tools: connection?.tools?.length ?? 0,
					...(transport ? { transport } : {}),
					...(source ? { source: { providerName: clean(source.providerName), level: source.level } } : {}),
					...(failure
						? {
								error: clean(
									normalizeMCPTransportError(failure, {
										transport: transport === "sse" ? "http" : (transport ?? "unknown"),
										stage: "connect",
									}).message,
									1000,
								),
							}
						: {}),
					...(runtime ? { runtime } : {}),
					...(this.auth?.getChallenge(name) ? { authChallenge: this.auth.getChallenge(name) } : {}),
					toolInfo: this.session
						.getAllToolInfos()
						.filter(tool => tool.mcpServerName === name)
						.slice(0, 100)
						.map(tool => ({
							name: tool.name,
							mcpServerName: tool.mcpServerName!,
							mcpToolName: tool.mcpToolName ?? tool.name,
							...(tool.description ? { description: clean(tool.description, 400) } : {}),
							...(tool.mcpReadOnlyHint === undefined ? {} : { readOnlyHint: tool.mcpReadOnlyHint }),
						})),
				};
			});
			return {
				available: true,
				startupTimeoutMs,
				shared,
				idleStopMinutes,
				ready:
					status.pending.length === 0 &&
					status.failed.length === 0 &&
					names.every(name => drops.has(name) || manager.getConnection(name)?.tools !== undefined),
				settled:
					status.pending.length === 0 && !names.some(name => manager.getConnectionStatus(name) === "connecting"),
				servers,
				total: names.length,
			};
		}
		const templates = new Map(
			(this.session.promptTemplates ?? []).map(template => {
				const row = describe(template);
				return [row.id, { template, row }] as const;
			}),
		);
		const list = [...templates.values()].sort((a, b) => a.row.id.localeCompare(b.row.id));
		if (operation.kind === "templates.list") {
			const start = operation.cursor ? list.findIndex(value => value.row.id > operation.cursor!) : 0;
			const page = start < 0 ? [] : list.slice(start, start + (operation.limit ?? 50));
			return {
				templates: page.map(value => value.row),
				...(start >= 0 && start + page.length < list.length && page.length
					? { nextCursor: page[page.length - 1]!.row.id }
					: {}),
			};
		}
		const selected = templates.get(operation.id);
		if (!selected || selected.row.version !== operation.version)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"This template version is no longer loaded; refresh the list",
			);
		if (selected.template.content.length > 400000)
			throw new SessionControlError("INVALID_ARGUMENT", "Template exceeds the Studio text budget");
		if (operation.kind === "templates.get") return { template: selected.row, content: selected.template.content };
		if (selected.template.content.length * Math.max(1, operation.arguments.length) > 8000000)
			throw new SessionControlError(
				"INVALID_ARGUMENT",
				"Template expansion exceeds the Studio work budget; shorten its arguments",
			);
		// Pure native template expansion only: no slash dispatcher, AgentSession.prompt or provider call.
		const text = expandPromptTemplate("/" + selected.template.name + " " + operation.arguments, [selected.template]);
		return { text };
	}
}
