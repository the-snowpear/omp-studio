import { randomBytes, randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { AgentSession } from "../../session/agent-session";
import { startRelayServer, type RelayServer } from "../../tools/browser/relay/server";
import type { RelayKind } from "../../tools/browser/relay/kind";
import { acquireBrowser, holdBrowser, releaseBrowser } from "../../tools/browser/registry";
import {
	acquireTab,
	createStudioBrowserObservation,
	getTab,
	listTabs,
	runInTab,
	type TabSession,
} from "../../tools/browser/tab-supervisor";
import { studioTabIdentity } from "./browser-tab-control";
import { remoteNativeBrowserPage } from "./browser-observation-service";
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
	"kind" | "begin" | "name" | "contains" | "pageForTarget" | "webMcpList" | "webMcpInvoke"
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
		if (options.enabled && options.directory) services.set(session.sessionId, this);
	}
	#ensureReady(): Promise<void> {
		if (!this.options.enabled || !this.options.directory || this.#disposed)
			return Promise.reject(new ToolError("The embedded browser requires the local Studio desktop."));
		if (!this.#ready) {
			this.#ready = this.#start();
			void this.#ready.catch(error =>
				logger.error("Embedded browser initialization failed", { error: String(error) }),
			);
		}
		return this.#ready;
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
		await this.#ensureReady();
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
		await this.#ensureReady();
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

	pageForTarget(targetId: string): { pageId: string; documentId?: string } | undefined {
		const target = this.#server?.bridge.listTargets().find(row => row.id === targetId);
		return target?.studioPageId
			? { pageId: target.studioPageId, ...(target.studioDocumentId ? { documentId: target.studioDocumentId } : {}) }
			: undefined;
	}
	#nativeTab(sessionId: string, pageId: string): TabSession | undefined {
		if (sessionId !== this.session.sessionId) return;
		const owners = new Set(
			ownedStudioSessions(this.session)
				.map(owner => owner.studioEvalKernelOwnerId)
				.filter(Boolean),
		);
		return listTabs()
			.map(row => getTab(row.name))
			.find(tab => tab?.state === "alive" && owners.has(tab.ownerSessionId) && studioTabIdentity(tab) === pageId);
	}
	async webMcpList(sessionId: string, pageId: string, options?: WebMcpListOptions): Promise<StudioWebMcpCatalog> {
		const native = this.#nativeTab(sessionId, pageId);
		if (native) {
			if (native.backend !== "worker")
				return {
					pageId,
					status: "unavailable",
					tools: [],
					truncated: false,
					untrusted: true,
					invocationAvailable: false,
					reason: "Native WebMCP requires an actual Chromium engine; WebKit does not expose it.",
				};
			const result = await this.#nativeWebMcp(native, { action: "list", options });
			return {
				...(result.value as WebMcpListResult),
				pageId,
				documentId: result.documentId,
				invocationAvailable: result.chromiumMajor >= 149,
			};
		}
		if (sessionId === this.session.sessionId) {
			const remote = await remoteNativeBrowserPage(this.session, pageId);
			if (remote) {
				if (remote.tab.engine !== "chromium")
					return {
						pageId,
						status: "unavailable",
						tools: [],
						truncated: false,
						untrusted: true,
						invocationAvailable: false,
						reason: remote.tab.capabilities.reasons.webmcp ?? "WebMCP requires actual Chromium.",
					};
				if (!remote.access.webMcpList)
					throw new ToolError(
						"This native home has no WebMCP callback; its page was not recreated in the main thread.",
					);
				return await remote.access.webMcpList({
					kind: "browser.webmcp.list",
					sessionId: remote.tab.sessionId,
					pageId,
					options,
				});
			}
		}
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
		const native = this.#nativeTab(operation.sessionId, operation.pageId);
		if (native) {
			const result = await this.#nativeWebMcp(
				native,
				{ action: "invoke", name: operation.name, params: operation.params, options: operation.options },
				operation.documentId,
			);
			return result.value as WebMcpInvokeResult;
		}
		const remote = await remoteNativeBrowserPage(this.session, operation.pageId);
		if (remote) {
			if (remote.tab.engine !== "chromium" || !remote.access.webMcpInvoke)
				throw new ToolError(
					remote.tab.capabilities.reasons.webmcp ??
						"This native home cannot invoke WebMCP; the page was not recreated.",
				);
			return await remote.access.webMcpInvoke({ ...operation, sessionId: remote.tab.sessionId });
		}
		const { value } = await this.#webMcp(
			operation.pageId,
			{ action: "invoke", name: operation.name, params: operation.params, options: operation.options },
			operation.documentId,
		);
		return value as WebMcpInvokeResult;
	}

	async #nativeWebMcp(
		tab: TabSession,
		operation: TabWebMcpRequest,
		expectedDocument?: string,
	): Promise<{ value: unknown; documentId: string; chromiumMajor: number }> {
		if (tab.backend !== "worker") throw new ToolError("Native WebMCP requires Chromium.");
		const session = this.session.studioToolSession;
		if (!session) throw new ToolError("The native browser tool session is unavailable.");
		const generation = studioTabIdentity(tab);
		const cdp = await createStudioBrowserObservation(tab);
		try {
			const document = async () => {
				const tree = await cdp.send("Page.getFrameTree");
				const frame = tree.frameTree.frame;
				return createHash("sha256").update(`${generation}:${frame.loaderId}:${frame.url}`).digest("hex");
			};
			const documentId = await document();
			if (operation.action === "invoke" && documentId !== expectedDocument)
				throw new ToolError("The native page navigated. Refresh WebMCP before invoking a tool.");
			const version = await tab.browser.browser.version();
			const chromiumMajor = Number(/(?:Chrome|Chromium|HeadlessChrome)\/(\d+)/u.exec(version)?.[1] ?? 0);
			if (!chromiumMajor) throw new ToolError("This native target is not a verified Chromium engine.");
			const result = await runInTab(tab.name, {
				code: "",
				webmcp: operation,
				timeoutMs: operation.action === "invoke" ? (operation.options?.timeout ?? 10000) : 10000,
				session,
				signal: AbortSignal.timeout(operation.action === "invoke" ? (operation.options?.timeout ?? 10000) : 10000),
			});
			if (generation !== studioTabIdentity(tab) || getTab(tab.name) !== tab || documentId !== (await document()))
				throw new ToolError("The native page changed during WebMCP discovery or invocation.");
			return { value: result.returnValue, documentId, chromiumMajor };
		} finally {
			await cdp.detach().catch(() => undefined);
		}
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
