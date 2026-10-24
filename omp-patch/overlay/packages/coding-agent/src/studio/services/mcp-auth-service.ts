import { updateMCPServer } from "../../mcp/config-writer";
import {
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredential,
	removeManagedMcpOAuthCredentials,
} from "../../mcp/oauth-credentials";
import {
	type FoundMcpServer,
	findMcpServerForAuth,
	MCPOAuthCancelledError,
	McpReauthRefusalError,
	reauthorizeMcpServer,
	reconnectMcpManagerServer,
	stripMcpOAuthAuth,
} from "../../mcp/oauth-reauth";
import { cfgMcpEnableProjectConfig } from "../../mcp/settings";
import type { MCPManager } from "../../mcp/manager";
import type { AgentSession } from "../../session/agent-session";
import { openPath } from "../../utils/open";
import type { McpAuthResult } from "../runtime-features-protocol";
import type { StudioInteractionGateway } from "./interaction-port";
import { SessionControlError } from "./session-control-service";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `mcp.auth.*`: upstream `/mcp reauth`, `/mcp unauth` and reconnect, without the TUI. */
export class StudioMcpAuthService {
	/** Late-bound by the host (like the worktree service); enables pasting the OAuth code by hand. */
	interaction?: StudioInteractionGateway;
	#inFlight = new Set<string>();

	constructor(readonly session: AgentSession) {}

	get #manager(): MCPManager | undefined {
		return this.session.studioToolSession?.mcpManager;
	}

	async #find(name: string): Promise<FoundMcpServer> {
		const found = await findMcpServerForAuth(name, this.session.sessionManager.getCwd(), this.#manager, {
			enableProjectConfig: cfgMcpEnableProjectConfig.get(this.session.settings),
		});
		if (!found) throw new SessionControlError("INVALID_ARGUMENT", `MCP server "${name}" was not found`);
		return found;
	}

	async reauth(name: string): Promise<McpAuthResult> {
		if (this.#inFlight.has(name)) {
			throw new SessionControlError("COMMAND_BLOCKED", `Re-authorization of "${name}" is already running`);
		}
		const found = await this.#find(name);
		this.#inFlight.add(name);
		let authUrl: string | undefined;
		const progress: string[] = [];
		const scope = found.scope;
		try {
			await reauthorizeMcpServer(name, found, {
				authStorage: this.session.modelRegistry.authStorage,
				mcpManager: this.#manager,
				cwd: this.session.sessionManager.getCwd(),
				onAuth: info => {
					authUrl = info.url;
					openPath(info.url);
				},
				onProgress: message => {
					progress.push(message);
				},
				onManualCodeInput: this.interaction ? signal => this.#manualCode(name, signal) : undefined,
			});
			const state = await reconnectMcpManagerServer(this.#manager, name, found.config).catch(() => undefined);
			const message =
				state === "connected"
					? "Reauthorized and reconnected."
					: state === "connecting"
						? "Reauthorized; reconnecting."
						: "Reauthorized; the credential applies on the next connection.";
			return { name, status: "authorized", scope, ...(authUrl ? { authUrl } : {}), message };
		} catch (error) {
			if (error instanceof McpReauthRefusalError) {
				return { name, status: "refused", scope, message: error.message };
			}
			if (error instanceof MCPOAuthCancelledError) {
				return { name, status: "cancelled", scope, ...(authUrl ? { authUrl } : {}), message: errorText(error) };
			}
			return {
				name,
				status: "failed",
				scope,
				...(authUrl ? { authUrl } : {}),
				message: errorText(error) || progress.at(-1),
			};
		} finally {
			this.#inFlight.delete(name);
		}
	}

	async #manualCode(name: string, signal?: AbortSignal): Promise<string> {
		const interaction = this.interaction!;
		const commandId = `mcp-reauth:${name}:${crypto.randomUUID()}`;
		// The local callback usually wins; withdraw our prompt (and only ours) when it does.
		const onAbort = () => {
			if (interaction.pending()?.request.commandId === commandId) interaction.cancel("OAuth callback received");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const value = await interaction.input({
				commandId,
				title: `Paste the authorization code or redirect URL for "${name}"`,
				placeholder: "code or http://localhost/…?code=…",
				secret: true,
			});
			if (!value?.trim()) throw new MCPOAuthCancelledError();
			return value.trim();
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Same as `/mcp unauth`: drop stored OAuth credentials and the config's `auth` block. */
	async unauth(name: string): Promise<McpAuthResult> {
		const found = await this.#find(name);
		const authStorage = this.session.modelRegistry.authStorage;
		const currentAuth = found.config.auth;
		let removed = false;
		if (currentAuth?.type === "oauth") {
			removed = await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
		}
		if ((found.config.type === "http" || found.config.type === "sse") && found.config.url) {
			removed =
				(await removeManagedMcpOAuthCredentials(
					authStorage,
					mcpOAuthCredentialIdsForServerUrl(found.config.url),
				)) || removed;
		}
		const updated = stripMcpOAuthAuth(found.config);
		if (!found.discovered) {
			await updateMCPServer(found.filePath, name, updated);
		} else if (!removed && currentAuth?.type !== "oauth") {
			return { name, status: "removed", scope: found.scope, message: "No stored OAuth credential to remove." };
		}
		// Reconnect so the live manager stops using the dropped credential.
		await reconnectMcpManagerServer(this.#manager, name, updated).catch(() => undefined);
		return { name, status: "removed", scope: found.scope, message: "Signed out." };
	}

	async reconnect(name: string): Promise<McpAuthResult> {
		const manager = this.#manager;
		if (!manager?.getServerConfig(name)) {
			throw new SessionControlError("INVALID_ARGUMENT", `MCP server "${name}" is not loaded in this session`);
		}
		const scope = (await this.#find(name).catch(() => undefined))?.scope;
		try {
			await manager.reconnectServer(name, { manual: true });
			const state = manager.getConnectionStatus(name);
			return {
				name,
				status: state === "disconnected" ? "failed" : "connected",
				...(scope ? { scope } : {}),
				message:
					state === "connecting" ? "Reconnecting…" : state === "connected" ? "Connected." : "Still disconnected.",
			};
		} catch (error) {
			return { name, status: "failed", ...(scope ? { scope } : {}), message: errorText(error) };
		}
	}
}
