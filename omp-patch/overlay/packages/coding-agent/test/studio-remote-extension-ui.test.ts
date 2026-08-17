import { describe, expect, test } from "bun:test";
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
		await expect(promise).resolves.toBe(true);
		// deny: cancel resolves false
		const denied = ui.approveTool({
			toolName: "bash",
			toolCallId: "call-6b",
			title: "Allow bash?",
			details: { toolName: "bash", toolCallId: "call-6b", summary: "x", risk: "high" },
			approvalMode: "write",
		});
		respond(port, undefined, "cancel");
		await expect(denied).resolves.toBe(false);
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
				options: [
					{ label: "Yes", description: "coast", preview: "v *= 0.92" },
					{ label: "No" },
				],
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
					options: [{ id: "option:0", label: "On" }, { id: "option:1", label: "Off" }],
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
