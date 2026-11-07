import { randomBytes, randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { AgentSession } from "../../session/agent-session";
import { startRelayServer, type RelayServer } from "../../tools/browser/relay/server";
import type { RelayKind } from "../../tools/browser/relay/kind";
import { acquireBrowser, holdBrowser, releaseBrowser } from "../../tools/browser/registry";
import { acquireTab, listTabs, runInTab } from "../../tools/browser/tab-supervisor";
import type { TabWebMcpRequest } from "../../tools/browser/tab-protocol";
import type {
	StudioWebMcpCatalog,
	WebMcpListOptions,
	WebMcpListResult,
	WebMcpOperation,
	WebMcpInvokeResult,
} from "../webmcp-protocol";
import { ownedStudioSessions } from "./owned-sessions";

const services = new Map<string, StudioManagedBrowserService>();

export type StudioManagedBrowserAccess = Pick<
	StudioManagedBrowserService,
	"kind" | "begin" | "name" | "contains" | "webMcpList" | "webMcpInvoke"
>;
let remoteAccess: ((sessionId: string) => StudioManagedBrowserAccess | undefined) | undefined;
export function installManagedBrowserAccess(
	resolve: (sessionId: string) => StudioManagedBrowserAccess | undefined,
): void {
	remoteAccess = resolve;
}

export function managedBrowserFor(sessionId: string | undefined): StudioManagedBrowserAccess | undefined {
	if (!sessionId) return undefined;
	if (remoteAccess) return remoteAccess(sessionId);
	return [...services.values()].find(service =>
		ownedStudioSessions(service.session).some(session => session.sessionId === sessionId),
	);
}

export class StudioManagedBrowserService {
	#server?: RelayServer;
	#ready?: Promise<void>;
	#descriptor?: string;
	#control: "agent" | "human" | "waiting" = "waiting";
	#pending = 0;
	#initialized = false;
	#drained = new Set<() => void>();
	#disposed = false;
	kind?: RelayKind;
	constructor(
		readonly session: AgentSession,
		readonly options = {
			enabled: process.env.OMP_STUDIO_MANAGED_BROWSER === "1",
			directory: process.env.OMP_STUDIO_MEDIA_ROOT,
		},
	) {
		if (options.enabled && options.directory) {
			services.set(session.sessionId, this);
			this.#ready = this.#start();
			void this.#ready.catch(error =>
				logger.error("Managed browser initialization failed", { error: String(error) }),
			);
		}
	}
	async #start(): Promise<void> {
		const token = randomBytes(32).toString("hex");
		const server = startRelayServer({
			port: 0,
			group: false,
			studio: { token, control: mode => this.setControl(mode) },
		});
		this.#server = server;
		const endpoint = `http://127.0.0.1:${server.port}/managed/${token}`;
		this.kind = { kind: "relay", cdpUrl: endpoint, studioManaged: true };
		const directory = path.join(this.options.directory!, "managed-browser");
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const key = createHash("sha256").update(this.session.sessionId).digest("hex");
		const generation = randomUUID();
		this.#descriptor = path.join(directory, `${key}-${generation}.json`);
		await fs.writeFile(
			this.#descriptor,
			JSON.stringify({ version: 1, sessionId: this.session.sessionId, generation, endpoint, pid: process.pid }),
			{ mode: 0o600 },
		);
		if (this.#disposed) this.dispose();
	}
	async begin(signal?: AbortSignal, readOnly = false): Promise<() => void> {
		await this.#ready;
		const deadline = Date.now() + 15000;
		while (!this.#disposed && (!this.#server?.bridge.ready || !this.#initialized) && Date.now() < deadline) {
			if (signal?.aborted) throw signal.reason;
			await Bun.sleep(50);
		}
		if (signal?.aborted) throw signal.reason;
		if (this.#disposed || !this.#server?.bridge.ready)
			throw new ToolError(
				"The Studio browser is disconnected. Reconnect the local desktop browser before continuing.",
			);
		if (!readOnly && this.#control !== "agent")
			throw new ToolError(
				"The user controls this chat's browser. Wait for the user to return browser control; other work may continue.",
			);
		this.#pending++;
		return () => {
			this.#pending--;
			if (!this.#pending) {
				for (const resolve of this.#drained) resolve();
				this.#drained.clear();
			}
		};
	}
	async prepare(sessionId: string): Promise<{ sessionId: string; descriptorId: string }> {
		if (sessionId !== this.session.sessionId) throw new ToolError("Managed browser belongs to another chat.");
		await this.#ready;
		if (!this.#descriptor || this.#disposed)
			throw new ToolError("Managed browser requires the local Studio desktop.");
		return { sessionId, descriptorId: path.basename(this.#descriptor) };
	}
	async setControl(mode: "agent" | "human"): Promise<void> {
		this.#control = "waiting";
		if (this.#pending) {
			const drained = Promise.withResolvers<void>();
			this.#drained.add(drained.resolve);
			await drained.promise;
		}
		this.#control = mode;
		this.#initialized = true;
	}
	name(name: string): string {
		return `${this.session.sessionId}::${name}`;
	}
	contains(name: string): boolean {
		return name.startsWith(`${this.session.sessionId}::`);
	}

	async webMcpList(sessionId: string, pageId: string, options?: WebMcpListOptions): Promise<StudioWebMcpCatalog> {
		if (!this.kind || sessionId !== this.session.sessionId)
			return {
				pageId,
				status: "unavailable",
				tools: [],
				truncated: false,
				untrusted: true,
				invocationAvailable: false,
				reason: "Connect this chat's managed desktop browser to inspect its page tools.",
			};
		const { value, documentId, chromiumMajor } = await this.#webMcp(pageId, { action: "list", options });
		return {
			...(value as WebMcpListResult),
			pageId,
			...(documentId ? { documentId } : {}),
			invocationAvailable: chromiumMajor >= 149,
		};
	}

	async webMcpInvoke(operation: WebMcpOperation): Promise<WebMcpInvokeResult> {
		if (operation.sessionId !== this.session.sessionId) throw new ToolError("WebMCP belongs to another chat.");
		const { value } = await this.#webMcp(
			operation.pageId,
			{ action: "invoke", name: operation.name, params: operation.params, options: operation.options },
			operation.documentId,
		);
		return value as WebMcpInvokeResult;
	}

	async #webMcp(
		pageId: string,
		operation: TabWebMcpRequest,
		expectedDocument?: string,
	): Promise<{ value: unknown; documentId?: string; chromiumMajor: number }> {
		const timeoutMs = operation.action === "invoke" ? (operation.options?.timeout ?? 10000) : 10000;
		const signal = AbortSignal.timeout(timeoutMs);
		const release = await this.begin(signal, operation.action !== "invoke");
		try {
			const target = this.#server?.bridge.listTargets().find(row => row.studioPageId === pageId);
			if (!target || !this.kind) throw new ToolError("This managed page is closed or unavailable.");
			if (operation.action === "invoke" && (!expectedDocument || target.studioDocumentId !== expectedDocument))
				throw new ToolError("The page navigated. Refresh its WebMCP tools before invoking one.");
			const toolSession = this.session.studioToolSession;
			if (!toolSession) throw new ToolError("The browser tool session is unavailable.");
			const browser = await acquireBrowser(this.kind, { cwd: toolSession.cwd, signal });
			holdBrowser(browser);
			try {
				const name =
					listTabs().find(tab => this.contains(tab.name) && tab.targetId === target.id)?.name ??
					this.name(`webmcp:${pageId}`);
				await acquireTab(name, browser, {
					target: target.id,
					timeoutMs,
					signal,
					persist: true,
					ownerSessionId: this.session.studioEvalKernelOwnerId,
				});
				const version = "browser" in browser ? await browser.browser.version() : "";
				if (
					operation.action === "invoke" &&
					this.#server?.bridge.listTargets().find(row => row.studioPageId === pageId)?.studioDocumentId !==
						expectedDocument
				)
					throw new ToolError("The page navigated. Refresh its WebMCP tools before invoking one.");
				const result = await runInTab(name, {
					code: "",
					webmcp: operation,
					timeoutMs,
					signal,
					session: toolSession,
				});
				return {
					value: result.returnValue,
					...(target.studioDocumentId ? { documentId: target.studioDocumentId } : {}),
					chromiumMajor: Number(/(?:Chrome|Chromium)\/(\d+)/u.exec(version)?.[1] ?? 0),
				};
			} finally {
				await releaseBrowser(browser, { kill: false });
			}
		} finally {
			release();
		}
	}
	dispose(): void {
		this.#disposed = true;
		if (services.get(this.session.sessionId) === this) services.delete(this.session.sessionId);
		this.#server?.stop();
		if (this.#descriptor)
			void fs.unlink(this.#descriptor).catch(error => {
				if (error.code !== "ENOENT")
					logger.warn("Could not remove managed browser descriptor", { error: String(error) });
			});
		for (const resolve of this.#drained) resolve();
		this.#drained.clear();
	}
}
