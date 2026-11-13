import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSession } from "../../session/agent-session";
import { createBrowserPrelude, type BrowserPreludeDetails } from "../../tools/browser";
import {
	getTab,
	listTabs,
	releaseTab,
	resumeStudioBrowserControl,
	settleStudioBrowserControl,
	type TabSession,
} from "../../tools/browser/tab-supervisor";
import {
	validateBrowserObservationInput,
	type BrowserObservationEvent,
	type BrowserObservationInput,
	type BrowserObservationOperation,
	type BrowserObservationResultMap,
	type BrowserPageCapabilities,
	type StudioBrowserTab,
} from "../browser-observation-protocol";
import {
	acquireStudioTabControl,
	releaseStudioTabControl,
	studioTabControlState,
	studioTabIdentity,
} from "./browser-tab-control";
import {
	NativeBrowserObservationAdapter,
	type ObservedBrowserFrame,
	type ObservedBrowserState,
} from "./browser-observation-adapter";
import { managedBrowserFor, StudioManagedBrowserService } from "./managed-browser-service";
import type { StudioWebMcpCatalog, WebMcpInvokeResult, WebMcpListOptions, WebMcpOperation } from "../webmcp-protocol";
import { ownedStudioSessions } from "./owned-sessions";
import { SessionControlError } from "./session-control-service";

export type NativeBrowserOperation = Exclude<BrowserObservationOperation, { kind: "browser.managed.prepare" }>;
export type NativeBrowserResult = BrowserObservationResultMap[NativeBrowserOperation["kind"]];
export interface NativeWebMcpRead {
	kind: "browser.webmcp.list";
	sessionId: string;
	pageId: string;
	options?: WebMcpListOptions;
}
/** Private native-home callback also routes the already-public WebMCP APIs to the same worker target. */
export type NativeBrowserHomeOperation = NativeBrowserOperation | NativeWebMcpRead | WebMcpOperation;
export type NativeBrowserHomeResult = NativeBrowserResult | StudioWebMcpCatalog | WebMcpInvokeResult;
export interface StudioBrowserObservationAccess {
	tabs(): Promise<StudioBrowserTab[]>;
	execute(operation: NativeBrowserOperation): Promise<NativeBrowserResult>;
	webMcpList?(operation: NativeWebMcpRead): Promise<StudioWebMcpCatalog>;
	webMcpInvoke?(operation: WebMcpOperation): Promise<WebMcpInvokeResult>;
}
let remoteAccess: ((sessionId: string) => StudioBrowserObservationAccess | undefined) | undefined;
/** Existing thread broker supplies remote native owners; no page is recreated in the main thread. */
export function installBrowserObservationAccess(
	resolve: (sessionId: string) => StudioBrowserObservationAccess | undefined,
): void {
	remoteAccess = resolve;
}
export async function remoteNativeBrowserPage(
	session: AgentSession,
	pageId: string,
): Promise<{ tab: StudioBrowserTab; access: StudioBrowserObservationAccess } | undefined> {
	for (const owner of ownedStudioSessions(session)) {
		if (owner.sessionId === session.sessionId) continue;
		const access = remoteAccess?.(owner.sessionId);
		if (!access) continue;
		const tab = (await access.tabs()).find(tab => tab.id === pageId);
		if (tab) return { tab, access };
	}
	return undefined;
}
export function browserObservationSocketName(id: string): string {
	return "b-" + createHash("sha256").update(id).digest("hex").slice(0, 16) + ".sock";
}
interface Observation {
	id: string;
	sessionId: string;
	tab: TabSession;
	tabId: string;
	generation: string;
	targetId: string;
	token: string;
	descriptor: string;
	endpoint: string;
	server: Server;
	peers: Set<Socket>;
	socket?: Socket;
	adapter?: NativeBrowserObservationAdapter;
	ready?: Promise<void>;
	initialized: boolean;
	closed: boolean;
	visible: boolean;
	capture: boolean;
	lastPing: number;
	sequence: number;
	inFlight: number;
	acknowledged: number;
	frame?: ObservedBrowserFrame | undefined;
	displayed?: ObservedBrowserState | undefined;
	pendingCalls: number;
	pendingInputs: number;
	chain: Promise<void>;
	timer: NodeJS.Timeout;
	pumping: boolean;
	tick: number;
	stateKey?: string | undefined;
	requestedControl: boolean;
	resumed: boolean;
	leaseId?: string | undefined;
	wasFrozen: boolean;
	releaseHost?: () => void;
	resuming?: Promise<void> | undefined;
	returning?: Promise<void> | undefined;
}

/** The native tab registry is authoritative. This service owns only private observation leases and one ACK-paced pump. */
export class StudioBrowserObservationService {
	readonly #observations = new Map<string, Observation>();
	readonly #engines = new WeakMap<object, Promise<"chromium" | "webkit" | "unknown">>();
	readonly #notices = new WeakMap<TabSession, string[]>();
	#nativeWebMcp?: StudioManagedBrowserService;
	#disposed = false;
	constructor(
		readonly session: AgentSession,
		readonly directory = process.env.OMP_STUDIO_MEDIA_ROOT,
		readonly socketDirectory = process.env.OMP_STUDIO_SOCKET_DIR,
		readonly retainHost?: () => () => void,
	) {}
	#owners(): Map<string, string> {
		const owners = new Map<string, string>();
		for (const session of ownedStudioSessions(this.session)) {
			const owner = session.studioEvalKernelOwnerId;
			if (owner) owners.set(owner, session.sessionId);
		}
		return owners;
	}
	#tabs(): TabSession[] {
		const owners = this.#owners();
		return listTabs()
			.map(row => getTab(row.name))
			.filter(
				(tab): tab is TabSession =>
					!!tab && tab.state === "alive" && !!tab.ownerSessionId && owners.has(tab.ownerSessionId),
			)
			.slice(0, 128);
	}
	async #engine(tab: TabSession): Promise<"chromium" | "webkit" | "unknown"> {
		if (tab.backend === "webkit" || tab.backend === "tern") return "webkit";
		if (tab.backend !== "worker") return "unknown";
		let engine = this.#engines.get(tab.browser);
		if (!engine) {
			engine = tab.browser.browser.version().then(
				version =>
					/(?:Chrome|Chromium|Electron|Edg)\//iu.test(version) ? ("chromium" as const) : ("unknown" as const),
				() => "unknown" as const,
			);
			this.#engines.set(tab.browser, engine);
		}
		const actual = await engine;
		if (actual === "unknown" && this.#engines.get(tab.browser) === engine) this.#engines.delete(tab.browser);
		return actual;
	}
	async #describe(tab: TabSession): Promise<StudioBrowserTab> {
		const engine = await this.#engine(tab);
		const channel = !!this.directory && (process.platform === "win32" || !!this.socketDirectory);
		const raw = tab.backend === "worker" || tab.backend === "webkit" || tab.backend === "tern";
		const embedded = tab.browser.kind.kind === "relay" && tab.browser.kind.studioManaged === true;
		const owner = this.#owners().get(tab.ownerSessionId!);
		const embeddedPageId = embedded ? managedBrowserFor(owner)?.pageForTarget?.(tab.targetId)?.pageId : undefined;
		const fullCdp =
			engine === "chromium" && (!embedded && tab.kindTag === "relay" ? false : tab.backend === "worker");
		const observable = channel && raw,
			notices = this.#notices.get(tab);
		const capabilities: BrowserPageCapabilities = {
			observe: observable,
			control: observable,
			nativeViewer: tab.backend === "webkit" && tab.browser.webkit.canShow,
			history: raw,
			console: raw,
			network: raw,
			downloads: raw,
			webmcp: engine === "chromium" && tab.backend === "worker",
			pdf: fullCdp,
			cdp: fullCdp,
			tracing: fullCdp,
			zoom: embedded,
			find: embedded,
			pick: embedded,
			devtools: embedded,
			settings: embedded,
			reasons: {},
		};
		if (!channel)
			capabilities.reasons.observe = capabilities.reasons.control =
				"The authenticated local observation channel is unavailable.";
		if (!raw)
			capabilities.reasons.observe = capabilities.reasons.control =
				"This native backend exposes no raw same-page capture/control adapter.";
		if (!capabilities.nativeViewer)
			capabilities.reasons.nativeViewer = "This engine/platform provides no same-view native viewer.";
		if (engine === "webkit") {
			capabilities.reasons.webmcp =
				"Native WebMCP requires an actual Chromium engine; it is not available in WebKit.";
			capabilities.reasons.pdf =
				capabilities.reasons.cdp =
				capabilities.reasons.tracing =
					"WebKit does not provide PDF, full CDP, response-body capture or tracing through this adapter.";
			capabilities.reasons.network = "Native request metadata only; response bodies are not available in WebKit.";
		} else if (engine === "unknown") {
			capabilities.reasons.webmcp = "This target's actual engine is not verified as Chromium.";
			capabilities.reasons.pdf =
				capabilities.reasons.cdp =
				capabilities.reasons.tracing =
					"The actual engine is unverified; Studio cannot promise these Chromium capabilities.";
		} else if (!fullCdp)
			capabilities.reasons.cdp =
				capabilities.reasons.pdf =
				capabilities.reasons.tracing =
					"The external Chrome extension exposes a limited CDP subset.";
		for (const key of ["zoom", "find", "pick", "devtools", "settings"] as const)
			if (!capabilities[key])
				capabilities.reasons[key] = "This Studio action belongs to the explicit embedded adapter.";
		return {
			id: studioTabIdentity(tab),
			generation: studioTabIdentity(tab),
			targetId: tab.targetId,
			sessionId: owner ?? this.session.sessionId,
			ownerSessionId: tab.ownerSessionId!,
			ownership:
				tab.backend === "worker"
					? tab.ownsPage
						? "owned"
						: "borrowed"
					: tab.backend === "tern"
						? tab.ternTab.adopted
							? "borrowed"
							: "owned"
						: tab.backend === "cmux"
							? tab.cmuxOwnsSurface
								? "owned"
								: "borrowed"
							: "owned",
			engine,
			transport: embedded && embeddedPageId ? "embedded" : observable ? "frames" : "none",
			capabilities,
			...(notices?.length ? { notices } : {}),
			...(embeddedPageId ? { embeddedPageId } : {}),
			name: tab.name.slice(0, 4096),
			title: (tab.info.title ?? "").slice(0, 4096),
			url: tab.info.url.slice(0, 4096),
			kind: tab.kindTag,
			busy: tab.pending.size > 0,
			frozen: tab.frozen,
			observable,
			...(!observable && capabilities.reasons.observe ? { reason: capabilities.reasons.observe } : {}),
		};
	}
	/** Only tabs homed in this thread. The caller's existing thread broker can aggregate descendants. */
	async tabs(): Promise<StudioBrowserTab[]> {
		return await Promise.all(this.#tabs().map(tab => this.#describe(tab)));
	}
	async #allTabs(): Promise<StudioBrowserTab[]> {
		const local = await this.tabs();
		if (!remoteAccess) return local;
		const remote = await Promise.all(
			ownedStudioSessions(this.session)
				.filter(owner => owner.sessionId !== this.session.sessionId)
				.map(async owner => (await remoteAccess?.(owner.sessionId)?.tabs()) ?? []),
		);
		return [...new Map([...local, ...remote.flat()].map(tab => [tab.id, tab])).values()].slice(0, 128);
	}
	async executeHome(operation: NativeBrowserHomeOperation): Promise<NativeBrowserHomeResult> {
		if (this.#disposed || operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The native browser session home changed.");
		if (operation.kind !== "browser.webmcp.list" && operation.kind !== "browser.webmcp.invoke")
			return await this.execute(operation);
		const release = this.retainHost?.();
		try {
			// Native discovery does not initialize an embedded relay or a second page.
			this.#nativeWebMcp ??= new StudioManagedBrowserService(this.session, { enabled: false, directory: undefined });
			return operation.kind === "browser.webmcp.list"
				? await this.#nativeWebMcp.webMcpList(operation.sessionId, operation.pageId, operation.options)
				: await this.#nativeWebMcp.webMcpInvoke(operation);
		} finally {
			release?.();
		}
	}
	async execute(operation: NativeBrowserOperation): Promise<NativeBrowserResult> {
		if (this.#disposed || operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The active session changed; reload browser targets");
		if (operation.kind === "browser.tabs.get") return { tabs: await this.#allTabs() };
		if (operation.kind === "browser.native.open") {
			const toolSession = this.session.studioToolSession;
			if (!toolSession)
				throw new SessionControlError("CAPABILITY_UNAVAILABLE", "The native browser tool session is not ready.");
			const url = new URL(operation.url);
			if (
				(!["http:", "https:"].includes(url.protocol) && operation.url !== "about:blank") ||
				url.username ||
				url.password
			)
				throw new SessionControlError("COMMAND_BLOCKED", "Open an HTTP(S) URL without embedded credentials.");
			if (operation.app === "embedded")
				throw new SessionControlError("COMMAND_BLOCKED", "Use the dedicated embedded browser adapter.");
			const name = `studio-page-${randomUUID()}`;
			const parameters = {
				action: "open",
				name,
				url: operation.url,
				...(operation.app === undefined ? {} : { app: operation.app }),
				...(operation.argv === undefined ? {} : { argv: operation.argv }),
				...(operation.target === undefined ? {} : { target: operation.target }),
				...(operation.insecure === undefined ? {} : { insecure: operation.insecure }),
			};
			const opened = await createBrowserPrelude(toolSession).invoke(parameters, {
				session: toolSession,
				toolCallId: name,
			});
			const tab = getTab(name);
			if (!tab) throw new SessionControlError("COMMAND_BLOCKED", "The native open produced no live tab.");
			const details = opened.details as BrowserPreludeDetails;
			if (details.notices?.length)
				this.#notices.set(
					tab,
					details.notices.slice(0, 8).map(notice => notice.slice(0, 4096)),
				);
			return { tab: await this.#describe(tab) };
		}
		const tab = this.#tabs().find(value => studioTabIdentity(value) === operation.tabId);
		if (!tab) {
			const remote = (await this.#allTabs()).find(value => value.id === operation.tabId);
			const access =
				remote && remote.sessionId !== this.session.sessionId ? remoteAccess?.(remote.sessionId) : undefined;
			if (access) return await access.execute({ ...operation, sessionId: remote!.sessionId });
			throw new SessionControlError("COMMAND_BLOCKED", "This native target is no longer available.");
		}
		if (operation.kind === "browser.native.close") {
			if (operation.generation !== studioTabIdentity(tab))
				throw new SessionControlError("COMMAND_BLOCKED", "The native target generation changed.");
			const holder = randomUUID(),
				deadline = Date.now() + 60_000;
			try {
				acquireStudioTabControl(tab, holder);
				while (tab.pending.size) {
					if (
						Date.now() >= deadline ||
						getTab(tab.name) !== tab ||
						operation.generation !== studioTabIdentity(tab)
					)
						throw new SessionControlError(
							"COMMAND_BLOCKED",
							"The current native action is still running or the target changed; the page was not closed.",
						);
					acquireStudioTabControl(tab, holder);
					await Bun.sleep(50);
				}
				return { closed: await releaseTab(tab.name, { kill: false }) };
			} finally {
				releaseStudioTabControl(tab, holder);
			}
		}
		if (!(await this.#describe(tab)).observable)
			throw new SessionControlError(
				"CAPABILITY_UNAVAILABLE",
				"This target provides no same-page observation channel.",
			);
		if (this.#observations.size >= 4)
			throw new SessionControlError("COMMAND_BLOCKED", "Too many active browser observations.");
		return await this.#prepare(tab);
	}
	async #prepare(
		tab: TabSession,
	): Promise<{ observationId: string; sessionId: string; tabId: string; generation: string; expiresAt: number }> {
		const id = randomUUID(),
			sessionId = this.session.sessionId,
			generation = studioTabIdentity(tab),
			tabId = generation;
		const endpoint =
			process.platform === "win32"
				? "\\\\.\\pipe\\omp-studio-browser-" + id
				: path.join(this.socketDirectory!, browserObservationSocketName(id));
		if (process.platform !== "win32" && Buffer.byteLength(endpoint) > 103)
			throw new SessionControlError("COMMAND_BLOCKED", "Browser socket path is too long.");
		const directory = path.join(this.directory!, "browser");
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const descriptor = path.join(directory, id + ".json"),
			token = randomBytes(32).toString("hex");
		const server = createServer(socket => this.#connect(observation, socket));
		const observation: Observation = {
			id,
			sessionId,
			tab,
			tabId,
			generation,
			targetId: tab.targetId,
			token,
			descriptor,
			endpoint,
			server,
			peers: new Set(),
			initialized: false,
			closed: false,
			visible: false,
			capture: false,
			lastPing: Date.now(),
			sequence: 0,
			inFlight: 0,
			acknowledged: 0,
			pendingCalls: 0,
			pendingInputs: 0,
			chain: Promise.resolve(),
			timer: setInterval(() => void this.#pump(observation), 100),
			pumping: false,
			tick: 0,
			requestedControl: false,
			resumed: false,
			wasFrozen: false,
		};
		observation.timer.unref();
		observation.releaseHost = this.retainHost?.();
		this.#observations.set(id, observation);
		try {
			const listening = Promise.withResolvers<void>();
			server.once("error", listening.reject);
			server.listen(endpoint, listening.resolve);
			await listening.promise;
			const expiresAt = Date.now() + 15_000;
			await fs.writeFile(
				descriptor,
				JSON.stringify({ version: 2, observationId: id, sessionId, tabId, generation, endpoint, token, expiresAt }),
				{ flag: "wx", mode: 0o600 },
			);
			return { observationId: id, sessionId, tabId, generation, expiresAt };
		} catch (error) {
			this.#close(observation);
			throw error;
		}
	}
	#current(o: Observation): boolean {
		return (
			!this.#disposed &&
			!o.closed &&
			this.session.sessionId === o.sessionId &&
			getTab(o.tab.name) === o.tab &&
			o.tab.state === "alive" &&
			o.tab.targetId === o.targetId &&
			studioTabIdentity(o.tab) === o.generation &&
			!!o.tab.ownerSessionId &&
			this.#owners().has(o.tab.ownerSessionId)
		);
	}
	#connect(o: Observation, socket: Socket): void {
		if (!this.#current(o) || o.socket || o.peers.size >= 2) {
			socket.destroy();
			return;
		}
		o.peers.add(socket);
		let authenticated = false,
			pending = "";
		const handshakeTimer = setTimeout(() => {
			if (!authenticated) socket.destroy();
		}, 3000);
		handshakeTimer.unref();
		socket.on("error", () => {});
		socket.once("close", () => {
			clearTimeout(handshakeTimer);
			o.peers.delete(socket);
			if (o.socket === socket) this.#close(o);
		});
		socket.on("data", bytes => {
			pending += bytes.toString("utf8");
			if (pending.length > 32768) {
				socket.destroy();
				return;
			}
			for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
				const line = pending.slice(0, at);
				pending = pending.slice(at + 1);
				if (!authenticated) {
					if (
						line.length !== 64 ||
						!timingSafeEqual(Buffer.from(line), Buffer.from(o.token)) ||
						o.socket ||
						!this.#current(o)
					) {
						socket.destroy();
						return;
					}
					authenticated = true;
					clearTimeout(handshakeTimer);
					o.socket = socket;
					o.lastPing = Date.now();
					socket.write("OK\n");
					void fs.unlink(o.descriptor).catch(() => {});
					const session = this.session.studioToolSession;
					if (!session) {
						this.#fail(o, new Error("Native browser tool session is unavailable."));
						return;
					}
					o.adapter = new NativeBrowserObservationAdapter(
						o.tab,
						session,
						() => this.#current(o),
						o.id,
						() =>
							this.#current(o) &&
							o.visible &&
							o.capture &&
							o.requestedControl &&
							o.resumed &&
							studioTabControlState(o.tab, o.id) === "human",
					);
					o.ready = this.#bounded(o, () => o.adapter!.start()).then(() => {
						if (this.#current(o)) o.initialized = true;
					});
					void o.ready.catch(error => this.#fail(o, error));
					continue;
				}
				try {
					const input: unknown = JSON.parse(line);
					validateBrowserObservationInput(input);
					if (!this.#current(o)) {
						this.#close(o);
						return;
					}
					if (input.kind === "ping") {
						o.lastPing = Date.now();
						if (o.requestedControl && o.visible && o.capture) acquireStudioTabControl(o.tab, o.id);
						continue;
					}
					if (input.kind === "ack") {
						if (input.generation === o.generation && input.sequence === o.inFlight && o.frame) {
							const {
								data: _data,
								width: _width,
								height: _height,
								timestamp: _timestamp,
								...displayed
							} = o.frame;
							o.displayed = displayed;
							o.acknowledged = input.sequence;
							o.inFlight = 0;
						}
						continue;
					}
					// Visibility is applied before the queued input, so an already running
					// capture cannot publish after the panel/window went away.
					if (input.kind === "visibility") {
						o.visible = input.visible;
						o.capture = input.visible && input.capture !== false;
						o.lastPing = Date.now();
					}
					if (++o.pendingInputs > 16) throw new Error("Too many pending browser controls.");
					o.chain = o.chain.then(async () => {
						try {
							await this.#input(o, input);
						} catch (error) {
							this.#send(o, {
								kind: "error",
								observationId: o.id,
								message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
							});
						} finally {
							o.pendingInputs--;
						}
					});
				} catch {
					socket.destroy();
					return;
				}
			}
		});
	}
	async #bounded<T>(o: Observation, action: () => Promise<T>): Promise<T> {
		if (!this.#current(o) || o.pendingCalls >= 8)
			throw new Error("Browser observation expired or exceeded its request budget.");
		o.pendingCalls++;
		const operation = action().finally(() => {
			o.pendingCalls--;
		});
		const expired = Promise.withResolvers<never>();
		const timer = setTimeout(() => expired.reject(new Error("Browser observation request timed out.")), 3000);
		try {
			return await Promise.race([operation, expired.promise]);
		} finally {
			clearTimeout(timer);
		}
	}
	async #pump(o: Observation): Promise<void> {
		if (!this.#current(o) || Date.now() - o.lastPing > 15_000) {
			this.#close(o);
			return;
		}
		if (!o.initialized || !o.adapter || !o.socket || !o.visible || !o.capture || o.pumping) return;
		o.pumping = true;
		try {
			if (o.requestedControl && studioTabControlState(o.tab, o.id) === "human" && !o.resumed) {
				o.resuming = this.#bounded(o, () => resumeStudioBrowserControl(o.tab)).then(() => {
					o.resumed = true;
				});
				try {
					await o.resuming;
				} finally {
					o.resuming = undefined;
				}
				if (!o.visible || !o.capture || !o.requestedControl || !this.#current(o)) return;
			}
			if (o.tick++ % 10 === 0) {
				const page = await this.#bounded(o, () => o.adapter!.state());
				if (!this.#current(o) || !o.visible) return;
				const control = studioTabControlState(o.tab, o.id);
				const state: BrowserObservationEvent = {
					kind: "state",
					observationId: o.id,
					tabId: o.tabId,
					generation: o.generation,
					documentEpoch: page.documentEpoch,
					title: page.title,
					url: page.url,
					frozen: o.tab.frozen,
					busy: o.tab.pending.size > 0,
					viewerVisible: o.adapter!.viewerVisible,
					control: control === "human" && !o.resumed ? "waiting" : control,
					...(control === "human" && o.resumed && o.leaseId ? { leaseId: o.leaseId } : {}),
					...(page.canGoBack === undefined ? {} : { canGoBack: page.canGoBack }),
					...(page.canGoForward === undefined ? {} : { canGoForward: page.canGoForward }),
				};
				const key = JSON.stringify(state);
				if (key !== o.stateKey) {
					o.stateKey = key;
					this.#send(o, state);
				}
				o.tab.info = {
					...o.tab.info,
					title: page.title,
					url: page.url,
					viewport: { ...o.tab.info.viewport, width: page.cssWidth, height: page.cssHeight },
				};
			}
			if (o.capture && o.inFlight === 0) {
				const frame = await this.#bounded(o, () =>
					o.adapter!.frame(() => this.#current(o) && o.visible && o.capture),
				);
				if (!frame || !this.#current(o) || !o.visible || !o.capture) return;
				o.frame = frame;
				o.inFlight = ++o.sequence;
				this.#send(o, {
					kind: "frame",
					observationId: o.id,
					tabId: o.tabId,
					generation: o.generation,
					documentEpoch: frame.documentEpoch,
					sequence: o.sequence,
					data: frame.data,
					width: frame.width,
					height: frame.height,
					cssWidth: frame.cssWidth,
					cssHeight: frame.cssHeight,
					timestamp: frame.timestamp,
				});
			}
		} catch (error) {
			this.#fail(o, error);
		} finally {
			o.pumping = false;
		}
	}
	#returnControl(o: Observation): Promise<void> {
		if (o.returning) return o.returning;
		o.requestedControl = false;
		o.leaseId = undefined;
		o.stateKey = undefined;
		o.tick = 0;
		const operation = (async () => {
			try {
				// A hide/close racing resume must restore the formerly frozen view
				// only after the actual resume has finished, before admitting Agent work.
				await o.resuming?.catch(() => undefined);
				await o.adapter?.hideViewer();
				if (
					o.wasFrozen &&
					o.resumed &&
					getTab(o.tab.name) === o.tab &&
					studioTabIdentity(o.tab) === o.generation &&
					studioTabControlState(o.tab, o.id) !== "other-window"
				)
					await settleStudioBrowserControl(o.tab);
			} finally {
				o.resumed = false;
				o.wasFrozen = false;
				releaseStudioTabControl(o.tab, o.id);
			}
		})();
		o.returning = operation.finally(() => {
			o.returning = undefined;
		});
		return o.returning;
	}
	async #input(o: Observation, input: BrowserObservationInput): Promise<void> {
		if (!this.#current(o)) throw new Error("Browser observation expired.");
		if (input.kind === "visibility") {
			if (!o.visible || !o.capture) {
				o.frame = undefined;
				o.displayed = undefined;
				o.inFlight = 0;
				await this.#returnControl(o);
			}
			o.tick = 0;
			return;
		}
		if (input.kind === "take") {
			if (!o.visible || !o.capture || input.generation !== o.generation)
				throw new Error("Wait for a visible native page before taking control.");
			acquireStudioTabControl(o.tab, o.id);
			if (!o.requestedControl) {
				o.wasFrozen = o.tab.frozen;
				o.leaseId = randomUUID();
			}
			o.requestedControl = true;
			o.tick = 0;
			o.stateKey = undefined;
			return;
		}
		if (input.kind === "release") {
			await this.#returnControl(o);
			return;
		}
		if (input.kind === "ping" || input.kind === "ack") return;
		if (input.kind === "inspect") {
			if (!o.visible || !o.adapter) throw new Error("Page inspection requires a visible browser panel.");
			await o.ready;
			const descriptor = await this.#describe(o.tab);
			if (!descriptor.capabilities[input.view])
				throw new Error(
					descriptor.capabilities.reasons[input.view] ?? "This native view cannot expose this inspection.",
				);
			const inspection = await this.#bounded(o, () => o.adapter!.inspect(input.view));
			if (this.#current(o) && o.visible)
				this.#send(o, {
					kind: "inspection",
					observationId: o.id,
					tabId: o.tabId,
					generation: o.generation,
					inspection,
				});
			return;
		}
		if (
			!o.adapter ||
			!o.visible ||
			!o.capture ||
			!o.resumed ||
			studioTabControlState(o.tab, o.id) !== "human" ||
			input.generation !== o.generation ||
			input.leaseId !== o.leaseId ||
			input.documentEpoch === undefined
		)
			throw new Error("Wait for the current explicit human-control lease before interacting.");
		if (
			"sequence" in input &&
			(!o.displayed ||
				input.sequence > o.acknowledged ||
				input.documentEpoch !== o.displayed.documentEpoch ||
				((input.kind === "click" || input.kind === "wheel") && input.sequence !== o.acknowledged))
		)
			throw new Error("The displayed frame changed. Wait for a fresh frame and retry.");
		o.tab.lastActivityAt = Date.now();
		await this.#bounded(o, () => o.adapter!.input(input, o.displayed));
		o.tick = 0;
		o.stateKey = undefined;
	}
	#send(o: Observation, event: BrowserObservationEvent): void {
		if (!o.socket || o.closed) return;
		if (o.socket.writableLength > 4 * 1024 * 1024) {
			this.#close(o);
			return;
		}
		o.socket.write(JSON.stringify(event) + "\n");
	}
	#fail(o: Observation, error: unknown): void {
		this.#send(o, {
			kind: "error",
			observationId: o.id,
			message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
		});
		this.#close(o);
	}
	#close(o: Observation): void {
		if (o.closed) return;
		this.#send(o, { kind: "closed", observationId: o.id });
		o.closed = true;
		o.visible = false;
		o.capture = false;
		clearInterval(o.timer);
		o.frame = undefined;
		o.displayed = undefined;
		o.adapter?.dispose();
		void this.#returnControl(o).then(
			() => o.releaseHost?.(),
			() => {
				releaseStudioTabControl(o.tab, o.id);
				o.releaseHost?.();
			},
		);
		for (const peer of o.peers) peer.destroy();
		o.peers.clear();
		o.server.close();
		void fs.unlink(o.descriptor).catch(() => {});
		this.#observations.delete(o.id);
	}
	dispose(): void {
		this.#disposed = true;
		for (const observation of this.#observations.values()) this.#close(observation);
		this.#nativeWebMcp?.dispose();
	}
}
