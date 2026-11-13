import { describe, expect, test } from "bun:test";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createDefaultToolUiContext } from "@oh-my-pi/pi-coding-agent/tools/context";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import type { StudioThreadGlobals } from "@oh-my-pi/pi-coding-agent/studio/services/studio-thread-service";
import {
	setStudioThreadInteraction,
	studioThreadService,
} from "@oh-my-pi/pi-coding-agent/studio/services/studio-thread-service";
import type { WorkerPeer } from "@oh-my-pi/pi-coding-agent/thread/services";
import type { MainThreadLink } from "@oh-my-pi/pi-coding-agent/thread/protocol";
import type { ThreadId } from "@oh-my-pi/pi-coding-agent/thread/identity";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	StudioInteractionRequiredEvent,
	StudioInteractionResolvedEvent,
} from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import { StudioRuntimeCommandArbiter } from "@oh-my-pi/pi-coding-agent/studio/command-arbiter";
import {
	createStudioRemoteUiFactory,
	REMOTE_CUSTOM_INPUT_ID,
	StudioRemoteExtensionUiContext,
} from "@oh-my-pi/pi-coding-agent/studio/remote-extension-ui";
import {
	StudioInteractionError,
	StudioInteractionGateway,
	StudioRemoteInteractionPort,
} from "@oh-my-pi/pi-coding-agent/studio/services/interaction-port";

function fixture() {
	const arbiter = new StudioRuntimeCommandArbiter(
		() => ({ runtimeEpoch: 1, stateVersion: 0, isStreaming: false, isCompacting: false }),
		[],
	);
	const opened: StudioInteractionRequiredEvent[] = [];
	const resolved: StudioInteractionResolvedEvent[] = [];
	const port = new StudioRemoteInteractionPort(
		arbiter,
		(_pending, event) => opened.push(event),
		event => resolved.push(event),
	);
	const gateway = new StudioInteractionGateway();
	gateway.bind(port);
	return { port, gateway, opened, resolved };
}

function respond(port: StudioRemoteInteractionPort, value: unknown, decision: "submit" | "cancel" = "submit") {
	const request = port.pending()?.request;
	if (!request) throw new Error("no pending interaction");
	port.respond({
		kind: "interaction.respond",
		interactionId: request.interactionId,
		commandId: request.commandId,
		decision,
		...(value === undefined ? {} : { value }),
	});
}

describe("WP-041 Studio Remote Extension UI", () => {
	test("Ask custom images and note images keep their question ownership", async () => {
		const { port, gateway } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "ask-images");
		const questions = [
			{ id: "a", question: "A?", options: [{ label: "One" }] },
			{ id: "b", question: "B?", options: [{ label: "Two" }] },
		];
		const answer = ui.askDialog(questions, { acceptImages: true });
		expect(port.pending()?.request).toMatchObject({ kind: "ask", acceptImages: true });
		const image = { type: "image", mimeType: "image/png", data: "AA==" };
		respond(port, {
			results: [
				{ id: "a", selectedOptions: [], customInput: "[Image #1]", customInputImages: [image] },
				{ id: "b", selectedOptions: ["Two"], note: "see [Image #1]", noteImages: [image] },
			],
		});
		const result = await answer;
		if (result?.kind !== "submit") throw Error("expected submit");
		expect(result.results[0]?.customInputImages).toHaveLength(1);
		expect(result.results[0]?.noteImages).toBeUndefined();
		expect(result.results[1]?.customInputImages).toBeUndefined();
		expect(result.results[1]?.noteImages).toHaveLength(1);
		expect(result.results[1]?.note).toBe("see [Image #1]");
		const denied = ui.askDialog(questions, { acceptImages: false });
		respond(port, {
			results: [
				{ id: "a", selectedOptions: [], customInputImages: [image] },
				{ id: "b", selectedOptions: [] },
			],
		});
		await expect(denied).rejects.toThrow("does not accept images");
	});
	test("select maps labels to remote option ids and back; Other keeps the custom-input id", async () => {
		const { port, gateway, opened } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "studio-tool:call-1");
		const promise = ui.select("Which backend?", [
			{ label: "SQLite", description: "embedded" },
			"PostgreSQL",
			"Other (type your own)",
		]);
		expect(opened).toHaveLength(1);
		const request = opened[0]!.request;
		expect(request).toMatchObject({
			kind: "select",
			commandId: "studio-tool:call-1",
			title: "Which backend?",
			options: [
				{ id: "option:0", label: "SQLite", description: "embedded" },
				{ id: "option:1", label: "PostgreSQL" },
				{ id: REMOTE_CUSTOM_INPUT_ID, label: "Other (type your own)" },
			],
		});
		respond(port, "option:1");
		await expect(promise).resolves.toBe("PostgreSQL");
		const next = ui.select("Next?", ["A"]);
		respond(port, REMOTE_CUSTOM_INPUT_ID);
		await expect(next).resolves.toBe("Other (type your own)");
	});

	test("select rejects unknown or multi option ids with INVALID_ARGUMENT", async () => {
		const { port, gateway } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "studio-tool:call-2");
		const unknown = ui.select("Pick", ["A"]);
		respond(port, "option:99");
		await expect(unknown).rejects.toThrow(StudioInteractionError);
		await expect(unknown).rejects.toThrow("unknown option id");

		const multi = ui.select("Pick", ["A", "B"]);
		respond(port, ["option:0", "option:1"]);
		await expect(multi).rejects.toThrow("multiple values");
	});

	test("input and editor pass through title/placeholder/content/language/promptStyle", async () => {
		const { port, gateway, opened } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "studio-tool:call-3");
		const input = ui.input("Your name?", "Jane");
		expect(opened[0]!.request).toMatchObject({ kind: "input", placeholder: "Jane" });
		respond(port, "Ada");
		await expect(input).resolves.toBe("Ada");

		const editor = ui.editor("Edit the plan", "draft", undefined, { promptStyle: true });
		expect(opened[1]!.request).toMatchObject({
			kind: "editor",
			content: "draft",
			promptStyle: true,
		});
		respond(port, "revised");
		await expect(editor).resolves.toBe("revised");
	});

	test("abort cancels the Remote interaction and surfaces AbortError with no leftover card", async () => {
		const { port, gateway, resolved } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "studio-tool:call-4");
		const controller = new AbortController();
		const promise = ui.select("Wait", ["A"], { signal: controller.signal });
		expect(port.pending()).toBeDefined();
		controller.abort();
		await expect(promise).rejects.toThrow("Aborted");
		expect(port.pending()).toBeUndefined();
		expect(resolved[0]).toMatchObject({ outcome: "aborted", commandId: "studio-tool:call-4" });
	});

	test("a TimeoutError abort resolves the Remote interaction as expired", async () => {
		const { port, gateway, resolved } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "studio-tool:call-timeout");
		const controller = new AbortController();
		const promise = ui.editor("Wait", "", { signal: controller.signal });
		expect(port.pending()).toBeDefined();
		controller.abort(new DOMException("Timed out", "TimeoutError"));
		await expect(promise).rejects.toThrow("Aborted");
		expect(port.pending()).toBeUndefined();
		expect(resolved[0]).toMatchObject({
			outcome: "expired",
			commandId: "studio-tool:call-timeout",
		});
	});

	test("non-blocking UI capabilities are safe no-ops; custom is explicitly unsupported", async () => {
		const { gateway } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "studio-tool:call-5");
		expect(() => ui.notify("hello")).not.toThrow();
		expect(() => ui.setStatus("k", "v")).not.toThrow();
		expect(() => ui.setWorkingMessage("busy")).not.toThrow();
		expect(() => ui.setWidget("w", ["line"])).not.toThrow();
		expect(() => ui.setFooter(undefined)).not.toThrow();
		expect(() => ui.setHeader(undefined)).not.toThrow();
		expect(() => ui.setTitle("title")).not.toThrow();
		expect(() => ui.setEditorText("x")).not.toThrow();
		expect(() => ui.pasteToEditor("x")).not.toThrow();
		expect(ui.getEditorText()).toBe("");
		expect(ui.onTerminalInput(() => undefined)()).toBeUndefined();
		expect(() => ui.addAutocompleteProvider((() => undefined) as never)).not.toThrow();
		expect(ui.getToolsExpanded()).toBe(false);
		expect(typeof (ui as ExtensionUIContext).askDialog).toBe("function");
		expect(() => ui.custom()).toThrow("not supported");
	});

	test("approveTool maps to an approval card and resolves strictly boolean", async () => {
		const { port, gateway, opened } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "studio-tool:call-6");
		const promise = ui.approveTool(
			{
				toolName: "bash",
				toolCallId: "call-6",
				title: "Allow bash?",
				reason: "exec tier",
				details: { toolName: "bash", toolCallId: "call-6", reason: "exec tier", summary: "rm -rf x", risk: "high" },
				approvalMode: "always-ask",
			},
			{ signal: undefined },
		);
		expect(opened[0]!.request).toMatchObject({
			kind: "approval",
			commandId: "studio-tool:call-6",
			title: "Allow bash?",
			approvalType: "bash",
			details: { toolName: "bash", toolCallId: "call-6", risk: "high" },
		});
		respond(port, true);
		await expect(promise).resolves.toBe("once");
		// deny: cancel resolves false
		const denied = ui.approveTool({
			toolName: "bash",
			toolCallId: "call-6b",
			title: "Allow bash?",
			details: { toolName: "bash", toolCallId: "call-6b", summary: "x", risk: "high" },
			approvalMode: "write",
		});
		respond(port, undefined, "cancel");
		await expect(denied).resolves.toBe("deny");
	});

	test("factory binds each tool call to its own studio-tool commandId and reuses it across questions", async () => {
		const { port, gateway, opened } = fixture();
		const factory = createStudioRemoteUiFactory(gateway);
		const callA = { batchId: "b", index: 0, total: 1, toolCalls: [{ id: "call-aaa", name: "ask" }] };
		const callB = { batchId: "b", index: 0, total: 1, toolCalls: [{ id: "call-bbb", name: "ask" }] };
		const uiA = factory(callA);
		const uiA2 = factory(callA);
		const uiB = factory(callB);
		const first = uiA.select("Q1", ["A"]);
		expect(opened[0]!.request.commandId).toBe("studio-tool:call-aaa");
		respond(port, "option:0");
		await first;
		// second question of the same tool call reuses the same internal commandId
		const second = uiA2.select("Q2", ["B"]);
		expect(opened[1]!.request.commandId).toBe("studio-tool:call-aaa");
		respond(port, "option:0");
		await second;
		// a different tool call gets its own id
		const other = uiB.input("Q3");
		expect(opened[2]!.request.commandId).toBe("studio-tool:call-bbb");
		respond(port, "x");
		await other;
		expect(port.pending()).toBeUndefined();
	});

	test("askDialog publishes every question in one ask card and maps labels back", async () => {
		const { port, gateway, opened } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "studio-tool:call-ask");
		const askDialog = ui.askDialog;
		const promise = askDialog([
			{
				id: "inertia",
				question: "Need inertia?",
				header: "惯性",
				options: [{ label: "Yes", description: "coast", preview: "v *= 0.92" }, { label: "No" }],
				recommended: 0,
			},
			{
				id: "default",
				question: "Default?",
				header: "默认",
				options: [{ label: "On" }, { label: "Off" }],
			},
		]);
		expect(opened).toHaveLength(1);
		expect(opened[0]!.request).toMatchObject({
			kind: "ask",
			commandId: "studio-tool:call-ask",
			title: "Agent 提问",
			questions: [
				{
					id: "inertia",
					question: "Need inertia?",
					header: "惯性",
					recommended: 0,
					options: [
						{ id: "option:0", label: "Yes", description: "coast", preview: "v *= 0.92" },
						{ id: "option:1", label: "No" },
					],
				},
				{
					id: "default",
					question: "Default?",
					header: "默认",
					options: [
						{ id: "option:0", label: "On" },
						{ id: "option:1", label: "Off" },
					],
				},
			],
		});
		respond(port, {
			results: [
				{ id: "inertia", selectedOptions: ["Yes"] },
				{ id: "default", selectedOptions: ["Off"] },
			],
		});
		await expect(promise).resolves.toEqual({
			kind: "submit",
			results: [
				{
					id: "inertia",
					question: "Need inertia?",
					options: ["Yes", "No"],
					multi: false,
					selectedOptions: ["Yes"],
				},
				{
					id: "default",
					question: "Default?",
					options: ["On", "Off"],
					multi: false,
					selectedOptions: ["Off"],
				},
			],
		});
	});
});

async function pendingForm(port: StudioRemoteInteractionPort) {
	for (let attempt = 0; attempt < 30 && !port.pending(); attempt++) await Promise.resolve();
	const pending = port.pending();
	if (pending?.request.kind !== "form") throw new Error("Native form was not published");
	return pending;
}

const NATIVE_FORM = `<form><input type="hidden" name="kind" value="deploy"><fieldset><legend>Storage</legend><p>Database?</p><label><input type="radio" name="db" value="sqlite" checked>SQLite</label><label><input type="radio" name="db" value="pg">Postgres</label><label>Replicas<input type="number" name="replicas" value="2" min="1" required></label></fieldset></form>`;

describe("Studio native HTML form UI", () => {
	test("uses the native parsed form and only exposes summary metadata until the transient read", async () => {
		const { port, gateway } = fixture();
		const parsedForm = parseHtmlForm(NATIVE_FORM);
		const ui = new StudioRemoteExtensionUiContext(gateway, "native-form");
		const result = ui.formDialog("already parsed by AskTool", { parsedForm });
		const pending = await pendingForm(port);
		expect(pending.request).toMatchObject({ kind: "form", fieldCount: 2, sectionCount: 1 });
		expect(pending.request).not.toHaveProperty("form");
		expect(pending.request).not.toHaveProperty("html");
		const body = port.readForm(pending.request.interactionId, pending.leaseGeneration).form;
		expect(body.fields.map(field => [field.name, field.question])).toEqual([
			["db", "Database?"],
			["replicas", "Replicas"],
		]);
		expect(body.hidden).toEqual([["kind", "deploy"]]);
		expect(body.defaults).toEqual({ kind: "deploy", db: "sqlite", replicas: 2 });
		respond(port, { data: { db: "pg", replicas: 3 }, notes: [{ name: "db", value: "pg", text: " Keep replicas " }] });
		await expect(result).resolves.toEqual({
			data: { kind: "deploy", db: "pg", replicas: 3 },
			notes: [{ name: "db", question: "Database?", option: "Postgres", value: "pg", text: "Keep replicas" }],
		});
		expect(() => port.readForm(pending.request.interactionId, pending.leaseGeneration)).toThrow("stale");
	});

	test("does not add a Runtime clock and accepts the Renderer timeout's current invalid text", async () => {
		const { port, gateway } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "native-timeout");
		let timedOut = 0;
		const result = ui.formDialog(NATIVE_FORM, { timeout: 5, onTimeout: () => timedOut++ });
		const pending = await pendingForm(port);
		await Bun.sleep(10);
		expect(port.pending()?.request.interactionId).toBe(pending.request.interactionId);
		expect(port.pending()?.request).toMatchObject({ timeoutMs: 5 });
		respond(port, { data: { db: "sqlite", replicas: "-" }, timedOut: true });
		await expect(result).resolves.toEqual({ data: { kind: "deploy", db: "sqlite", replicas: "-" }, timedOut: true });
		expect(timedOut).toBe(1);
	});

	test("aborting after publication closes the form and never accepts its late response", async () => {
		const { port, gateway, resolved } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "native-abort");
		const controller = new AbortController();
		const result = ui.formDialog(NATIVE_FORM, { signal: controller.signal });
		const pending = await pendingForm(port);
		controller.abort();
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(port.pending()).toBeUndefined();
		expect(resolved.at(-1)).toMatchObject({ outcome: "aborted", interactionId: pending.request.interactionId });
		expect(() =>
			port.respond({
				kind: "interaction.respond",
				interactionId: pending.request.interactionId,
				commandId: pending.request.commandId,
				decision: "submit",
				value: { data: { db: "pg", replicas: 3 } },
			}),
		).toThrow("stale");
	});

	test("an external abort wins over a fulfilled form response before the caller resumes", async () => {
		const { port, gateway, resolved } = fixture();
		const ui = new StudioRemoteExtensionUiContext(gateway, "native-late-answer");
		const controller = new AbortController();
		const result = ui.formDialog(NATIVE_FORM, { signal: controller.signal });
		await pendingForm(port);
		respond(port, { data: { db: "pg", replicas: 3 } });
		controller.abort();
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.outcome).toBe("submitted");
	});

	test("a rebound gateway rejects old UI contexts rather than opening their form on the new Runtime", async () => {
		const { port, gateway } = fixture();
		const old = new StudioRemoteExtensionUiContext(gateway, "old-runtime-form");
		const result = old.formDialog(NATIVE_FORM);
		await pendingForm(port);
		gateway.unbind(port);
		await expect(result).rejects.toMatchObject({ code: "INTERACTION_STALE" });
		const next = fixture();
		next.gateway.unbind(next.port);
		gateway.bind(next.port);
		await expect(old.formDialog(NATIVE_FORM)).rejects.toMatchObject({ code: "INTERACTION_STALE" });
		expect(next.port.pending()).toBeUndefined();
		const fresh = new StudioRemoteExtensionUiContext(gateway, "fresh-runtime-form").formDialog(NATIVE_FORM);
		await pendingForm(next.port);
		respond(next.port, { data: { db: "pg", replicas: 4 } });
		await expect(fresh).resolves.toMatchObject({ data: { db: "pg", replicas: 4 } });
		gateway.unbind(next.port);
	});

	test("worker exit releases its retain, cancels its actual pending form and fences the old home", async () => {
		const { port, gateway } = fixture();
		const threadId: ThreadId = "w991";
		let retains = 0;
		const peer: WorkerPeer = {
			threadId,
			link: {} as MainThreadLink,
			retain: () => {
				retains++;
				return () => retains--;
			},
		};
		setStudioThreadInteraction(gateway);
		try {
			const globals = studioThreadService.globals!(peer) as StudioThreadGlobals;
			const snapshot = globals.watch(() => {});
			if (!snapshot.interaction) throw new Error("Worker UI was not installed");
			const ui = new StudioRemoteExtensionUiContext(snapshot.interaction, "studio-tool:worker-session:call");
			const result = ui.formDialog(NATIVE_FORM);
			await pendingForm(port);
			expect(retains).toBe(1);
			studioThreadService.onWorkerExit!(peer, "test worker exit");
			await expect(result).rejects.toMatchObject({ code: "INTERACTION_STALE" });
			expect(port.pending()).toBeUndefined();
			expect(retains).toBe(0);
			await expect(ui.formDialog(NATIVE_FORM)).rejects.toMatchObject({ code: "INTERACTION_STALE" });
			expect(port.pending()).toBeUndefined();
		} finally {
			studioThreadService.onWorkerExit!(peer, "test cleanup");
			setStudioThreadInteraction(undefined);
			gateway.unbind(port);
		}
	});
});

const CLOSE_FORM = `<form><fieldset><legend>Close this session?</legend><label><input type="radio" name="intent" value="keep" checked>Keep session</label><label><input type="radio" name="intent" value="close">Close session</label></fieldset></form>`;

async function nativeCloseFixture() {
	const directory = TempDir.createSync("studio-native-form-close-");
	const auth = createInMemoryAuthStorage();
	const settings = Settings.isolated({ "compaction.enabled": false });
	const registry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"), {
		settings,
		ignoreLocalModelConfig: true,
		cacheDbPath: path.join(directory.path(), "models.db"),
	});
	const runtime = new ExtensionRuntime();
	let shutdowns = 0;
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("session_before_shutdown", async (event, ctx) => {
				if (!ctx.hasUI || !ctx.ui.formDialog)
					throw new Error("Native close hook did not receive the Remote form UI");
				const answer = await ctx.ui.formDialog(CLOSE_FORM, { signal: event.signal, cwd: ctx.cwd });
				return { cancel: answer === undefined || answer.data.intent === "keep" };
			});
			pi.on("session_shutdown", () => {
				shutdowns++;
			});
		},
		directory.path(),
		new EventBus(),
		runtime,
		"native-form-close",
	);
	const manager = SessionManager.inMemory(directory.path());
	const runner = new ExtensionRunner([extension], runtime, directory.path(), manager, registry, undefined, settings);
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Bundled test model is unavailable");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		extensionRunner: runner,
	});
	runner.setUserWaitTracker(dialog => session.waitForUser(dialog));
	const { port, gateway, resolved } = fixture();
	setStudioThreadInteraction(gateway);
	await initializeExtensions(session, {
		mode: "rpc",
		uiContext: createDefaultToolUiContext(session.sessionId),
		reportSendError: (action, error) =>
			logger.error("Native form close send failed", { action, error: error.message }),
		reportRuntimeError: error =>
			logger.error("Native form close extension failed", { path: error.extensionPath, error: error.error }),
	});
	return {
		session,
		port,
		resolved,
		shutdowns: () => shutdowns,
		async dispose(): Promise<void> {
			gateway.cancel("Native close test cleanup");
			setStudioThreadInteraction(undefined);
			await session.dispose();
			gateway.unbind(port);
			auth.close();
			directory.removeSync();
		},
	};
}

describe("Studio native shutdown hook form", () => {
	test("a real session_before_shutdown ctx.ui form can veto a close and accept the next attempt without disposing early", async () => {
		const state = await nativeCloseFixture();
		try {
			const first = state.session.confirmClose(new AbortController().signal);
			await pendingForm(state.port);
			expect(state.session.isDisposed).toBe(false);
			expect(state.shutdowns()).toBe(0);
			respond(state.port, { data: { intent: "keep" } });
			await expect(first).resolves.toBe(false);
			expect(state.session.isDisposed).toBe(false);
			expect(state.shutdowns()).toBe(0);

			const next = state.session.confirmClose(new AbortController().signal);
			await pendingForm(state.port);
			respond(state.port, { data: { intent: "close" } });
			await expect(next).resolves.toBe(true);
			expect(state.session.isDisposed).toBe(false);
			expect(state.shutdowns()).toBe(0);
		} finally {
			await state.dispose();
		}
	});

	test("external abort removes the actual shutdown hook's form and prevents its late veto from blocking teardown", async () => {
		const state = await nativeCloseFixture();
		try {
			const controller = new AbortController();
			const closing = state.session.confirmClose(controller.signal);
			const pending = await pendingForm(state.port);
			controller.abort();
			await expect(closing).resolves.toBe(true);
			for (let attempt = 0; attempt < 30 && state.port.pending(); attempt++) await Promise.resolve();
			expect(state.port.pending()).toBeUndefined();
			expect(state.resolved.at(-1)?.outcome).toBe("aborted");
			expect(() =>
				state.port.respond({
					kind: "interaction.respond",
					interactionId: pending.request.interactionId,
					commandId: pending.request.commandId,
					leaseGeneration: pending.leaseGeneration,
					decision: "submit",
					value: { data: { intent: "keep" } },
				}),
			).toThrow("stale");
			expect(state.session.isDisposed).toBe(false);
			expect(state.shutdowns()).toBe(0);
		} finally {
			await state.dispose();
		}
	});
});
