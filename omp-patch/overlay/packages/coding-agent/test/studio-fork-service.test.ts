import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StudioForkError, StudioForkService } from "@oh-my-pi/pi-coding-agent/studio/services/fork-service";

function fixture(overrides: Record<string, unknown> = {}) {
	let sessionId = "session-old";
	let forkCalls = 0;
	const session = {
		isStreaming: false,
		isCompacting: false,
		getVibeModeState: () => undefined,
		async fork() {
			forkCalls += 1;
			sessionId = "session-new";
			return true;
		},
		sessionManager: { getSessionId: () => sessionId },
		...overrides,
	} as unknown as AgentSession;
	return { service: new StudioForkService(session), forkCalls: () => forkCalls };
}

describe("WP-035 StudioForkService", () => {
	test("forks once and returns the rebound session identity", async () => {
		const { service, forkCalls } = fixture();
		expect(await service.fork()).toEqual({ forked: true, sessionId: "session-new" });
		expect(forkCalls()).toBe(1);
	});

	test("fails closed while streaming, compacting, or vibe is active", async () => {
		await expect(fixture({ isStreaming: true }).service.fork()).rejects.toMatchObject({
			code: "BUSY_STREAMING",
		});
		await expect(fixture({ isCompacting: true }).service.fork()).rejects.toMatchObject({
			code: "BUSY_COMPACTING",
		});
		await expect(fixture({ getVibeModeState: () => ({ enabled: true }) }).service.fork()).rejects.toBeInstanceOf(
			StudioForkError,
		);
	});
});
