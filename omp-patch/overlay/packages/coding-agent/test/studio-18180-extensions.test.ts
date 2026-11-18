import { expect, test } from "bun:test";
import type { CustomMessage } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import type { ConversationRuntimeEvent } from "../src/studio/conversation-protocol";
import { StudioConversationEntryIdentity } from "../src/studio/services/conversation-entry-identity";
import { ConversationLiveProjector } from "../src/studio/services/conversation-live-projector";
import { projectConversationBranch } from "../src/studio/services/session-transcript-service";

test("displayed extension and advisor messages keep their identity and order across live and history", () => {
	const manager = SessionManager.inMemory();
	const identities = new StudioConversationEntryIdentity(manager);
	const events: ConversationRuntimeEvent[] = [];
	const projector = new ConversationLiveProjector({
		sessionId: manager.getSessionId(),
		runtimeEpoch: 1,
		reserveMessageId: ({ role }) => manager.reserveMessageId(role),
	});
	projector.onEvent(event => events.push(event));
	const messages: CustomMessage[] = [
		{
			role: "custom",
			customType: "workspace-extension",
			content: "工作区已准备。[查看说明](workspace:details)",
			display: true,
			details: { privateState: "not-public" },
			timestamp: 1,
		},
		{
			role: "custom",
			customType: "advisor",
			content: "<advisory>agent-facing instructions</advisory>",
			details: {
				notes: [
					{ note: "Run the migration first.", advisor: "release", severity: "concern" },
					{ note: "Check the result." },
				],
				privateState: "not-public",
			},
			display: true,
			timestamp: 2,
		},
		{ role: "custom", customType: "advisor", content: "Older plain-text advice", display: true, timestamp: 3 },
		{ role: "custom", customType: "workspace-context", content: "hidden prompt", display: false, timestamp: 4 },
		{ role: "custom", customType: "irc:incoming", content: "agent peer context", display: true, timestamp: 5 },
		{ role: "custom", customType: "advisor", content: "not-public", display: false, timestamp: 6 },
	];
	try {
		for (const message of messages) {
			projector.project(identities.prepare({ type: "message_start", message }));
			manager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				message.attribution,
				message.timestamp,
			);
			projector.project(identities.prepare({ type: "message_end", message }));
		}
		const live = events.flatMap(event => (event.kind === "conversation.message.completed" ? [event.item] : []));
		const history = projectConversationBranch(manager.getBranch());
		expect(history).toEqual(live);
		expect(history).toMatchObject([
			{ role: "extension", content: [{ type: "text", text: messages[0].content }] },
			{
				role: "advisor",
				content: [
					{ type: "text", text: "Run the migration first.", advisor: "release", severity: "concern" },
					{ type: "text", text: "Check the result." },
				],
			},
			{ role: "advisor", content: [{ type: "text", text: "Older plain-text advice" }] },
		]);
		expect(JSON.stringify(events)).not.toContain("not-public");
		expect(JSON.stringify(events)).not.toContain("agent-facing instructions");
	} finally {
		projector.dispose();
	}
});
