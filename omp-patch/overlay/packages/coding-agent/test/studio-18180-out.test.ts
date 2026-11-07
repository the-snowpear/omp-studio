import { expect, test } from "bun:test";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import "../src/internal-urls/router";
import { SessionManager } from "../src/session/session-manager";
import type { AgentSessionEvent } from "../src/session/agent-session-events";
import { StudioConversationEntryIdentity } from "../src/studio/services/conversation-entry-identity";
import { ConversationLiveProjector } from "../src/studio/services/conversation-live-projector";
import { projectConversationBranch } from "../src/studio/services/session-transcript-service";
import type { ConversationRuntimeEvent } from "../src/studio/conversation-protocol";
import { createAssistantMessage } from "./helpers/agent-session-setup";

test("out replies stream from raw worker deltas despite stale provider args and keep their persisted identity", () => {
	const manager = SessionManager.inMemory();
	const ids = new StudioConversationEntryIdentity(manager),
		events: ConversationRuntimeEvent[] = [];
	const projector = new ConversationLiveProjector({
		sessionId: manager.getSessionId(),
		runtimeEpoch: 1,
		reserveMessageId: () => {
			throw new Error("Worker events must own their identity");
		},
	});
	projector.onEvent(event => events.push(event));
	const emit = (event: AgentSessionEvent) => projector.project(ids.prepare(event));
	const call: ToolCall = { type: "toolCall", id: "out-write", name: "write", arguments: {} };
	const message = createAssistantMessage("");
	message.content = [call];
	message.stopReason = "toolUse";
	try {
		emit({ type: "agent_start" });
		emit({ type: "message_start", message });
		for (const delta of ['{"path":"ou', 't://","content":"中文', "\\uD83D", '\\uDE00"}']) {
			emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta, partial: message },
			});
		}
		projector.flush();
		expect(events.filter(event => event.kind === "conversation.tool.updated").at(-1)).toMatchObject({
			output: "中文😀",
			presentation: "reply",
		});
		call.arguments = { path: "out://", content: "中文😀" };
		emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message },
		});
		manager.appendMessage(message);
		emit({ type: "message_end", message });
		emit({
			type: "tool_execution_end",
			toolCallId: call.id,
			toolName: "write",
			result: { content: [{ type: "text", text: "Reply sent" }], details: {} },
			isError: false,
		});
		projector.flush();
		const history = projectConversationBranch(manager.getBranch());
		expect(history[0]).toMatchObject({
			kind: "message",
			content: [{ type: "toolCall", presentation: "reply", arguments: { path: "out://", content: "中文😀" } }],
		});
		const completed = events.find(event => event.kind === "conversation.message.completed");
		expect(completed?.kind === "conversation.message.completed" && completed.item.itemId).toBe(history[0]?.itemId);
		expect(events.some(event => event.kind === "conversation.turn.completed")).toBe(false);
	} finally {
		projector.dispose();
	}
});

test("a worker first observed at message end still reopens under the entry written on its home thread", () => {
	const manager = SessionManager.inMemory(),
		ids = new StudioConversationEntryIdentity(manager);
	const message = createAssistantMessage("Already running before Studio subscribed");
	ids.prepare({ type: "message_start", message });
	manager.appendMessage(message);
	const projector = new ConversationLiveProjector({
		sessionId: manager.getSessionId(),
		runtimeEpoch: 1,
		reserveMessageId: () => {
			throw new Error("Late observation must not invent another identity");
		},
	});
	const events: ConversationRuntimeEvent[] = [];
	projector.onEvent(event => events.push(event));
	try {
		projector.project(ids.prepare({ type: "message_end", message }));
		const completed = events.find(event => event.kind === "conversation.message.completed");
		expect(completed?.kind === "conversation.message.completed" && completed.item.itemId).toBe(
			manager.getBranch()[0]?.id,
		);
	} finally {
		projector.dispose();
	}
});
