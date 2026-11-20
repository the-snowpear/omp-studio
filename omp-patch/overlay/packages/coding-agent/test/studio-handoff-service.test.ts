import { expect, test } from "bun:test";
import type { AgentSession } from "../src/session/agent-session";
import { StudioHandoffService } from "../src/studio/services/handoff-service";

test("handoff compacts the active session in the background while an existing reply streams", async () => {
	const complete = Promise.withResolvers<{ summary: string }>();
	const seen: unknown[] = [];
	const session = {
		sessionId: "same-session",
		isStreaming: true,
		isCompacting: false,
		getVibeModeState: () => undefined,
		sessionManager: { getBranch: () => [{ type: "message" }, { type: "message" }] },
		compact: (...args: unknown[]) => {
			seen.push(args);
			return complete.promise;
		},
	} as unknown as AgentSession;
	const service = new StudioHandoffService(session);
	const running = service.handoff("focus on the parser");
	expect(seen).toEqual([["focus on the parser", { mode: "handoff" }]]);
	expect(StudioHandoffService.running(session)).toBe(true);
	await expect(service.handoff()).rejects.toMatchObject({ code: "BUSY_COMPACTING" });
	complete.resolve({ summary: "# Handoff" });
	expect(await running).toEqual({ handedOff: true, sessionId: "same-session", document: "# Handoff" });
	expect(StudioHandoffService.running(session)).toBe(false);
});
