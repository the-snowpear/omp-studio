import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StudioScriptedInteractionPort } from "@oh-my-pi/pi-coding-agent/studio/services/interaction-port";
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
		const navigateTree = async (_target: string, options: Record<string, unknown>) => {
			if (options.reanswerAskResult === undefined) {
				return {
					cancelled: false,
					reopenAsk: {
						toolCallId: "ask-call",
						questions: [{ id: "q1", question: "Pick", options: [{ label: "A" }, { label: "B" }] }],
					},
				};
			}
			return { cancelled: false, askReanswerCommitted: true };
		};
		let resumed = 0;
		const session = {
			navigateTree,
			resumeAfterAskReanswer: () => resumed++,
			sessionManager: { getLeafId: () => "leaf", getTree: () => [] },
		} as unknown as AgentSession;
		const result = await new StudioTreeService(session, new StudioScriptedInteractionPort(["option:1"])).navigate(
			"cmd-1",
			{ targetId: "ask-result" },
		);
		expect(result).toMatchObject({ askReanswerCommitted: true, leafId: "leaf" });
		expect(resumed).toBe(1);
	});

	test("cancelling the remote Ask leaves the tree untouched", async () => {
		const session = {
			navigateTree: async () => ({
				cancelled: false,
				reopenAsk: {
					toolCallId: "ask-call",
					questions: [{ id: "q1", question: "Pick", options: [{ label: "A" }] }],
				},
			}),
			sessionManager: { getLeafId: () => "leaf", getTree: () => [] },
		} as unknown as AgentSession;
		const result = await new StudioTreeService(session, new StudioScriptedInteractionPort([undefined])).navigate(
			"cmd-1",
			{ targetId: "ask-result" },
		);
		expect(result).toMatchObject({ cancelled: true, askReanswerCommitted: false });
	});

	test("an empty single-question multi-select is treated as cancellation", async () => {
		let navigateCalls = 0;
		const session = {
			navigateTree: async () => {
				navigateCalls += 1;
				return {
					cancelled: false,
					reopenAsk: {
						toolCallId: "ask-call",
						questions: [{ id: "q1", question: "Pick any", multi: true, options: [{ label: "A" }] }],
					},
				};
			},
			sessionManager: { getLeafId: () => "leaf", getTree: () => [] },
		} as unknown as AgentSession;
		const result = await new StudioTreeService(session, new StudioScriptedInteractionPort([[]])).navigate("cmd-1", {
			targetId: "ask-result",
		});
		expect(result).toMatchObject({ cancelled: true, askReanswerCommitted: false });
		expect(navigateCalls).toBe(1);
	});

	test("fails closed with recoverable Ask details when no remote interaction port is attached", async () => {
		const session = {
			navigateTree: async () => ({
				cancelled: false,
				reopenAsk: {
					toolCallId: "ask-call",
					questions: [{ id: "q1", question: "Pick", options: [{ label: "A" }] }],
				},
			}),
			sessionManager: { getLeafId: () => "leaf", getTree: () => [] },
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
			sessionManager: { getLeafId: () => "leaf", getTree: () => [] },
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
			sessionManager: { getLeafId: () => "leaf", getTree: () => [] },
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
			sessionManager: { getLeafId: () => "leaf", getTree: () => [] },
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
