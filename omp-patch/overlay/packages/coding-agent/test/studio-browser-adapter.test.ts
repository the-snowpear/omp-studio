import { expect, spyOn, test } from "bun:test";
import type { ToolSession } from "../src/tools";
import type { TabSession } from "../src/tools/browser/tab-supervisor";
import type { TernInputStep } from "../src/tools/browser/tern/keys";
import type { TernSocketClient } from "../src/tools/browser/tern/wire";
import { WebKitHost, type WebKitViewState } from "../src/tools/browser/webkit/host";
import { WebKitViewer, type WebKitViewerEvents } from "../src/tools/browser/webkit/viewer";
import { NativeBrowserObservationAdapter } from "../src/studio/services/browser-observation-adapter";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
function nativeView(capture: () => Promise<string> = async () => PNG) {
	const requests: Record<string, unknown>[] = [],
		inputs: TernInputStep[][] = [];
	const events = [{ seq: 1, type: "committed", url: "https://same-view.test/" }];
	const state: WebKitViewState = {
		url: "https://same-view.test/",
		title: "Same native view",
		width: 800,
		height: 800,
		loading: false,
	};
	const client = {
		request: async (request: Record<string, unknown>) => {
			requests.push(request);
			if (request.op === "events") return { events: events.filter(event => event.seq > Number(request.after ?? 0)) };
			if (request.op === "state") return state;
			throw new Error(`Unexpected native operation ${String(request.op)}`);
		},
	} as unknown as TernSocketClient;
	const host = {
		client,
		canShow: false,
		isShown: () => false,
		viewState: async () => {
			requests.push({ op: "state", block: 9 });
			return state;
		},
		captureView: async () => {
			requests.push({ op: "capture", block: 9 });
			return capture();
		},
		inputView: async (_block: number, steps: TernInputStep[]) => {
			inputs.push(steps);
		},
		hide: async () => {},
	} as unknown as WebKitHost;
	const tab = {
		backend: "webkit",
		name: "native-view",
		state: "alive",
		targetId: "9",
		browser: { webkit: host },
		ternTab: { block: 9, viewport: () => state },
		info: { url: state.url, title: state.title, viewport: state },
	} as unknown as TabSession;
	let current = true,
		leased = true;
	const adapter = new NativeBrowserObservationAdapter(
		tab,
		{} as ToolSession,
		() => current,
		"window-a",
		() => leased,
	);
	return {
		adapter,
		requests,
		inputs,
		events,
		tab,
		replace: () => {
			current = false;
		},
		release: () => {
			leased = false;
		},
	};
}

test("native WebKit maps capture fractions into its unchanged CSS view and rejects a same-URL new document", async () => {
	const view = nativeView();
	try {
		await view.adapter.start();
		const frame = await view.adapter.frame();
		expect(frame).toMatchObject({ width: 1, height: 1, cssWidth: 800, cssHeight: 800, documentEpoch: 0 });
		await view.adapter.input(
			{
				kind: "click",
				sequence: 1,
				generation: "generation",
				documentEpoch: 0,
				leaseId: "lease",
				x: 0.25,
				y: 0.5,
				button: "left",
			},
			frame,
		);
		expect(view.inputs[0]).toEqual([
			{ type: "mouse", action: "down", x: 200, y: 400, button: "left", clicks: 1 },
			{ type: "mouse", action: "up", x: 200, y: 400, button: "left", clicks: 1 },
		]);
		view.events.push({ seq: 2, type: "committed", url: "https://same-view.test/" });
		await expect(
			view.adapter.input(
				{ kind: "text", sequence: 1, documentEpoch: 0, text: "must not reach new document" },
				frame,
			),
		).rejects.toThrow("document changed");
		expect(view.inputs).toHaveLength(1);
		view.replace();
		await expect(view.adapter.frame()).rejects.toThrow("target changed");
		expect(view.tab.targetId).toBe("9");
		expect(view.requests.some(request => request.op === "open" || request.op === "goto")).toBe(false);
	} finally {
		view.adapter.dispose();
	}
});

test("a hidden WebKit view performs no polling/encoding and drops an already in-flight capture", async () => {
	const started = Promise.withResolvers<void>(),
		captured = Promise.withResolvers<string>();
	const view = nativeView(async () => {
		started.resolve();
		return captured.promise;
	});
	let visible = false;
	try {
		await view.adapter.start();
		expect(await view.adapter.frame(() => visible)).toBeUndefined();
		expect(view.requests).toEqual([]);
		visible = true;
		const pending = view.adapter.frame(() => visible);
		await started.promise;
		visible = false;
		captured.resolve(PNG);
		expect(await pending).toBeUndefined();
		const count = view.requests.length;
		expect(await view.adapter.frame(() => visible)).toBeUndefined();
		expect(view.requests).toHaveLength(count);
		expect(view.requests.filter(request => request.op === "capture")).toHaveLength(1);
	} finally {
		view.adapter.dispose();
	}
});

test("a retired same-view viewer cannot hide the new holder's window or forward input after its lease", async () => {
	const host = new WebKitHost("not-launched-host", "not-launched-viewer"),
		events: WebKitViewerEvents[] = [];
	const supports = spyOn(host.client, "supports").mockReturnValue(true);
	const request = spyOn(host.client, "request").mockImplementation(async () => ({}));
	const launch = spyOn(WebKitViewer, "launch").mockImplementation(async (_path, handlers) => {
		events.push(handlers);
		return {
			mach: `viewer-${events.length}`,
			show: () => {},
			hide: () => {},
			close: () => {},
		} as unknown as WebKitViewer;
	});
	let leased = false;
	try {
		await host.show(9, "Same view", "window-a");
		await host.hide(9, "window-a");
		await host.show(9, "Same view", "window-b");
		await host.hide(9, "window-a");
		events[0]!.exited();
		expect(host.isShown(9)).toBe(true);
		host.guardViewerInput(9, () => leased);
		events[1]!.input(9, [{ type: "text", text: "blocked" }]);
		expect(request.mock.calls.filter(([operation]) => operation.op === "input")).toHaveLength(0);
		leased = true;
		events[0]!.input(9, [{ type: "text", text: "old viewer" }]);
		events[1]!.input(9, [{ type: "text", text: "中文" }]);
		await Bun.sleep(0);
		const inputs = request.mock.calls.filter(([operation]) => operation.op === "input");
		expect(inputs).toHaveLength(1);
		expect(inputs[0]?.[0]).toMatchObject({ block: 9, events: [{ type: "text", text: "中文" }] });
	} finally {
		await host.close();
		launch.mockRestore();
		request.mockRestore();
		supports.mockRestore();
	}
});
