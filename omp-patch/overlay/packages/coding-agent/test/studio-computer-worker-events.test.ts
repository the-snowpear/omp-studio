import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ComputerWorkerCore, type NativeDesktopSession } from "../src/tools/computer/worker";
import type {
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
	ComputerWorkerTransport,
} from "../src/tools/computer/protocol";
import { callSessionTool } from "../src/eval/js/tool-bridge";
import type { ToolSession } from "../src/tools";
import { Settings } from "../src/config/settings";
import { DesktopSession } from "@oh-my-pi/pi-natives";
import type { EvalPreludeContext, EvalPreludeDefinition } from "../src/eval/preludes";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3WQAAAAASUVORK5CYII=",
	"base64",
);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});
test("rebuilt observation-only binding rejects control before starting a native worker", async () => {
	const observer = new DesktopSession({ observationOnly: true });
	try {
		expect(observer.observationOnly).toBe(true);
		expect(() => observer.acquireControl()).toThrow("observation-only");
	} finally {
		await observer.close();
	}
});

function workerHarness() {
	const messages: ComputerWorkerOutbound[] = [];
	const settled = Promise.withResolvers<void>();
	let receive: (message: ComputerWorkerInbound) => void = () => {};
	const transport: ComputerWorkerTransport = {
		send: message => {
			messages.push(message);
			if (message.type === "result") settled.resolve();
		},
		onMessage: handler => {
			receive = handler;
			return () => {};
		},
		close() {},
	};
	const native = {
		capabilities: {
			backend: "fake",
			capture: true,
			input: true,
			ax: true,
			globalEscape: true,
			screenLocked: false,
			displayAsleep: false,
		},
		screenState: { screenLocked: false, displayAsleep: false },
		escapeStops: 0,
		controlState: () => ({ active: false }),
		cancel() {},
		retire() {},
		setRunDeadline() {},
		holdDisplayUntilReleased() {},
		releaseDisplayAwake() {},
		listWindows: async () => [
			{ id: "7", app: "test", title: "Editor", width: 1, height: 1, x: 0, y: 0, focused: true },
		],
		capture: async (target: string) => ({
			data: png,
			width: 1,
			height: 1,
			coordinateWidth: 1,
			coordinateHeight: 1,
			sourceWidth: 1,
			sourceHeight: 1,
			screenLocked: false,
			displays: [],
			target,
			backend: "fake",
		}),
		close: async () => {},
	} as unknown as NativeDesktopSession;
	new ComputerWorkerCore(transport, () => native);
	cleanup.push(async () => {
		receive({ type: "close" });
		for (const event of messages)
			if (event.type === "activity" && event.event.kind === "frame")
				await fs.unlink(event.event.screenshot.path).catch(() => {});
	});
	return { receive, messages, settled };
}

test("worker emits native method and generated screenshot evidence even when the script later fails", async () => {
	const h = workerHarness();
	h.receive({
		type: "run",
		id: "worker-run",
		code: "const win = await desktop.window('7'); await win.screenshot(); throw new Error('private-input-secret')",
		timeoutMs: 5_000,
		escape: { key: "test", acknowledged: 0 },
		session: {
			cwd: process.cwd(),
			sessionId: "s",
			display: "all",
			captureMaxWidth: 1280,
			captureMaxHeight: 896,
			readOnly: true,
			backgroundFallback: "refuse",
			activity: { runId: "real-run", sessionId: "s", toolCallId: "outer-eval" },
		},
	});
	await h.settled.promise;
	const events = h.messages.filter(message => message.type === "activity").map(message => message.event);
	expect(
		events.some(event => event.kind === "action" && event.method === "capture" && event.phase === "completed"),
	).toBe(true);
	const frame = events.find(event => event.kind === "frame");
	expect(frame?.identity).toMatchObject({ runId: "real-run", toolCallId: "outer-eval" });
	expect(JSON.stringify(events)).not.toContain("private-input-secret");
	expect(h.messages.at(-1)).toMatchObject({ type: "result", ok: false });
	if (frame?.kind !== "frame") throw new Error("Frame evidence missing");
	expect(await Bun.file(frame.screenshot.path).bytes()).toEqual(new Uint8Array(png));
	expect(frame.screenshot).not.toHaveProperty("delivered");
});

test("prelude bridge carries the outer Eval identity separately from its invocation id", async () => {
	let seen: EvalPreludeContext | undefined;
	const prelude: EvalPreludeDefinition = {
		name: "computer",
		documentation: "test",
		javascript: "",
		python: "",
		exports: [],
		approval: "read",
		invoke: async (_args, context) => {
			seen = context;
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const session = {
		cwd: process.cwd(),
		settings: Settings.isolated({ "tools.approvalMode": "yolo" }),
		getEvalPreludes: () => [prelude],
	} as unknown as ToolSession;
	await callSessionTool(
		"__prelude__",
		{ name: "computer", parameters: { action: "capabilities" } },
		{ session, outerToolCallId: "actual-eval-call" },
	);
	expect(seen?.outerToolCallId).toBe("actual-eval-call");
	expect(seen?.toolCallId).not.toBe("actual-eval-call");
});
