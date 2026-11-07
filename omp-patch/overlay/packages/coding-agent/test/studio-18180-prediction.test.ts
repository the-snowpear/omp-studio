import { expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { StudioMessagePrediction } from "../src/studio/services/message-prediction";
import { createAssistantMessage } from "./helpers/agent-session-setup";

test("Studio offers four choices from one native request despite later advisor notes and editor revisions", async () => {
	const manager = SessionManager.inMemory();
	const messages: AgentMessage[] = [
		createAssistantMessage("Ready for review"),
		{ role: "custom", customType: "advisor", content: "background note", display: false, timestamp: 2 },
	];
	const turn = vi.fn(async () => ({
		replyText: "Run the tests\nReview the changes\nExplain the choice\nContinue\nA fifth choice",
		assistantMessage: createAssistantMessage("prediction"),
	}));
	const session = {
		settings: Settings.isolated({ "composer.predictions": true, "composer.predictionAlternatives": true }),
		messages,
		sessionManager: manager,
		model: { provider: "mock", id: "test" },
		isStreaming: false,
		isCompacting: false,
		ephemeralMaxTokensPreservesRequest: () => true,
		runEphemeralTurn: turn,
		subscribe: () => () => {},
	} as unknown as AgentSession;
	const offered: Array<{ revision: number; suffix: string | null; choices?: readonly string[]; rank?: number }> = [];
	const ready = Promise.withResolvers<void>();
	const prediction = new StudioMessagePrediction(session, (_channel, revision, suffix, choices, rank) => {
		offered.push({ revision, suffix, choices, rank });
		if (choices) ready.resolve();
	});
	try {
		prediction.update("editor", 1, true);
		await ready.promise;
		expect(offered.at(-1)?.choices).toEqual([
			"Run the tests",
			"Review the changes",
			"Explain the choice",
			"Continue",
		]);
		prediction.shown("editor", 1);
		prediction.update("editor", 2, false, "Review");
		expect(offered.at(-1)).toMatchObject({ revision: 2, suffix: " the changes", rank: 1 });
		prediction.accepted("editor", 2, 1);
		prediction.update("editor", 3, true);
		expect(turn).toHaveBeenCalledTimes(1);
		prediction.release("editor");
		prediction.update("editor", 4, true);
		expect(turn).toHaveBeenCalledTimes(1);
		messages.push(createAssistantMessage("Next completed turn"));
		prediction.update("editor", 5, true);
		expect(turn).toHaveBeenCalledTimes(2);
	} finally {
		prediction.dispose();
	}
});
