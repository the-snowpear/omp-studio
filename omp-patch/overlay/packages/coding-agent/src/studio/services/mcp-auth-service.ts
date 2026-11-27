import { runtimeText } from "../locale";
import { getMCPConfigPath, sanitizeText } from "@oh-my-pi/pi-utils";
import { loadAllMCPConfigs } from "../../mcp/config";
import { setServerDisabled, setServerForceEnabled, updateMCPServer } from "../../mcp/config-writer";
import {
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredential,
	removeManagedMcpOAuthCredentials,
} from "../../mcp/oauth-credentials";
import { extractOAuthChallengeScopes, insufficientScopeOf } from "../../mcp/oauth-discovery";
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
import type { MCPAuthChallenge, MCPServerConfig } from "../../mcp/types";
import type { AgentSession } from "../../session/agent-session";
import { openPath } from "../../utils/open";
import type {
	McpAuthChallengeKind,
	McpAuthChallengeState,
	McpAuthChallengeStatus,
	McpAuthChallengeSummary,
	McpAuthOperation,
	McpAuthServerConnectionStatus,
	McpAuthStatusResult,
	McpAuthStepUpResult,
} from "../mcp-auth-protocol";
import type { McpAuthResult } from "../runtime-features-protocol";
import type { StudioInteractionGateway } from "./interaction-port";
import { SessionControlError } from "./session-control-service";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const cleanText = (value: string, max = 4096) => sanitizeText(value).replaceAll("\0", "").slice(0, max);

function summarizeChallenge(challenge: MCPAuthChallenge): McpAuthChallengeSummary {
	const wwwAuthenticate = challenge.wwwAuthenticate
		.map(item => cleanText(item, 4096))
		.filter(Boolean)
		.slice(0, 16);
	const stepUp = insufficientScopeOf(wwwAuthenticate);
	const kind: McpAuthChallengeKind = stepUp !== undefined ? "insufficient_scope" : "unauthorized";
	const rawScopes =
		stepUp !== undefined ? stepUp : (extractOAuthChallengeScopes(new Error(wwwAuthenticate.join(" "))) ?? "");
	const requiredScopes = [...new Set(rawScopes.split(/\s+/).filter(Boolean))];
	return {
		kind,
		requiredScopes,
		wwwAuthenticate,
	};
}

function challengeFromErrorMessage(message: string): MCPAuthChallenge | undefined {
	const match = message.match(/\[WWW-Authenticate: (.*?)(?:; Mcp-Auth-Server: [^\]]*)?\]$/);
	if (!match?.[1]) return undefined;
	return { wwwAuthenticate: [match[1]] };
}

export interface McpAuthServiceDeps {
	findServer?: typeof findMcpServerForAuth;
	reauthorize?: typeof reauthorizeMcpServer;
	reconnectManager?: typeof reconnectMcpManagerServer;
	openUrl?: (url: string) => void;
}

/** `mcp.auth.*`: upstream `/mcp reauth`, `/mcp unauth`, reconnect, and 403 `insufficient_scope` step-up reauth. */
export class StudioMcpAuthService {
	/** Late-bound by the host (like the worktree service); enables pasting the OAuth code by hand. */
	interaction?: StudioInteractionGateway;
	#inFlight = new Set<string>();
	#challenges = new Map<string, McpAuthChallengeState>();
	#listeners = new Set<() => void>();
	#unsubscribeStatus?: () => void;
	#disposed = false;
	readonly #deps: Required<McpAuthServiceDeps>;

	constructor(
		readonly session: AgentSession,
		readonly manager?: MCPManager,
		deps: McpAuthServiceDeps = {},
	) {
		this.#deps = {
			findServer: deps.findServer ?? findMcpServerForAuth,
			reauthorize: deps.reauthorize ?? reauthorizeMcpServer,
			reconnectManager: deps.reconnectManager ?? reconnectMcpManagerServer,
			openUrl: deps.openUrl ?? (url => openPath(url)),
		};
		manager?.setAuthHandler?.((serverName, challenge) => this.handleAuthChallenge(serverName, challenge));
		this.#unsubscribeStatus = manager?.addConnectionStatusListener?.(event => {
			if (this.#disposed) return;
			if (event.type === "connecting") {
				for (const name of event.serverNames) this.#updateServerStatus(name, "connecting");
				return;
			}
			const name = event.serverName;
			if (!name || name === ".mcp.json") return;
			if (event.type === "failed") {
				const parsed = challengeFromErrorMessage(event.error);
				if (parsed) {
					this.recordAuthChallenge(name, parsed, "failed", cleanText(event.error, 1000));
				} else {
					this.#updateServerStatus(name, "failed");
				}
			} else if (event.type === "reconnecting") {
				this.#updateServerStatus(name, "connecting");
			} else if (event.type === "connected") {
				const existing = this.#challenges.get(name);
				if (existing) {
					this.#setChallenge({
						...existing,
						status: existing.status === "reauthorizing" ? "authorized" : existing.status,
						serverStatus: "connected",
						updatedAt: Date.now(),
					});
				}
			}
		});
	}

	get #manager(): MCPManager | undefined {
		return this.manager;
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribeStatus?.();
		this.#unsubscribeStatus = undefined;
		this.#manager?.setAuthHandler?.(undefined);
		this.#listeners.clear();
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emitChange(): void {
		for (const listener of this.#listeners) listener();
	}

	#serverStatus(name: string): McpAuthServerConnectionStatus | undefined {
		const status = this.#manager?.getConnectionStatus?.(name);
		if (status === "connected" || status === "connecting" || status === "disconnected") return status;
		return undefined;
	}

	#setChallenge(state: McpAuthChallengeState): void {
		this.#challenges.set(state.name, state);
		this.#emitChange();
	}

	#updateServerStatus(name: string, serverStatus: McpAuthServerConnectionStatus): void {
		const existing = this.#challenges.get(name);
		if (!existing || existing.serverStatus === serverStatus) return;
		this.#setChallenge({ ...existing, serverStatus, updatedAt: Date.now() });
	}

	recordAuthChallenge(
		name: string,
		challenge: MCPAuthChallenge,
		serverStatus: McpAuthServerConnectionStatus | undefined = this.#serverStatus(name),
		message?: string,
	): McpAuthChallengeState {
		const summary = summarizeChallenge(challenge);
		const state: McpAuthChallengeState = {
			name,
			status: "pending",
			authChallenge: summary,
			requiredScopes: summary.requiredScopes,
			...(serverStatus ? { serverStatus } : {}),
			...(message ? { message } : {}),
			updatedAt: Date.now(),
		};
		this.#setChallenge(state);
		return state;
	}

	getChallenge(name: string): McpAuthChallengeState | undefined {
		return this.#challenges.get(name);
	}

	status(name?: string): McpAuthStatusResult {
		const rows = [...this.#challenges.values()]
			.filter(row => !name || row.name === name)
			.map(row => {
				const liveStatus = this.#serverStatus(row.name);
				return liveStatus ? { ...row, serverStatus: liveStatus } : row;
			})
			.sort((a, b) => a.name.localeCompare(b.name));
		return {
			available: Boolean(this.#manager) || rows.length > 0,
			challenges: rows,
		};
	}

	async #find(name: string): Promise<FoundMcpServer> {
		const found = await this.#deps.findServer(name, this.session.sessionManager.getCwd(), this.#manager, {
			enableProjectConfig: cfgMcpEnableProjectConfig.get(this.session.settings),
		});
		if (!found) throw new SessionControlError("INVALID_ARGUMENT", `MCP server "${name}" was not found`);
		return found;
	}

	async #runReauthFlow(
		name: string,
		found: FoundMcpServer,
		challenge: MCPAuthChallenge | undefined,
		options: { silent?: boolean; reconnect?: boolean } = {},
	): Promise<{ result: McpAuthStepUpResult; updatedConfig?: MCPServerConfig }> {
		if (this.#inFlight.has(name)) {
			throw new SessionControlError("COMMAND_BLOCKED", `Re-authorization of "${name}" is already running`);
		}
		this.#inFlight.add(name);
		const summary = challenge ? summarizeChallenge(challenge) : undefined;
		if (summary) {
			this.#setChallenge({
				name,
				status: "reauthorizing",
				authChallenge: summary,
				requiredScopes: summary.requiredScopes,
				...(this.#serverStatus(name) ? { serverStatus: this.#serverStatus(name) } : {}),
				scope: found.scope,
				updatedAt: Date.now(),
			});
		}

		let authUrl: string | undefined;
		const progress: string[] = [];
		const scope = found.scope;
		const updateChallenge = (
			status: McpAuthChallengeStatus,
			message?: string,
			serverStatus: McpAuthServerConnectionStatus | undefined = this.#serverStatus(name),
		) => {
			if (!summary) return;
			this.#setChallenge({
				name,
				status,
				authChallenge: summary,
				requiredScopes: summary.requiredScopes,
				...(serverStatus ? { serverStatus } : {}),
				...(authUrl ? { authUrl } : {}),
				scope,
				...(message ? { message } : {}),
				updatedAt: Date.now(),
			});
		};

		try {
			const outcome = await this.#deps.reauthorize(name, found, {
				authStorage: this.session.modelRegistry.authStorage,
				mcpManager: this.#manager,
				cwd: this.session.sessionManager.getCwd(),
				...(challenge ? { authChallenge: challenge } : {}),
				...(options.silent ? { silent: true } : {}),
				onAuth: info => {
					authUrl = info.url;
					this.#deps.openUrl(info.url);
				},
				onProgress: message => {
					progress.push(message);
				},
				onManualCodeInput: this.interaction ? signal => this.#manualCode(name, signal) : undefined,
			});

			let state: "connected" | "connecting" | "disconnected" | undefined;
			if (options.reconnect !== false) {
				// Reconnect applies the updated config and re-installs `link.onAuthError = #authRefreshHook(config)`.
				state = await this.#deps.reconnectManager(this.#manager, name, outcome.config).catch(() => undefined);
			}
			const serverStatus = state ?? this.#serverStatus(name);
			const message =
				state === "connected"
					? runtimeText("已重新授权并连接。", "Reauthorized and reconnected.")
					: state === "connecting"
						? runtimeText("已重新授权，正在连接。", "Reauthorized; reconnecting.")
						: runtimeText(
								"已重新授权，凭据将在下次连接时使用。",
								"Reauthorized; the credential applies on the next connection.",
							);
			updateChallenge("authorized", message, serverStatus);
			return {
				updatedConfig: outcome.config,
				result: {
					name,
					status: "authorized",
					scope,
					...(authUrl ? { authUrl } : {}),
					...(summary ? { authChallenge: summary, requiredScopes: summary.requiredScopes } : {}),
					...(serverStatus ? { serverStatus } : {}),
					message,
				},
			};
		} catch (error) {
			const serverStatus = this.#serverStatus(name);
			if (error instanceof McpReauthRefusalError) {
				updateChallenge("refused", error.message, serverStatus);
				return {
					result: {
						name,
						status: "refused",
						scope,
						...(summary ? { authChallenge: summary, requiredScopes: summary.requiredScopes } : {}),
						...(serverStatus ? { serverStatus } : {}),
						message: error.message,
					},
				};
			}
			if (error instanceof MCPOAuthCancelledError) {
				const message = errorText(error);
				updateChallenge("cancelled", message, serverStatus);
				return {
					result: {
						name,
						status: "cancelled",
						scope,
						...(authUrl ? { authUrl } : {}),
						...(summary ? { authChallenge: summary, requiredScopes: summary.requiredScopes } : {}),
						...(serverStatus ? { serverStatus } : {}),
						message,
					},
				};
			}
			const message = errorText(error) || progress.at(-1);
			updateChallenge("failed", message, serverStatus);
			return {
				result: {
					name,
					status: "failed",
					scope,
					...(authUrl ? { authUrl } : {}),
					...(summary ? { authChallenge: summary, requiredScopes: summary.requiredScopes } : {}),
					...(serverStatus ? { serverStatus } : {}),
					...(message ? { message } : {}),
				},
			};
		} finally {
			this.#inFlight.delete(name);
		}
	}

	/**
	 * Handler bound via `MCPManager.setAuthHandler` for HTTP 403 `insufficient_scope` / `_meta["mcp/www_authenticate"]`
	 * tool-call challenges. Returns the refreshed `MCPServerConfig` so `MCPManager.#doReconnect` stores it and
	 * `#relinkServer` re-arms `link.onAuthError = #authRefreshHook(config)`.
	 */
	async handleAuthChallenge(name: string, challenge: MCPAuthChallenge): Promise<MCPServerConfig | undefined> {
		this.recordAuthChallenge(name, challenge);
		const run = async (): Promise<MCPServerConfig | undefined> => {
			let found: FoundMcpServer;
			try {
				found = await this.#find(name);
			} catch (error) {
				const existing = this.#challenges.get(name);
				if (existing) {
					this.#setChallenge({
						...existing,
						status: "failed",
						message: errorText(error),
						updatedAt: Date.now(),
					});
				}
				return undefined;
			}
			if (found.config.enabled === false) {
				const existing = this.#challenges.get(name);
				if (existing) {
					this.#setChallenge({
						...existing,
						status: "refused",
						scope: found.scope,
						message: runtimeText(`服务器 "${name}" 已禁用。`, `Server "${name}" is disabled.`),
						updatedAt: Date.now(),
					});
				}
				return undefined;
			}
			const { updatedConfig } = await this.#runReauthFlow(name, found, challenge, {
				silent: true,
				reconnect: false,
			});
			return updatedConfig;
		};

		const waitForUser = (this.session as { waitForUser?: <T>(fn: () => Promise<T>) => Promise<T> }).waitForUser;
		return typeof waitForUser === "function"
			? (waitForUser.call(this.session, run) as Promise<MCPServerConfig | undefined>)
			: run();
	}

	async reauth(name: string, options?: { authChallenge?: MCPAuthChallenge }): Promise<McpAuthResult> {
		const found = await this.#find(name);
		const stored = this.#challenges.get(name);
		const challenge =
			options?.authChallenge ??
			(stored && stored.status !== "authorized"
				? { wwwAuthenticate: stored.authChallenge.wwwAuthenticate }
				: undefined);
		const { result } = await this.#runReauthFlow(name, found, challenge, { reconnect: true });
		return result;
	}

	async stepUp(name: string, wwwAuthenticate?: readonly string[]): Promise<McpAuthStepUpResult> {
		const found = await this.#find(name);
		const stored = this.#challenges.get(name);
		const challenge: MCPAuthChallenge | undefined =
			wwwAuthenticate && wwwAuthenticate.length > 0
				? { wwwAuthenticate: [...wwwAuthenticate] }
				: stored
					? { wwwAuthenticate: stored.authChallenge.wwwAuthenticate }
					: undefined;
		const { result } = await this.#runReauthFlow(name, found, challenge, { reconnect: true });
		return result;
	}

	async execute(operation: McpAuthOperation): Promise<unknown> {
		if (operation.sessionId !== this.session.sessionId) {
			throw new SessionControlError("COMMAND_BLOCKED", "The active session changed; reload MCP auth status");
		}
		if (operation.kind === "mcp.auth.status") {
			return this.status(operation.name);
		}
		return this.stepUp(operation.name, operation.wwwAuthenticate);
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
				title: runtimeText(
					`粘贴 "${name}" 的授权码或回调地址`,
					`Paste the authorization code or redirect URL for "${name}"`,
				),
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
			this.#challenges.delete(name);
			return {
				name,
				status: "removed",
				scope: found.scope,
				message: runtimeText("没有已保存的 OAuth 凭据可移除。", "No stored OAuth credential to remove."),
			};
		}
		this.#challenges.delete(name);
		// Reconnect so the live manager stops using the dropped credential.
		await this.#deps.reconnectManager(this.#manager, name, updated).catch(() => undefined);
		return { name, status: "removed", scope: found.scope, message: runtimeText("已登出。", "Signed out.") };
	}

	async reconnect(name: string): Promise<McpAuthResult> {
		const manager = this.#manager;
		if (manager?.getBuiltinDrops?.().has(name)) {
			const cwd = this.session.sessionManager.getCwd();
			const file = getMCPConfigPath("user", cwd);
			await setServerDisabled(file, name, false);
			await setServerForceEnabled(file, name, true);
			const { configs, sources } = await loadAllMCPConfigs(cwd, {
				extensionRoots: this.session.effectiveExtensionRoots,
				enableProjectConfig: cfgMcpEnableProjectConfig.get(this.session.settings),
			});
			const config = configs[name];
			if (!config)
				return {
					name,
					status: "failed",
					scope: "user",
					message: runtimeText("MCP 服务器配置不可用", "MCP server configuration is unavailable"),
				};
			const result = await manager.connectServers(
				{ [name]: config },
				sources[name] ? { [name]: sources[name]! } : {},
			);
			await this.session.refreshMCPTools(manager.getTools());
			const error = result.errors.get(name);
			return { name, status: error ? "failed" : "connected", scope: "user", message: error };
		}
		if (!manager?.getServerConfig(name)) {
			throw new SessionControlError("INVALID_ARGUMENT", `MCP server "${name}" is not loaded in this session`);
		}
		const scope = (await this.#find(name).catch(() => undefined))?.scope;
		try {
			await manager.reconnectServer(name, { manual: true });
			const state = manager.getConnectionStatus(name);
			if (state === "connected") {
				const existing = this.#challenges.get(name);
				if (existing) {
					this.#setChallenge({ ...existing, serverStatus: "connected", updatedAt: Date.now() });
				}
			}
			return {
				name,
				status: state === "disconnected" ? "failed" : "connected",
				...(scope ? { scope } : {}),
				message:
					state === "connecting"
						? runtimeText("正在重连…", "Reconnecting…")
						: state === "connected"
							? runtimeText("已连接。", "Connected.")
							: runtimeText("仍未连接。", "Still disconnected."),
			};
		} catch (error) {
			return { name, status: "failed", ...(scope ? { scope } : {}), message: errorText(error) };
		}
	}
}
