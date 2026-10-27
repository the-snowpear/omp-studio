import { describe, expect, test } from "bun:test";
import manualContinuePrompt from "../src/prompts/system/manual-continue.md" with { type: "text" };
import {
	type ContinueTurnOutcome,
	SessionControlService,
	type SessionControlSession,
} from "../src/studio/services/session-control-service";

type PromptCall = { readonly text: string; readonly options: unknown };

function build(overrides: Partial<SessionControlSession> = {}): {
	readonly service: SessionControlService;
	readonly prompts: PromptCall[];
} {
	const prompts: PromptCall[] = [];
	const session: SessionControlSession = {
		isStreaming: false,
		isCompacting: false,
		queuedMessageCount: 0,
		prompt: async (text, options) => {
			prompts.push({ text, options });
			return true;
		},
		steer: async () => {},
		followUp: async () => {},
		resetSessionContext: async () => undefined,
		retry: async () => false,
		abort: async () => {},
		newSession: async () => false,
		...overrides,
	};
	return { service: new SessionControlService(session), prompts };
}

describe("core.continue", () => {
	test("refuses a mid-run continue instead of queueing it behind the live turn", async () => {
		const { service } = build({ isStreaming: true });
		await expect(service.continueTurn({ interrupted: true })).rejects.toMatchObject({
			name: "SessionControlError",
			code: "BUSY_STREAMING",
		});
	});

	test("a finished conversation never becomes a fresh model call", async () => {
		const { service, prompts } = build();
		const outcome: ContinueTurnOutcome = await service.continueTurn({ interrupted: false });
		expect(outcome).toEqual({ started: false, mode: "none" });
		expect(prompts).toHaveLength(0);
	});

	test("a turn the previous process left unfinished is restored, not re-prompted", async () => {
		const { service, prompts } = build({ restoreInterruptedTurn: async () => true });
		expect(await service.continueTurn({ interrupted: true })).toEqual({ started: true, mode: "restored" });
		expect(prompts).toHaveLength(0);
	});

	test("a stopped turn continues through the hidden synthetic directive", async () => {
		const { service, prompts } = build({ restoreInterruptedTurn: async () => false });
		expect(await service.continueTurn({ interrupted: true })).toEqual({ started: true, mode: "continue" });
		expect(prompts).toHaveLength(1);
		const call = prompts[0];
		expect(call?.text).toBe(manualContinuePrompt);
		// The whole point of the synthetic path: the model is told to go on without
		// a visible user turn entering the transcript.
		expect(call?.options).toMatchObject({ synthetic: true, userInitiated: true });
	});

	test("a dropped continue reports nothing happened instead of pretending it started", async () => {
		const { service } = build({ prompt: async () => false, restoreInterruptedTurn: async () => false });
		expect(await service.continueTurn({ interrupted: true })).toEqual({ started: false, mode: "none" });
	});
});
