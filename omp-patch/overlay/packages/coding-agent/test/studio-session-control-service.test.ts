import { describe, expect, test } from "bun:test";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { SessionControlSession } from "@oh-my-pi/pi-coding-agent/studio/services/session-control-service";
import {
	SessionControlError,
	SessionControlService,
} from "@oh-my-pi/pi-coding-agent/studio/services/session-control-service";

class FakeSessionControlSession implements SessionControlSession {
	isStreaming = false;
	isCompacting = false;
	queuedMessageCount = 0;
	sessionFile: string | undefined = "C:/sessions/current.jsonl";
	readonly followUpCalls: string[] = [];
	readonly steerCalls: string[] = [];
	readonly promptCalls: string[] = [];
	readonly promptOptions: Array<{ images?: unknown[]; prependMessages?: unknown[] } | undefined> = [];
	readonly customMessages: Array<{ customType: string; streamingBehavior?: string; queueOnly?: boolean }> = [];
	readonly abortCalls: unknown[] = [];
	readonly titleGenerationCalls: string[] = [];
	resetCalls = 0;
	retryCalls = 0;
	resetResult: { droppedCount: number } | undefined = { droppedCount: 3 };
	retryResult = true;
	promptResult = true;
	promptError: unknown;
	steerError: unknown;
	followUpError: unknown;
	abortError: unknown;
	newSessionCalls = 0;
	newSessionResult = true;

	prompt(text: string, options?: { images?: unknown[]; prependMessages?: unknown[] }): Promise<boolean> {
		this.promptCalls.push(text);
		this.promptOptions.push(options);
		if (this.promptError !== undefined) return Promise.reject(this.promptError);
		return Promise.resolve(this.promptResult);
	}

	promptCustomMessage(
		message: { customType: string },
		options?: { streamingBehavior?: "steer" | "followUp"; queueOnly?: boolean },
	): Promise<void> {
		this.customMessages.push({
			customType: message.customType,
			streamingBehavior: options?.streamingBehavior,
			queueOnly: options?.queueOnly,
		});
		this.queuedMessageCount += 1;
		return Promise.resolve();
	}

	steer(text: string): Promise<void> {
		this.steerCalls.push(text);
		if (this.steerError !== undefined) return Promise.reject(this.steerError);
		return Promise.resolve();
	}

	followUp(text: string): Promise<void> {
		this.followUpCalls.push(text);
		if (this.followUpError !== undefined) return Promise.reject(this.followUpError);
		this.queuedMessageCount += 1;
		return Promise.resolve();
	}

	resetSessionContext(): Promise<{ droppedCount: number } | undefined> {
		this.resetCalls += 1;
		this.queuedMessageCount = 0;
		return Promise.resolve(this.resetResult);
	}

	retry(): Promise<boolean> {
		this.retryCalls += 1;
		return Promise.resolve(this.retryResult);
	}

	abort(options?: { reason?: string }): Promise<void> {
		this.abortCalls.push(options);
		if (this.abortError !== undefined) return Promise.reject(this.abortError);
		this.isStreaming = false;
		return Promise.resolve();
	}

	maybeStartTitleGeneration: ((text: string) => void) | undefined = (text: string) => {
		this.titleGenerationCalls.push(text);
	};

	newSession(options?: { drop?: boolean }): Promise<boolean> {
		if (options?.drop !== true) throw new Error("Expected destructive session transition");
		this.newSessionCalls += 1;
		return Promise.resolve(this.newSessionResult);
	}
}

describe("WP-021/022/023/024/025 SessionControlService", () => {
	test("queue.enqueue reuses followUp and reports the pending queue length", async () => {
		const session = new FakeSessionControlSession();
		const service = new SessionControlService(session);
		const result = await service.enqueue("finish the tests");
		expect(session.followUpCalls).toEqual(["finish the tests"]);
		expect(result).toEqual({ queued: true, pendingMessages: 1 });
	});

	test("queue.enqueue fails closed while compacting", async () => {
		const session = new FakeSessionControlSession();
		session.isCompacting = true;
		const service = new SessionControlService(session);
		await expect(service.enqueue("x")).rejects.toMatchObject({ code: "BUSY_COMPACTING" });
		expect(session.followUpCalls).toEqual([]);
	});

	test("session.clearContext returns the droppedCount reset boundary", async () => {
		const session = new FakeSessionControlSession();
		const service = new SessionControlService(session);
		await expect(service.clearContext()).resolves.toEqual({ droppedCount: 3 });
		expect(session.resetCalls).toBe(1);
	});

	test("session.clearContext rejects while streaming or compacting without mutating", async () => {
		const session = new FakeSessionControlSession();
		session.isStreaming = true;
		const service = new SessionControlService(session);
		await expect(service.clearContext()).rejects.toMatchObject({ code: "BUSY_STREAMING" });
		expect(session.resetCalls).toBe(0);
		session.isStreaming = false;
		session.isCompacting = true;
		await expect(service.clearContext()).rejects.toMatchObject({ code: "BUSY_COMPACTING" });
		expect(session.resetCalls).toBe(0);
	});

	test("session.clearContext maps a busy primitive result to COMMAND_BLOCKED", async () => {
		const session = new FakeSessionControlSession();
		session.resetResult = undefined;
		const service = new SessionControlService(session);
		await expect(service.clearContext()).rejects.toMatchObject({
			code: "COMMAND_BLOCKED",
			details: { reason: "SESSION_BUSY" },
		});
	});

	test("session.drop requires approval and then reuses the destructive new-session primitive", async () => {
		const session = new FakeSessionControlSession();
		const service = new SessionControlService(session);
		await expect(service.drop(false)).resolves.toEqual({ dropped: false, reason: "cancelled" });
		expect(session.newSessionCalls).toBe(0);
		await expect(service.drop(true)).resolves.toEqual({ dropped: true });
		expect(session.newSessionCalls).toBe(1);
		session.sessionFile = undefined;
		await expect(service.drop(true)).resolves.toEqual({ dropped: false, reason: "nothing_to_drop" });
		expect(session.newSessionCalls).toBe(1);
	});

	test("turn.retry reports retried and nothing_to_retry explicitly", async () => {
		const session = new FakeSessionControlSession();
		const service = new SessionControlService(session);
		await expect(service.retry()).resolves.toEqual({ retried: true });
		expect(session.retryCalls).toBe(1);
		session.retryResult = false;
		await expect(service.retry()).resolves.toEqual({ retried: false, reason: "nothing_to_retry" });
	});

	test("turn.retry rejects while streaming or compacting", async () => {
		const session = new FakeSessionControlSession();
		session.isStreaming = true;
		const service = new SessionControlService(session);
		await expect(service.retry()).rejects.toMatchObject({ code: "BUSY_STREAMING" });
		expect(session.retryCalls).toBe(0);
		session.isStreaming = false;
		session.isCompacting = true;
		await expect(service.retry()).rejects.toMatchObject({ code: "BUSY_COMPACTING" });
		expect(session.retryCalls).toBe(0);
	});

	test("core.prompt reuses AgentSession.prompt and fails closed while streaming", async () => {
		const session = new FakeSessionControlSession();
		const service = new SessionControlService(session);
		await expect(service.prompt("do the thing")).resolves.toEqual({ started: true });
		expect(session.promptCalls).toEqual(["do the thing"]);
		session.isStreaming = true;
		await expect(service.prompt("second")).rejects.toMatchObject({ code: "BUSY_STREAMING" });
		expect(session.promptCalls).toEqual(["do the thing"]);
	});

	test("core.prompt maps an AgentBusyError race to BUSY_STREAMING", async () => {
		const session = new FakeSessionControlSession();
		session.promptError = new AgentBusyError();
		const service = new SessionControlService(session);
		await expect(service.prompt("raced")).rejects.toMatchObject({ code: "BUSY_STREAMING" });
	});

	test("core.prompt forwards skill preludes as prependMessages", async () => {
		const session = new FakeSessionControlSession();
		const service = new SessionControlService(session);
		const prelude = {
			role: "custom" as const,
			customType: "skill-prompt",
			content: "SKILL:alpha",
			display: true,
			attribution: "user" as const,
			timestamp: 1,
		};
		await expect(service.prompt(" /skill:alpha do it", undefined, [prelude])).resolves.toEqual({ started: true });
		expect(session.promptCalls).toEqual([" /skill:alpha do it"]);
		expect(session.promptOptions[0]?.prependMessages).toEqual([prelude]);
	});

	test("core.followUp queues skill preludes before the user text", async () => {
		const session = new FakeSessionControlSession();
		const service = new SessionControlService(session);
		await expect(
			service.followUp("then continue", undefined, [
				{ customType: "skill-prompt", content: "SKILL:alpha", display: true },
			]),
		).resolves.toEqual({ queued: true, pendingMessages: 2 });
		expect(session.customMessages).toEqual([
			{ customType: "skill-prompt", streamingBehavior: "followUp", queueOnly: true },
		]);
		expect(session.followUpCalls).toEqual(["then continue"]);
	});

	test("core.steer applies deferred preferences before the user text", async () => {
		const session = new FakeSessionControlSession();
		const applied: string[] = [];
		const service = new SessionControlService(session, {
			beforeQueuedUserTurn: async () => {
				applied.push("pending");
			},
		});
		session.isStreaming = true;
		await expect(service.steer("course-correct")).resolves.toEqual({ queued: true, pendingMessages: 0 });
		expect(applied).toEqual(["pending"]);
		expect(session.steerCalls).toEqual(["course-correct"]);
		session.steerError = new AgentBusyError();
		await expect(service.steer("raced")).rejects.toMatchObject({ code: "BUSY_STREAMING" });
	});

	test("core.followUp defers preference apply while streaming so the current turn keeps its tools", async () => {
		const session = new FakeSessionControlSession();
		const applied: string[] = [];
		const service = new SessionControlService(session, {
			beforeQueuedUserTurn: async () => {
				applied.push("pending");
			},
		});
		session.isStreaming = true;
		await service.followUp("after this turn");
		expect(applied).toEqual([]);
		session.isStreaming = false;
		await service.followUp("now idle");
		expect(applied).toEqual(["pending"]);
	});

	test("core.abort reuses AgentSession.abort with a user-interrupt reason", async () => {
		const session = new FakeSessionControlSession();
		const service = new SessionControlService(session);
		await expect(service.abort()).resolves.toEqual({ aborted: true });
		expect(session.abortCalls).toEqual([{ reason: "Interrupted by user" }]);
	});

	test("core.prompt starts the shared first-input title generator", async () => {
		const session = new FakeSessionControlSession();
		const service = new SessionControlService(session);
		await expect(service.prompt("fix the resolver")).resolves.toEqual({ started: true });
		expect(session.titleGenerationCalls).toEqual(["fix the resolver"]);
		session.isStreaming = true;
		await expect(service.prompt("second")).rejects.toMatchObject({ code: "BUSY_STREAMING" });
		expect(session.titleGenerationCalls).toEqual(["fix the resolver"]);
	});

	test("steer, followUp, and enqueue retry title generation from later user text", async () => {
		const session = new FakeSessionControlSession();
		const service = new SessionControlService(session);
		await service.steer("stop that");
		await service.followUp("then continue");
		await service.enqueue("finish the tests");
		expect(session.titleGenerationCalls).toEqual(["stop that", "then continue", "finish the tests"]);
	});

	test("title generation is skipped when the session omits the hook", async () => {
		const session = new FakeSessionControlSession();
		session.maybeStartTitleGeneration = undefined;
		const service = new SessionControlService(session);
		await expect(service.prompt("still works")).resolves.toEqual({ started: true });
		expect(session.promptCalls).toEqual(["still works"]);
		expect(session.titleGenerationCalls).toEqual([]);
	});

	test("compacting refuses user turns before title generation", async () => {
		const session = new FakeSessionControlSession();
		session.isCompacting = true;
		const service = new SessionControlService(session);
		await expect(service.prompt("x")).rejects.toMatchObject({ code: "BUSY_COMPACTING" });
		await expect(service.steer("x")).rejects.toMatchObject({ code: "BUSY_COMPACTING" });
		await expect(service.followUp("x")).rejects.toMatchObject({ code: "BUSY_COMPACTING" });
		await expect(service.abort()).rejects.toMatchObject({ code: "BUSY_COMPACTING" });
		expect(session.promptCalls).toEqual([]);
		expect(session.steerCalls).toEqual([]);
		expect(session.followUpCalls).toEqual([]);
		expect(session.abortCalls).toEqual([]);
		expect(session.titleGenerationCalls).toEqual([]);
	});

	test("SessionControlError carries its code through the dispatcher contract", () => {
		const error = new SessionControlError("INTERACTION_REQUIRED", "approval needed");
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe("INTERACTION_REQUIRED");
		expect(error.retryable).toBe(false);
	});
});
