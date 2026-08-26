import { describe, expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { StudioEventEnvelope } from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import { StudioStateProjector } from "@oh-my-pi/pi-coding-agent/studio/state-projector";
import type { StudioHostRuntime } from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";

function runtimeFixture(): { runtime: StudioHostRuntime; manager: SessionManager } {
	const manager = SessionManager.inMemory();
	const runtime = {
		runtimeId: "runtime-title",
		runtimeEpoch: 3,
		sessionId: "session-title",
		sessionManager: manager,
		session: {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			getAgentId: () => "Main",
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
			}),
			getContextBreakdown: () => undefined,
			messages: [],
		},
		services: {
			pause: { state: () => ({ paused: false, pauseEpoch: 0 }), onChange: () => () => {} },
			loop: { state: () => undefined, onChange: () => () => {} },
			live: { state: () => ({ status: "off" }), onChange: () => () => {} },
			modes: { state: () => ({}), onChange: () => () => {} },
			agents: { list: () => [], onChange: () => () => {} },
			jobs: { list: () => [] },
		},
	} as unknown as StudioHostRuntime;
	return { runtime, manager };
}

describe("Studio session title projection", () => {
	test("projects native auto and manual title changes through state.changed", async () => {
		const { runtime, manager } = runtimeFixture();
		const projector = new StudioStateProjector(runtime);
		const events: StudioEventEnvelope[] = [];
		projector.onEvent(event => events.push(event));

		expect(projector.snapshot()).not.toHaveProperty("sessionTitle");
		expect(await manager.setSessionName("Generated title", "auto")).toBe(true);
		expect(await manager.setSessionName("Manual title", "user")).toBe(true);
		expect(await manager.setSessionName("Late generated title", "auto")).toBe(false);

		const titleSnapshots = events
			.filter(event => event.event.kind === "state.changed")
			.map(event => (event.event.kind === "state.changed" ? event.event.snapshot : undefined));
		expect(titleSnapshots).toHaveLength(2);
		expect(titleSnapshots[0]).toMatchObject({
			sessionTitle: "Generated title",
			sessionTitleSource: "auto",
		});
		expect(titleSnapshots[1]).toMatchObject({
			sessionTitle: "Manual title",
			sessionTitleSource: "user",
		});
		projector.dispose();
	});
});
