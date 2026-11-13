import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const FORM_HTML = `<form><fieldset><legend>Pick</legend><label><input type="radio" name="q1" value="a" checked>A</label><label><input type="radio" name="q1" value="b">B</label></fieldset></form>`;
const EMPTY_FORM_HTML = `<form><label><input type="checkbox" name="q1" value="a">Pick any</label></form>`;
const TREE_SETTINGS = Settings.isolated({ "ask.timeout": 0 });
import {
	StudioRemoteInteractionPort,
	StudioScriptedInteractionPort,
} from "@oh-my-pi/pi-coding-agent/studio/services/interaction-port";
import { StudioRuntimeCommandArbiter } from "@oh-my-pi/pi-coding-agent/studio/command-arbiter";
import type { StudioPendingInteraction } from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import { StudioTreeService } from "@oh-my-pi/pi-coding-agent/studio/services/tree-service";

describe("WP-034 StudioTreeService", () => {
	test("projects a path-free tree and preserves the active leaf", () => {
		const session = {
			sessionManager: {
				getLeafId: () => "entry-1",
				getTree: () => [
					{
						entry: {
							type: "message",
							id: "entry-1",
							parentId: null,
							timestamp: "2026-08-12T00:00:00.000Z",
							message: { role: "user", content: "secret path C:/private" },
						},
						label: "Start",
						children: [],
					},
				],
			},
		} as unknown as AgentSession;
		const result = new StudioTreeService(session, new StudioScriptedInteractionPort([])).getTree();
		expect(result).toEqual({
			supportsExactRestore: true,
			leafId: "entry-1",
			roots: [
				{
					id: "entry-1",
					parentId: null,
					type: "message",
					timestamp: "2026-08-12T00:00:00.000Z",
					label: "Start",
					role: "user",
					children: [],
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain("C:/private");
	});

	test("reopens Ask through the remote InteractionPort and resumes the committed branch", async () => {
		let committedAnswer: AgentToolResult<AskToolDetails> | undefined;
		const navigateTree = async (_target: string, options: Record<string, unknown>) => {
			if (options.reanswerAskResult === undefined) {
				return {
					cancelled: false,
					reopenAsk: {
						toolCallId: "ask-call",
						html: FORM_HTML,
					},
				};
			}
			committedAnswer = options.reanswerAskResult as AgentToolResult<AskToolDetails>;
			return { cancelled: false, askReanswerCommitted: true };
		};
		let resumed = 0;
		const session = {
			navigateTree,
			resumeAfterAskReanswer: () => resumed++,
			settings: TREE_SETTINGS,
			sessionManager: {
				getLeafId: () => "leaf",
				getTree: () => [],
				getEntry: () => undefined,
				getCwd: () => process.cwd(),
			},
		} as unknown as AgentSession;
		const result = await new StudioTreeService(
			session,
			new StudioScriptedInteractionPort([
				{ data: { q1: "b" }, notes: [{ name: "q1", value: "b", text: "Keep this choice" }] },
			]),
		).navigate("cmd-1", { targetId: "ask-result" });
		expect(result).toMatchObject({ askReanswerCommitted: true, leafId: "leaf" });
		expect(resumed).toBe(1);
		expect(committedAnswer?.details).toEqual({
			answers: [{ name: "q1", question: "Pick", answer: "B" }],
			notes: [{ name: "q1", question: "Pick", option: "B", value: "b", text: "Keep this choice" }],
		});
	});

	test("cancelling the remote Ask leaves the tree untouched", async () => {
		const session = {
			navigateTree: async () => ({
				cancelled: false,
				reopenAsk: {
					toolCallId: "ask-call",
					html: FORM_HTML,
				},
			}),
			settings: TREE_SETTINGS,
			sessionManager: {
				getLeafId: () => "leaf",
				getTree: () => [],
				getEntry: () => undefined,
				getCwd: () => process.cwd(),
			},
		} as unknown as AgentSession;
		const result = await new StudioTreeService(session, new StudioScriptedInteractionPort([undefined])).navigate(
			"cmd-1",
			{ targetId: "ask-result" },
		);
		expect(result).toMatchObject({ cancelled: true, askReanswerCommitted: false });
	});

	test("an empty single-question multi-select commits a select-none answer", async () => {
		let navigateCalls = 0;
		const session = {
			navigateTree: async (_target: string, options: Record<string, unknown>) => {
				navigateCalls++;
				if (options.reanswerAskResult) return { cancelled: false, askReanswerCommitted: true };
				return {
					cancelled: false,
					reopenAsk: {
						toolCallId: "ask-call",
						html: EMPTY_FORM_HTML,
					},
				};
			},
			resumeAfterAskReanswer: () => {},
			settings: TREE_SETTINGS,
			sessionManager: {
				getLeafId: () => "leaf",
				getTree: () => [],
				getEntry: () => undefined,
				getCwd: () => process.cwd(),
			},
		} as unknown as AgentSession;
		const result = await new StudioTreeService(session, new StudioScriptedInteractionPort([{ data: {} }])).navigate(
			"cmd-1",
			{ targetId: "ask-result" },
		);
		expect(result).toMatchObject({ cancelled: false, askReanswerCommitted: true });
		expect(navigateCalls).toBe(2);
	});

	test("fails closed with recoverable Ask details when no remote interaction port is attached", async () => {
		const session = {
			navigateTree: async () => ({
				cancelled: false,
				reopenAsk: {
					toolCallId: "ask-call",
					html: FORM_HTML,
				},
			}),
			settings: TREE_SETTINGS,
			sessionManager: {
				getLeafId: () => "leaf",
				getTree: () => [],
				getEntry: () => undefined,
				getCwd: () => process.cwd(),
			},
		} as unknown as AgentSession;
		await expect(new StudioTreeService(session).navigate("cmd-1", { targetId: "ask-result" })).rejects.toMatchObject({
			code: "INTERACTION_REQUIRED",
			details: { toolCallId: "ask-call" },
		});
	});

	test("refuses to navigate while streaming without calling navigateTree", async () => {
		let navigateCalls = 0;
		const session = {
			isStreaming: true,
			isCompacting: false,
			navigateTree: async () => {
				navigateCalls += 1;
				return { cancelled: false };
			},
			settings: TREE_SETTINGS,
			sessionManager: {
				getLeafId: () => "leaf",
				getTree: () => [],
				getEntry: () => undefined,
				getCwd: () => process.cwd(),
			},
		} as unknown as AgentSession;
		await expect(new StudioTreeService(session).navigate("cmd-1", { targetId: "entry-1" })).rejects.toMatchObject({
			code: "BUSY_STREAMING",
		});
		expect(navigateCalls).toBe(0);
	});

	test("refuses to navigate while compacting without calling navigateTree", async () => {
		let navigateCalls = 0;
		const session = {
			isStreaming: false,
			isCompacting: true,
			navigateTree: async () => {
				navigateCalls += 1;
				return { cancelled: false };
			},
			settings: TREE_SETTINGS,
			sessionManager: {
				getLeafId: () => "leaf",
				getTree: () => [],
				getEntry: () => undefined,
				getCwd: () => process.cwd(),
			},
		} as unknown as AgentSession;
		await expect(new StudioTreeService(session).navigate("cmd-1", { targetId: "entry-1" })).rejects.toMatchObject({
			code: "BUSY_COMPACTING",
		});
		expect(navigateCalls).toBe(0);
	});

	test("navigate receipts include filtered editorImages", async () => {
		const session = {
			isStreaming: false,
			isCompacting: false,
			navigateTree: async () => ({
				cancelled: false,
				editorText: "look",
				editorImages: [
					{ type: "image", mimeType: "image/png", data: "aaa" },
					{ type: "image", mimeType: "image/svg+xml", data: "skip" },
					{ type: "text", text: "nope" },
				],
			}),
			settings: TREE_SETTINGS,
			sessionManager: {
				getLeafId: () => "leaf",
				getTree: () => [],
				getEntry: () => undefined,
				getCwd: () => process.cwd(),
			},
		} as unknown as AgentSession;
		await expect(new StudioTreeService(session).navigate("cmd-1", { targetId: "entry-1" })).resolves.toEqual({
			cancelled: false,
			aborted: false,
			askReanswerCommitted: false,
			leafId: "leaf",
			editorText: "look",
			editorImages: [{ type: "image", mimeType: "image/png", data: "aaa" }],
		});
	});

	test("refuses to branch while streaming without calling branch", async () => {
		let branchCalls = 0;
		const session = {
			isStreaming: true,
			isCompacting: false,
			branch: async () => {
				branchCalls += 1;
				return { selectedText: "x", selectedImages: [], cancelled: false };
			},
			sessionManager: { getLeafId: () => "leaf", getSessionId: () => "session-1", getTree: () => [] },
		} as unknown as AgentSession;
		await expect(new StudioTreeService(session).branch("cmd-1", { targetId: "entry-1" })).rejects.toMatchObject({
			code: "BUSY_STREAMING",
		});
		expect(branchCalls).toBe(0);
	});

	test("refuses to branch while compacting without calling branch", async () => {
		let branchCalls = 0;
		const session = {
			isStreaming: false,
			isCompacting: true,
			branch: async () => {
				branchCalls += 1;
				return { selectedText: "x", selectedImages: [], cancelled: false };
			},
			sessionManager: { getLeafId: () => "leaf", getSessionId: () => "session-1", getTree: () => [] },
		} as unknown as AgentSession;
		await expect(new StudioTreeService(session).branch("cmd-1", { targetId: "entry-1" })).rejects.toMatchObject({
			code: "BUSY_COMPACTING",
		});
		expect(branchCalls).toBe(0);
	});

	test("branch receipts include sessionId, editorText, and filtered editorImages", async () => {
		const session = {
			isStreaming: false,
			isCompacting: false,
			branch: async () => ({
				selectedText: "from user",
				selectedImages: [
					{ type: "image", mimeType: "image/jpeg", data: "bbb" },
					{ type: "image", mimeType: "image/tiff", data: "skip" },
				],
				cancelled: false,
			}),
			sessionManager: { getLeafId: () => "leaf", getSessionId: () => "branched-session", getTree: () => [] },
		} as unknown as AgentSession;
		await expect(new StudioTreeService(session).branch("cmd-1", { targetId: "entry-1" })).resolves.toEqual({
			cancelled: false,
			sessionId: "branched-session",
			editorText: "from user",
			editorImages: [{ type: "image", mimeType: "image/jpeg", data: "bbb" }],
		});
	});
});

test("restoring and branching a tagged prompt returns editable model selectors, even after registry rewind", async () => {
	const modelMentions = [{ agent: "m1", selector: "provider/model", name: "Model" }];
	const session = {
		modelMentions,
		sessionManager: { getLeafId: () => "leaf", getSessionId: () => "session", getEntry: () => undefined },
		navigateTree: async () => ({ cancelled: false, editorText: 'ask <model agent="m1" name="Model"/>' }),
		branch: async () => {
			session.modelMentions = [];
			return { cancelled: false, selectedText: 'ask <model agent="m1" name="Model"/>' };
		},
	};
	const service = new StudioTreeService(session as unknown as AgentSession);
	expect(await service.navigate("navigate", { targetId: "user" })).toMatchObject({
		editorText: "ask ^provider/model",
	});
	expect(await service.branch("branch", { targetId: "user" })).toMatchObject({ editorText: "ask ^provider/model" });
});

function deferredReanswer() {
	const opened = Promise.withResolvers<StudioPendingInteraction>();
	const port = new StudioRemoteInteractionPort(
		new StudioRuntimeCommandArbiter(
			() => ({ runtimeEpoch: 1, stateVersion: 0, isStreaming: false, isCompacting: false }),
			[],
		),
		pending => opened.resolve(pending),
		() => {},
	);
	let leaf = "original-leaf";
	let committed = 0;
	let resumed = 0;
	const session = {
		sessionId: "tree-session",
		settings: TREE_SETTINGS,
		isStreaming: false,
		isCompacting: false,
		sessionManager: { getLeafId: () => leaf, getEntry: () => undefined, getCwd: () => process.cwd() },
		navigateTree: async (_target: string, options: Record<string, unknown>) => {
			if (options.reanswerAskResult) {
				committed++;
				return { cancelled: false, askReanswerCommitted: true };
			}
			return { cancelled: false, reopenAsk: { toolCallId: "native-ask", html: FORM_HTML } };
		},
		resumeAfterAskReanswer: () => resumed++,
	};
	const tree = new StudioTreeService(session as unknown as AgentSession, port);
	return {
		tree,
		port,
		session,
		published: opened.promise,
		committed: () => committed,
		resumed: () => resumed,
		moveLeaf: (value: string) => {
			leaf = value;
		},
	};
}

describe("Studio form history boundaries", () => {
	test("reports the legacy questions re-answer limit before navigating or manufacturing HTML", async () => {
		let navigated = 0;
		const legacy = { questions: [{ id: "old", question: "Old question?", options: [{ label: "A" }] }] };
		const session = {
			sessionManager: {
				getLeafId: () => "current-leaf",
				getEntry: (id: string) =>
					id === "old-result"
						? {
								type: "message",
								parentId: "old-call",
								message: { role: "toolResult", toolName: "ask", toolCallId: "old-ask" },
							}
						: id === "old-call"
							? {
									type: "message",
									parentId: null,
									message: {
										role: "assistant",
										content: [{ type: "toolCall", id: "old-ask", arguments: legacy }],
									},
								}
							: undefined,
			},
			navigateTree: async () => {
				navigated++;
				return { cancelled: false };
			},
		};
		await expect(
			new StudioTreeService(session as unknown as AgentSession, new StudioScriptedInteractionPort([])).navigate(
				"legacy",
				{ targetId: "old-result" },
			),
		).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("旧版 questions") });
		expect(navigated).toBe(0);
		expect(legacy).not.toHaveProperty("html");
	});

	test("does not write a fulfilled answer into a history branch that changed while the form was open", async () => {
		const state = deferredReanswer();
		const navigating = state.tree.navigate("tree-late", { targetId: "ask-result" });
		const pending = await state.published;
		state.port.respond({
			kind: "interaction.respond",
			interactionId: pending.request.interactionId,
			commandId: pending.request.commandId,
			leaseGeneration: pending.leaseGeneration,
			decision: "submit",
			value: { data: { q1: "b" } },
		});
		state.moveLeaf("other-branch");
		await expect(navigating).rejects.toMatchObject({ code: "INTERACTION_STALE" });
		expect(state.committed()).toBe(0);
		expect(state.resumed()).toBe(0);
		expect(state.session.sessionManager.getLeafId()).toBe("other-branch");
	});

	test("operator abort closes the actual form and fences its late response without committing history", async () => {
		const state = deferredReanswer();
		const navigating = state.tree.navigate("tree-abort", { targetId: "ask-result" });
		const pending = await state.published;
		state.tree.cancelReanswer("Operator abort");
		await expect(navigating).rejects.toMatchObject({ code: "INTERACTION_STALE" });
		expect(state.port.pending()).toBeUndefined();
		expect(() =>
			state.port.respond({
				kind: "interaction.respond",
				interactionId: pending.request.interactionId,
				commandId: pending.request.commandId,
				decision: "submit",
				value: { data: { q1: "b" } },
			}),
		).toThrow("stale");
		expect(state.committed()).toBe(0);
		expect(state.resumed()).toBe(0);
	});

	test("work starting during the dialog cannot be overwritten by its answer", async () => {
		const state = deferredReanswer();
		const navigating = state.tree.navigate("tree-busy", { targetId: "ask-result" });
		const pending = await state.published;
		state.session.isStreaming = true;
		state.port.respond({
			kind: "interaction.respond",
			interactionId: pending.request.interactionId,
			commandId: pending.request.commandId,
			decision: "submit",
			value: { data: { q1: "b" } },
		});
		await expect(navigating).rejects.toMatchObject({ code: "BUSY_STREAMING" });
		expect(state.committed()).toBe(0);
		expect(state.resumed()).toBe(0);
	});
});
