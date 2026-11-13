import { isRecord } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { CDPSession } from "puppeteer-core";
import type { ToolSession } from "../../tools/index";
import type { BrowserCaptureResult, BrowserConsoleEntry } from "../../tools/browser/console-capture";
import type { BrowserDownload } from "../../tools/browser/downloads";
import type { NetworkRequestRecord } from "../../tools/browser/network";
import { createStudioBrowserObservation, runInTab, type TabSession } from "../../tools/browser/tab-supervisor";
import type { TernInputStep, TernModifier } from "../../tools/browser/tern/keys";
import type { TernSocketClient } from "../../tools/browser/tern/wire";
import { WebKitCaptureBudgetError } from "../../tools/browser/webkit/host";
import type {
	BrowserObservationInput,
	BrowserPageInspection,
	BrowserInspectionView,
} from "../browser-observation-protocol";

export interface ObservedBrowserState {
	title: string;
	url: string;
	cssWidth: number;
	cssHeight: number;
	documentEpoch: number;
	canGoBack?: boolean;
	canGoForward?: boolean;
}
export interface ObservedBrowserFrame extends ObservedBrowserState {
	data: string;
	width: number;
	height: number;
	timestamp: number;
}
const RAW_BYTES = 2 * 1024 * 1024;
const REQUEST_MS = 3_000;
const short = (value: string) => value.slice(0, 4096);

/** A thin view adapter over the CLI's existing target/engine. The observation service owns the only pump and lease. */
export class NativeBrowserObservationAdapter {
	readonly #tab: TabSession;
	readonly #session: ToolSession;
	readonly #current: () => boolean;
	readonly #canControl: () => boolean;
	readonly #holder: string;
	#viewerShown = false;
	readonly #abort = new AbortController();
	// One reusable raw buffer per observation, never a screenshot-save path.
	#raw: Buffer | undefined = Buffer.allocUnsafe(RAW_BYTES);
	#cdp?: CDPSession;
	#cursor?: number;
	#documentEpoch = 0;
	#lastUrl?: string;
	#captureScale?: number;

	constructor(
		tab: TabSession,
		session: ToolSession,
		current: () => boolean,
		holder = "",
		canControl: () => boolean = () => false,
	) {
		this.#tab = tab;
		this.#session = session;
		this.#current = current;
		this.#holder = holder;
		this.#canControl = canControl;
	}
	async start(): Promise<void> {
		if (this.#tab.backend === "worker") {
			const cdp = await createStudioBrowserObservation(this.#tab);
			if (!this.#current()) {
				await cdp.detach();
				return;
			}
			this.#cdp = cdp;
			cdp.on("Page.frameNavigated", event => {
				if (!event.frame.parentId) this.#documentEpoch++;
			});
			await cdp.send("Page.enable");
		} else if (this.#tab.backend !== "webkit" && this.#tab.backend !== "tern") {
			throw new ToolError("This native backend exposes no raw same-page capture channel.");
		}
	}
	#check(): void {
		if (!this.#current() || this.#abort.signal.aborted) throw new ToolError("Browser observation target changed.");
	}
	#native(): { client: TernSocketClient; block: number } {
		const tab = this.#tab;
		if (tab.backend === "webkit") return { client: tab.browser.webkit.client, block: tab.ternTab.block };
		if (tab.backend === "tern") return { client: tab.browser.tern, block: tab.ternTab.block };
		throw new ToolError("This target is not a native WebKit view.");
	}
	async #op(op: string, fields: Record<string, unknown> = {}): Promise<unknown> {
		this.#check();
		const { client, block } = this.#native();
		const value = await client.request(
			{ op, block, ...fields },
			{ signal: this.#abort.signal, timeoutMs: REQUEST_MS },
		);
		this.#check();
		return value;
	}
	async state(): Promise<ObservedBrowserState> {
		this.#check();
		if (this.#cdp) {
			const [target, metrics, history] = await Promise.all([
				this.#cdp.send("Target.getTargetInfo"),
				this.#cdp.send("Page.getLayoutMetrics"),
				this.#cdp.send("Page.getNavigationHistory").catch(() => undefined),
			]);
			this.#check();
			return {
				title: short(target.targetInfo.title),
				url: short(target.targetInfo.url),
				cssWidth: metrics.cssVisualViewport.clientWidth,
				cssHeight: metrics.cssVisualViewport.clientHeight,
				documentEpoch: this.#documentEpoch,
				...(history
					? {
							canGoBack: history.currentIndex > 0,
							canGoForward: history.currentIndex < history.entries.length - 1,
						}
					: {}),
			};
		}
		// Native events are non-destructive reads of the engine's own log. Retain
		// only its cursor and navigation epoch, not another event queue.
		const events = await this.#op("events", { after: this.#cursor ?? 0 });
		if (isRecord(events) && Array.isArray(events.events)) {
			let cursor = this.#cursor ?? 0;
			for (const event of events.events) {
				if (!isRecord(event) || typeof event.seq !== "number" || event.seq <= cursor) continue;
				if (this.#cursor !== undefined && (event.type === "committed" || event.type === "url"))
					this.#documentEpoch++;
				cursor = event.seq;
			}
			if (this.#cursor !== undefined && typeof events.dropped === "number" && events.dropped > 0)
				this.#documentEpoch++;
			// Tern/WebKit's native protocol need not report `next`; the actual
			// event sequence fences even a reload that kept exactly the same URL.
			this.#cursor = cursor;
		}
		const tab = this.#tab;
		const native =
			tab.backend === "webkit"
				? await tab.browser.webkit.viewState(tab.ternTab.block, {
						signal: this.#abort.signal,
						timeoutMs: REQUEST_MS,
					})
				: await this.#op("state");
		if (!isRecord(native)) throw new ToolError("The native view did not report its state.");
		const url = typeof native.url === "string" ? native.url : tab.info.url;
		if (this.#lastUrl !== undefined && this.#lastUrl !== url) this.#documentEpoch++;
		this.#lastUrl = url;
		const viewport = tab.backend === "tern" || tab.backend === "webkit" ? tab.ternTab.viewport() : tab.info.viewport;
		return {
			title: short(typeof native.title === "string" ? native.title : (tab.info.title ?? "")),
			url: short(url),
			cssWidth: typeof native.width === "number" ? native.width : viewport.width,
			cssHeight: typeof native.height === "number" ? native.height : viewport.height,
			documentEpoch: this.#documentEpoch,
			...(typeof native.canGoBack === "boolean" ? { canGoBack: native.canGoBack } : {}),
			...(typeof native.canGoForward === "boolean" ? { canGoForward: native.canGoForward } : {}),
		};
	}
	async frame(visible: () => boolean = () => true): Promise<ObservedBrowserFrame | undefined> {
		if (!visible()) return;
		const before = await this.state();
		if (!visible()) return;
		const { cssWidth, cssHeight } = before;
		if (!(cssWidth > 0 && cssHeight > 0) || cssWidth > 4096 || cssHeight > 4096 || cssWidth * cssHeight > 4_000_000)
			throw new ToolError("Browser viewport exceeds the observation budget.");
		let scale = Math.min(this.#captureScale ?? 1, 1600 / cssWidth, 1000 / cssHeight);
		for (let attempt = 0; attempt < 4; attempt++) {
			if (!visible()) return;
			let data: string;
			try {
				if (this.#cdp) {
					const metrics = await this.#cdp.send("Page.getLayoutMetrics");
					this.#check();
					if (!visible()) return;
					const image = await this.#cdp.send("Page.captureScreenshot", {
						format: "jpeg",
						quality: 55,
						captureBeyondViewport: false,
						clip: {
							x: metrics.cssVisualViewport.pageX,
							y: metrics.cssVisualViewport.pageY,
							width: cssWidth,
							height: cssHeight,
							scale,
						},
					});
					data = image.data;
				} else if (this.#tab.backend === "webkit") {
					data = await this.#tab.browser.webkit.captureView(
						this.#tab.ternTab.block,
						{ width: cssWidth, height: cssHeight, scale },
						{ signal: this.#abort.signal, timeoutMs: REQUEST_MS },
					);
				} else {
					const image = await this.#op("capture", { format: "jpeg", quality: 55, scale });
					if (!isRecord(image) || typeof image.data !== "string")
						throw new ToolError("The native view returned no image.");
					data = image.data;
				}
			} catch (cause) {
				if (!(cause instanceof WebKitCaptureBudgetError) || attempt === 3) throw cause;
				scale /= 2;
				continue;
			}
			this.#check();
			if (!visible()) return;
			if (!this.#raw) return;
			if (data.length > 2_796_204 || Buffer.byteLength(data, "base64") > RAW_BYTES) {
				scale /= 2;
				continue;
			}
			const bytes = this.#raw.write(data, 0, RAW_BYTES, "base64");
			let dimensions: { width: number; height: number };
			try {
				dimensions = await new Bun.Image(this.#raw.subarray(0, bytes), { maxPixels: 4_000_000 }).metadata();
			} catch (cause) {
				if (attempt === 3) throw cause;
				scale /= 2;
				continue;
			}
			if (dimensions.width > 4096 || dimensions.height > 4096 || dimensions.width * dimensions.height > 4_000_000) {
				scale /= 2;
				continue;
			}
			const after = await this.state();
			if (
				!visible() ||
				before.documentEpoch !== after.documentEpoch ||
				cssWidth !== after.cssWidth ||
				cssHeight !== after.cssHeight
			)
				return;
			this.#captureScale = scale;
			return { ...after, data, width: dimensions.width, height: dimensions.height, timestamp: Date.now() };
		}
		throw new ToolError("The same-view capture could not fit the observation byte/pixel budget.");
	}
	async input(input: BrowserObservationInput, frame?: ObservedBrowserState): Promise<void> {
		this.#check();
		let currentPage: ObservedBrowserState | undefined;
		if (!this.#canControl()) throw new ToolError("The current native control lease expired.");
		if (
			input.kind !== "ping" &&
			input.kind !== "ack" &&
			input.kind !== "take" &&
			input.kind !== "release" &&
			input.kind !== "visibility" &&
			input.kind !== "inspect"
		) {
			currentPage = await this.state();
			if (!this.#canControl()) throw new ToolError("The current native control lease expired.");
			if (input.documentEpoch !== currentPage.documentEpoch)
				throw new ToolError("The native document changed. Wait for a fresh view before acting.");
		}
		if (input.kind === "viewer") {
			if (this.#tab.backend !== "webkit" || !this.#tab.browser.webkit.canShow)
				throw new ToolError("This engine/platform provides no same-view native viewer.");
			if (input.visible) {
				this.#tab.browser.webkit.guardViewerInput(
					this.#tab.ternTab.block,
					() => this.#current() && this.#canControl(),
				);
				this.#viewerShown = true;
				try {
					await this.#tab.browser.webkit.show(
						this.#tab.ternTab.block,
						this.#tab.info.title || this.#tab.name,
						this.#holder,
					);
					this.#check();
					if (!this.#canControl()) throw new ToolError("The native viewer lease expired while showing it.");
				} catch (cause) {
					await this.hideViewer();
					throw cause;
				}
			} else await this.hideViewer();
			return;
		}
		if (input.kind === "navigate" || ["back", "forward", "reload", "stop"].includes(input.kind)) {
			if (this.#cdp) {
				if (input.kind === "navigate") {
					const result = await this.#cdp.send("Page.navigate", { url: input.url });
					if (result.errorText) throw new ToolError(result.errorText);
				} else if (input.kind === "reload") await this.#cdp.send("Page.reload");
				else if (input.kind === "stop") await this.#cdp.send("Page.stopLoading");
				else {
					const history = await this.#cdp.send("Page.getNavigationHistory");
					this.#check();
					const entry = history.entries[history.currentIndex + (input.kind === "back" ? -1 : 1)];
					if (entry) await this.#cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
				}
			} else
				await this.#op(
					input.kind === "navigate" ? "goto" : input.kind,
					input.kind === "navigate" ? { url: input.url } : {},
				);
			return;
		}
		if (input.kind !== "click" && input.kind !== "wheel" && input.kind !== "key" && input.kind !== "text") return;
		const fresh = currentPage ?? (await this.state());
		this.#check();
		if (!this.#canControl()) throw new ToolError("The current native control lease expired.");
		if (
			!frame ||
			frame.documentEpoch !== fresh.documentEpoch ||
			frame.cssWidth !== fresh.cssWidth ||
			frame.cssHeight !== fresh.cssHeight
		)
			throw new ToolError("The native page or its geometry changed. Wait for a fresh frame.");
		if (this.#cdp) {
			if (input.kind === "text") await this.#cdp.send("Input.insertText", { text: input.text });
			else if (input.kind === "key") {
				const key = { key: input.key, code: input.code, modifiers: input.modifiers };
				await this.#cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
				this.#check();
				await this.#cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
			} else {
				const point = {
					x: Math.min(fresh.cssWidth - 1, input.x * fresh.cssWidth),
					y: Math.min(fresh.cssHeight - 1, input.y * fresh.cssHeight),
				};
				if (input.kind === "wheel")
					await this.#cdp.send("Input.dispatchMouseEvent", {
						type: "mouseWheel",
						...point,
						deltaX: input.deltaX,
						deltaY: input.deltaY,
					});
				else {
					await this.#cdp.send("Input.dispatchMouseEvent", {
						type: "mousePressed",
						...point,
						button: input.button,
						clickCount: 1,
					});
					this.#check();
					await this.#cdp.send("Input.dispatchMouseEvent", {
						type: "mouseReleased",
						...point,
						button: input.button,
						clickCount: 1,
					});
				}
			}
			return;
		}
		const mods: TernModifier[] =
			input.kind === "key"
				? [
						...(input.modifiers & 1 ? ["alt" as const] : []),
						...(input.modifiers & 2 ? ["ctrl" as const] : []),
						...(input.modifiers & 4 ? ["meta" as const] : []),
						...(input.modifiers & 8 ? ["shift" as const] : []),
					]
				: [];
		let events: TernInputStep[];
		if (input.kind === "text") events = [{ type: "text", text: input.text }];
		else if (input.kind === "key")
			events = [
				{ type: "key", action: "down", key: input.key, code: input.code, mods },
				{ type: "key", action: "up", key: input.key, code: input.code, mods },
			];
		else {
			const point = {
				x: Math.min(fresh.cssWidth - 1, input.x * fresh.cssWidth),
				y: Math.min(fresh.cssHeight - 1, input.y * fresh.cssHeight),
			};
			events =
				input.kind === "wheel"
					? [{ type: "wheel", ...point, dx: input.deltaX, dy: input.deltaY }]
					: [
							{ type: "mouse", action: "down", ...point, button: input.button, clicks: 1 },
							{ type: "mouse", action: "up", ...point, button: input.button, clicks: 1 },
						];
		}
		if (this.#tab.backend === "webkit")
			await this.#tab.browser.webkit.inputView(this.#tab.ternTab.block, events, {
				signal: this.#abort.signal,
				timeoutMs: REQUEST_MS,
			});
		else await this.#op("input", { events });
	}
	async inspect(view: BrowserInspectionView): Promise<BrowserPageInspection> {
		this.#check();
		let value: unknown;
		if (this.#tab.backend === "worker")
			value = (
				await runInTab(this.#tab.name, {
					code: "",
					inspection: view,
					timeoutMs: REQUEST_MS,
					signal: this.#abort.signal,
					session: this.#session,
				})
			).returnValue;
		else if (this.#tab.backend === "webkit" || this.#tab.backend === "tern") {
			const tab = this.#tab.ternTab;
			value =
				view === "console"
					? await tab.console({ limit: 200 })
					: view === "network"
						? await tab.requests({ limit: 200 })
						: await tab.readDownloads();
		} else throw new ToolError("This native backend exposes no page inspection channel.");
		if (view === "console") {
			const entries = (value as BrowserCaptureResult<BrowserConsoleEntry>).entries;
			return {
				view,
				rows: entries.slice(-200).map(row => ({
					level: row.level,
					text: short(row.text),
					...(row.location ? { location: short(row.location) } : {}),
					timestamp: row.ts,
				})),
			};
		}
		if (view === "network")
			return {
				view,
				rows: (value as NetworkRequestRecord[]).slice(-200).map(row => ({
					id: row.id,
					method: row.method,
					url: short(row.url),
					...(row.status === undefined ? {} : { status: row.status }),
					resourceType: row.resourceType,
					...(row.failureText ? { failure: short(row.failureText) } : {}),
				})),
				...(this.#tab.backend === "webkit" || this.#tab.backend === "tern"
					? {
							reason:
								"WebKit exposes native request metadata; response bodies and full CDP tracing are unavailable.",
						}
					: {}),
			};
		return {
			view: "downloads",
			rows: (value as BrowserDownload[]).slice(-200).map(row => ({
				name: short(row.suggestedFilename),
				url: short(row.url),
				path: short(row.path),
				bytes: row.bytes,
				state: "completed",
			})),
		};
	}
	get viewerVisible(): boolean {
		return (
			this.#tab.backend === "webkit" &&
			this.#viewerShown &&
			this.#tab.browser.webkit.isShown(this.#tab.ternTab.block)
		);
	}
	async hideViewer(): Promise<void> {
		if (this.#tab.backend !== "webkit" || !this.#viewerShown) return;
		this.#viewerShown = false;
		await this.#tab.browser.webkit.hide(this.#tab.ternTab.block, this.#holder);
	}
	dispose(): void {
		this.#abort.abort();
		this.#raw = undefined;
		this.#cdp?.removeAllListeners();
		void this.#cdp?.detach().catch(() => undefined);
		// Detach only the observation and same-view viewer, never the CLI block.
		void this.hideViewer().catch(() => undefined);
	}
}
