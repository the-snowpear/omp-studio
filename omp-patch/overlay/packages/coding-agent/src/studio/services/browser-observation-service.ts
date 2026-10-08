import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CDPSession } from "puppeteer-core";
import { ownedStudioSessions } from "./owned-sessions";
import type { AgentSession } from "../../session/agent-session";
import {
	createStudioBrowserObservation,
	getTab,
	listTabs,
	resumeStudioBrowserControl,
	settleStudioBrowserControl,
	type TabSession,
} from "../../tools/browser/tab-supervisor";
import {
	BROWSER_FRAME_MAX_BASE64,
	validateBrowserObservationInput,
	type BrowserObservationEvent,
	type BrowserObservationInput,
	type BrowserObservationOperation,
	type StudioBrowserTab,
} from "../browser-observation-protocol";
import {
	acquireStudioTabControl,
	releaseStudioTabControl,
	studioTabControlState,
	studioTabIdentity,
} from "./browser-tab-control";
import { SessionControlError } from "./session-control-service";

export function browserObservationSocketName(id: string): string {
	return "b-" + createHash("sha256").update(id).digest("hex").slice(0, 16) + ".sock";
}
interface Observation {
	id: string;
	sessionId: string;
	tab: TabSession;
	tabId: string;
	token: string;
	descriptor: string;
	endpoint: string;
	server: Server;
	peers: Set<Socket>;
	socket?: Socket;
	cdp?: CDPSession;
	closed: boolean;
	lastPing: number;
	sequence: number;
	inFlight: number;
	acknowledged: number;
	documentEpoch: number;
	frameEpoch: number;
	width: number;
	height: number;
	candidate?: { data: string; timestamp: number; documentEpoch: number };
	pendingCalls: number;
	pendingInputs: number;
	chain: Promise<void>;
	timer: NodeJS.Timeout;
	pumping: boolean;
	tick: number;
	stateKey?: string;
	requestedControl: boolean;
	resumed: boolean;
	wasFrozen?: boolean;
}
/** Runtime-owned observation of the exact managed target. Bytes and credentials use a private local pipe. */
export class StudioBrowserObservationService {
	readonly #observations = new Map<string, Observation>();
	#disposed = false;
	constructor(
		readonly session: AgentSession,
		readonly directory = process.env.OMP_STUDIO_MEDIA_ROOT,
		readonly socketDirectory = process.env.OMP_STUDIO_SOCKET_DIR,
	) {}
	#owners(): Set<string> {
		return new Set(ownedStudioSessions(this.session).map(session => session.sessionId));
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
	#describe(tab: TabSession): StudioBrowserTab {
		const observable =
			tab.backend === "worker" && !!this.directory && (process.platform === "win32" || !!this.socketDirectory);
		return {
			id: studioTabIdentity(tab),
			name: tab.name.slice(0, 4096),
			title: (tab.info.title ?? "").slice(0, 4096),
			url: tab.info.url.slice(0, 4096),
			kind: tab.kindTag,
			ownerSessionId: tab.ownerSessionId!,
			busy: tab.pending.size > 0,
			frozen: tab.frozen,
			observable,
			...(!observable
				? {
						reason:
							tab.backend !== "worker"
								? "This backend does not provide an observable CDP target."
								: "The private desktop observation channel is unavailable.",
					}
				: {}),
		};
	}
	async execute(operation: BrowserObservationOperation): Promise<unknown> {
		if (this.#disposed || operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The active session changed; reload browser targets");
		const tabs = this.#tabs();
		if (operation.kind === "browser.tabs.get") return { tabs: tabs.map(tab => this.#describe(tab)) };
		const tab = tabs.find(value => studioTabIdentity(value) === operation.tabId);
		if (!tab || !this.#describe(tab).observable)
			throw new SessionControlError("COMMAND_BLOCKED", "This target is no longer observable");
		if (this.#observations.size >= 4)
			throw new SessionControlError("COMMAND_BLOCKED", "Too many active browser observations");
		return this.#prepare(tab);
	}
	async #prepare(
		tab: TabSession,
	): Promise<{ observationId: string; sessionId: string; tabId: string; expiresAt: number }> {
		const id = randomUUID();
		const sessionId = this.session.sessionId;
		const tabId = studioTabIdentity(tab);
		const endpoint =
			process.platform === "win32"
				? "\\\\.\\pipe\\omp-studio-browser-" + id
				: path.join(this.socketDirectory!, browserObservationSocketName(id));
		if (process.platform !== "win32" && Buffer.byteLength(endpoint) > 103)
			throw new SessionControlError("COMMAND_BLOCKED", "Browser observation socket path is too long");
		const directory = path.join(this.directory!, "browser");
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const descriptor = path.join(directory, id + ".json");
		const token = randomBytes(32).toString("hex");
		const server = createServer(socket => this.#connect(observation, socket));
		const observation: Observation = {
			id,
			sessionId,
			tab,
			tabId,
			token,
			endpoint,
			descriptor,
			server,
			peers: new Set(),
			closed: false,
			lastPing: Date.now(),
			sequence: 0,
			inFlight: 0,
			acknowledged: 0,
			documentEpoch: 0,
			frameEpoch: 0,
			width: 1,
			height: 1,
			pendingCalls: 0,
			pendingInputs: 0,
			chain: Promise.resolve(),
			timer: setInterval(() => void this.#pump(observation), 100),
			pumping: false,
			tick: 0,
			requestedControl: false,
			resumed: false,
		};
		observation.timer.unref();
		this.#observations.set(id, observation);
		try {
			const listening = Promise.withResolvers<void>();
			server.once("error", listening.reject);
			server.listen(endpoint, listening.resolve);
			await listening.promise;
			const expiresAt = Date.now() + 15_000;
			await fs.writeFile(
				descriptor,
				JSON.stringify({ version: 1, observationId: id, sessionId, tabId, endpoint, token, expiresAt }),
				{ flag: "wx", mode: 0o600 },
			);
			return { observationId: id, sessionId, tabId, expiresAt };
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
			studioTabIdentity(o.tab) === o.tabId &&
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
		let authenticated = false;
		let pending = "";
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
			for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (!authenticated) {
					const valid = line.length === 64 && timingSafeEqual(Buffer.from(line), Buffer.from(o.token));
					if (!valid || o.socket || !this.#current(o)) {
						socket.destroy();
						return;
					}
					authenticated = true;
					clearTimeout(handshakeTimer);
					o.socket = socket;
					o.lastPing = Date.now();
					socket.write("OK\n");
					void fs.unlink(o.descriptor).catch(() => {});
					void this.#start(o).catch(error => this.#fail(o, error));
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
						if (o.requestedControl) acquireStudioTabControl(o.tab, o.id);
						continue;
					}
					if (input.kind === "ack") {
						if (input.sequence === o.inFlight) {
							o.acknowledged = input.sequence;
							o.inFlight = 0;
						}
						continue;
					}
					if (++o.pendingInputs > 16) throw new Error("Too many pending browser controls");
					o.chain = o.chain.then(async () => {
						try {
							await this.#input(o, input);
						} catch (error) {
							this.#send(o, {
								kind: "error",
								observationId: o.id,
								message: error instanceof Error ? error.message : String(error),
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
			throw new Error("Browser observation expired or exceeded its request budget");
		o.pendingCalls++;
		const expired = Promise.withResolvers<never>();
		const timer = setTimeout(() => expired.reject(new Error("Browser observation request timed out")), 3000);
		try {
			return await Promise.race([action(), expired.promise]);
		} finally {
			clearTimeout(timer);
			o.pendingCalls--;
		}
	}
	async #start(o: Observation): Promise<void> {
		const cdp = await this.#bounded(o, () => createStudioBrowserObservation(o.tab));
		if (!this.#current(o)) {
			await cdp.detach();
			return;
		}
		o.cdp = cdp;
		cdp.on("Page.frameNavigated", event => {
			if (!event.frame.parentId) {
				o.documentEpoch++;
				o.candidate = undefined;
			}
		});
		cdp.on("Page.screencastFrame", event => {
			if (!this.#current(o)) {
				this.#close(o);
				return;
			}
			if (
				event.data.length > BROWSER_FRAME_MAX_BASE64 ||
				event.metadata.deviceWidth > 4096 ||
				event.metadata.deviceHeight > 4096 ||
				event.metadata.deviceWidth * event.metadata.deviceHeight > 4_000_000
			) {
				this.#fail(o, new Error("Browser frame exceeds the observation budget"));
				return;
			}
			o.candidate = { data: event.data, timestamp: Date.now(), documentEpoch: o.documentEpoch };
			void this.#bounded(o, () => cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId })).catch(error =>
				this.#fail(o, error),
			);
		});
		await this.#bounded(o, () => cdp.send("Page.enable"));
		await this.#bounded(o, () =>
			cdp.send("Page.startScreencast", {
				format: "jpeg",
				quality: 55,
				maxWidth: 1600,
				maxHeight: 1000,
				everyNthFrame: 1,
			}),
		);
	}
	async #pump(o: Observation): Promise<void> {
		if (!this.#current(o) || Date.now() - o.lastPing > 15_000) {
			this.#close(o);
			return;
		}
		if (!o.cdp || !o.socket || o.pumping) return;
		o.pumping = true;
		try {
			if (o.requestedControl && studioTabControlState(o.tab, o.id) === "human" && !o.resumed) {
				await this.#bounded(o, () => resumeStudioBrowserControl(o.tab));
				o.resumed = true;
			}
			if (o.tick++ % 10 === 0) {
				const { targetInfo } = await this.#bounded(o, () => o.cdp!.send("Target.getTargetInfo"));
				const state: BrowserObservationEvent = {
					kind: "state",
					observationId: o.id,
					tabId: o.tabId,
					title: targetInfo.title.slice(0, 4096),
					url: targetInfo.url.slice(0, 4096),
					frozen: o.tab.frozen,
					busy: o.tab.pending.size > 0,
					control: studioTabControlState(o.tab, o.id),
				};
				const key = JSON.stringify(state);
				if (key !== o.stateKey) {
					o.stateKey = key;
					this.#send(o, state);
				}
			}
			if (o.candidate && o.inFlight === 0) {
				const frame = o.candidate;
				o.candidate = undefined;
				const metrics = await this.#bounded(o, () => o.cdp!.send("Page.getLayoutMetrics"));
				if (frame.documentEpoch !== o.documentEpoch) return;
				o.width = metrics.cssVisualViewport.clientWidth;
				o.height = metrics.cssVisualViewport.clientHeight;
				if (o.width < 1 || o.height < 1 || o.width > 4096 || o.height > 4096 || o.width * o.height > 4_000_000)
					throw new Error("Browser viewport exceeds the observation budget");
				o.inFlight = ++o.sequence;
				o.frameEpoch = frame.documentEpoch;
				this.#send(o, {
					kind: "frame",
					observationId: o.id,
					tabId: o.tabId,
					sequence: o.sequence,
					data: frame.data,
					width: o.width,
					height: o.height,
					timestamp: frame.timestamp,
				});
			}
		} catch (error) {
			this.#fail(o, error);
		} finally {
			o.pumping = false;
		}
	}
	async #input(o: Observation, input: BrowserObservationInput): Promise<void> {
		if (!this.#current(o)) throw new Error("Browser observation expired");
		if (input.kind === "take") {
			acquireStudioTabControl(o.tab, o.id);
			if (!o.requestedControl) o.wasFrozen = o.tab.frozen;
			o.requestedControl = true;
			o.tick = 0;
			return;
		}
		if (input.kind === "release") {
			releaseStudioTabControl(o.tab, o.id);
			if (o.wasFrozen && o.resumed) await settleStudioBrowserControl(o.tab);
			o.requestedControl = false;
			o.resumed = false;
			o.wasFrozen = false;
			o.tick = 0;
			return;
		}
		if (input.kind === "ping" || input.kind === "ack") return;
		if (!o.cdp || !o.resumed || studioTabControlState(o.tab, o.id) !== "human")
			throw new Error("Wait for explicit human control before interacting");
		if (
			"sequence" in input &&
			(input.sequence !== o.acknowledged || input.sequence !== o.sequence || o.documentEpoch !== o.frameEpoch)
		)
			throw new Error("The displayed frame changed. Wait for a fresh frame and retry");
		o.tab.lastActivityAt = Date.now();
		if (input.kind === "navigate") {
			const result = await this.#bounded(o, () => o.cdp!.send("Page.navigate", { url: input.url }));
			if (result.errorText) throw new Error(result.errorText);
			return;
		}
		if (input.kind === "text") {
			await this.#bounded(o, () => o.cdp!.send("Input.insertText", { text: input.text }));
			return;
		}
		if (input.kind === "key") {
			const params = { key: input.key, code: input.code, modifiers: input.modifiers };
			await this.#bounded(o, () => o.cdp!.send("Input.dispatchKeyEvent", { type: "keyDown", ...params }));
			await this.#bounded(o, () => o.cdp!.send("Input.dispatchKeyEvent", { type: "keyUp", ...params }));
			return;
		}
		const x = input.x * o.width;
		const y = input.y * o.height;
		const metrics = await this.#bounded(o, () => o.cdp!.send("Page.getLayoutMetrics"));
		if (
			metrics.cssVisualViewport.clientWidth !== o.width ||
			metrics.cssVisualViewport.clientHeight !== o.height ||
			o.documentEpoch !== o.frameEpoch
		)
			throw new Error("Browser viewport changed. Wait for a fresh frame");
		if (input.kind === "wheel")
			await this.#bounded(o, () =>
				o.cdp!.send("Input.dispatchMouseEvent", {
					type: "mouseWheel",
					x,
					y,
					deltaX: input.deltaX,
					deltaY: input.deltaY,
				}),
			);
		else {
			await this.#bounded(o, () =>
				o.cdp!.send("Input.dispatchMouseEvent", {
					type: "mousePressed",
					x,
					y,
					button: input.button,
					clickCount: 1,
				}),
			);
			await this.#bounded(o, () =>
				o.cdp!.send("Input.dispatchMouseEvent", {
					type: "mouseReleased",
					x,
					y,
					button: input.button,
					clickCount: 1,
				}),
			);
		}
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
		clearInterval(o.timer);
		releaseStudioTabControl(o.tab, o.id);
		if (o.wasFrozen && o.resumed && studioTabIdentity(o.tab) === o.tabId)
			void settleStudioBrowserControl(o.tab).catch(() => {});
		o.candidate = undefined;
		o.cdp?.removeAllListeners();
		void o.cdp?.detach().catch(() => {});
		for (const socket of o.peers) socket.destroy();
		o.peers.clear();
		o.server.close();
		void fs.unlink(o.descriptor).catch(() => {});
		this.#observations.delete(o.id);
	}
	dispose(): void {
		this.#disposed = true;
		for (const observation of this.#observations.values()) this.#close(observation);
	}
}
