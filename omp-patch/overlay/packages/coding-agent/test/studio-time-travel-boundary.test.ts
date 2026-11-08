import { expect, test } from "bun:test";
import type { AgentSession } from "../src/session/agent-session";
import { StudioTimeTravelBoundary, type TimeTravelCaptureRequest } from "../src/studio/services/time-travel-boundary";

test("waits for Host capture and handles queued messages without duplicate before points", async () => {
	let leafId: string | null = null;
	const requests: TimeTravelCaptureRequest[] = [];
	const session = {
		sessionManager: {
			getSessionId: () => "s",
			getCwd: () => "/workspace",
			getLeafId: () => leafId,
			flush: async () => {},
		},
		emitNotice: () => {},
	} as unknown as AgentSession;
	const boundary = new StudioTimeTravelBoundary(session, 1);
	let captured!: () => void;
	const received = new Promise<void>(resolve => {
		captured = resolve;
	});
	boundary.subscribe(request => {
		requests.push(request);
		captured();
	});
	let finished = false;
	const before = boundary.capture("before").then(() => {
		finished = true;
	});
	await received;
	expect(finished).toBe(false);
	boundary.complete(requests[0]!.requestId);
	await before;
	await boundary.capture("before");
	expect(requests).toHaveLength(1);
	boundary.subscribe(request => {
		requests.push(request);
		boundary.complete(request.requestId);
	});
	leafId = "first-response";
	await boundary.capture("before");
	leafId = "second-response";
	await boundary.capture("after");
	await boundary.capture("after");
	expect(requests.map(request => [request.phase, request.leafId])).toEqual([
		["before", null],
		["after", "first-response"],
		["before", "first-response"],
		["after", "second-response"],
	]);
});

test("a capture failure warns but lets the conversation continue", async () => {
	const warnings: string[] = [];
	const session = {
		sessionManager: {
			getSessionId: () => "s",
			getCwd: () => "/workspace",
			getLeafId: () => null,
			flush: async () => {},
		},
		emitNotice: (_level: string, message: string) => warnings.push(message),
	} as unknown as AgentSession;
	const boundary = new StudioTimeTravelBoundary(session, 1);
	boundary.subscribe(request => boundary.complete(request.requestId, "disk full"));
	await boundary.capture("before");
	expect(warnings).toEqual(["Time Travel: disk full"]);
});
