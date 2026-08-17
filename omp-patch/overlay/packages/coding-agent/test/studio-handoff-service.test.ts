import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StudioHandoffError, StudioHandoffService } from "@oh-my-pi/pi-coding-agent/studio/services/handoff-service";

function fixture(overrides: Record<string, unknown> = {}) {
	let sessionId = "session-old";
	let handoffCalls = 0;
	const session = {
		isStreaming: false,
		isCompacting: false,
		getVibeModeState: () => undefined,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [{ type: "message" }, { type: "message" }, { type: "tool_call" }],
		},
		async handoff(customInstructions?: string) {
			handoffCalls += 1;
			if (customInstructions === "cancel") return undefined;
			sessionId = "session-new";
			return { document: "# Handoff", savedPath: "/tmp/handoff.md" };
		},
		...overrides,
	} as unknown as AgentSession;
	return { service: new StudioHandoffService(session), handoffCalls: () => handoffCalls };
}

describe("WP StudioHandoffService", () => {
	test("hands off once and returns the rebound session identity", async () => {
		const { service, handoffCalls } = fixture();
		expect(await service.handoff()).toEqual({
			handedOff: true,
			sessionId: "session-new",
			document: "# Handoff",
			savedPath: "/tmp/handoff.md",
		});
		expect(handoffCalls()).toBe(1);
	});

	test("forwards custom instructions to the handoff generator", async () => {
		const seen: Array<string | undefined> = [];
		const session = {
			isStreaming: false,
			isCompacting: false,
			getVibeModeState: () => undefined,
			sessionManager: {
				getSessionId: () => "session-new",
				getBranch: () => [{ type: "message" }, { type: "message" }],
			},
			async handoff(customInstructions?: string) {
				seen.push(customInstructions);
				return { document: "# Handoff" };
			},
		} as unknown as AgentSession;
		const service = new StudioHandoffService(session);
		await service.handoff("focus on the parser bug");
		expect(seen).toEqual(["focus on the parser bug"]);
	});

	test("fails closed while streaming, compacting, vibe active, or empty session", async () => {
		await expect(fixture({ isStreaming: true }).service.handoff()).rejects.toMatchObject({
			code: "BUSY_STREAMING",
		});
		await expect(fixture({ isCompacting: true }).service.handoff()).rejects.toMatchObject({
			code: "BUSY_COMPACTING",
		});
		await expect(fixture({ getVibeModeState: () => ({ enabled: true }) }).service.handoff()).rejects.toBeInstanceOf(
			StudioHandoffError,
		);
		const emptyBranch = fixture({
			sessionManager: { getSessionId: () => "session-old", getBranch: () => [] },
		});
		await expect(emptyBranch.service.handoff()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	});

	test("maps a cancelled handoff and generator failures to typed errors", async () => {
		await expect(fixture().service.handoff("cancel")).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const failing = fixture({
			async handoff() {
				throw new Error("No model selected for handoff");
			},
		});
		await expect(failing.service.handoff()).rejects.toMatchObject({
			code: "INTERNAL_ERROR",
			message: "No model selected for handoff",
		});
	});
});
