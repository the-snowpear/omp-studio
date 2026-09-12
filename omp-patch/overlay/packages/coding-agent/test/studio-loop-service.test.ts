import { describe, expect, test } from "bun:test";
import {
	StudioLoopError,
	type StudioLoopPort,
	StudioLoopService,
} from "@oh-my-pi/pi-coding-agent/studio/services/loop-service";

function fixture(action: "prompt" | "compact" | "reset" = "prompt") {
	let now = 0;
	let blocked = false;
	let vibe = false;
	let nextTimer = 1;
	const timers = new Map<number, () => void>();
	const submitted: string[] = [];
	let compacted = 0;
	let reset = 0;
	const errors: unknown[] = [];
	const port: StudioLoopPort = {
		action: () => action,
		isBlocked: () => blocked,
		isVibeActive: () => vibe,
		submitPrompt: prompt => {
			submitted.push(prompt);
		},
		compact: () => {
			compacted += 1;
		},
		reset: () => {
			reset += 1;
		},
		nowMs: () => now,
		setTimer: callback => {
			const id = nextTimer++;
			timers.set(id, callback);
			return id;
		},
		clearTimer: timer => {
			timers.delete(timer as number);
		},
		onError: error => errors.push(error),
	};
	const runNext = async () => {
		const entry = timers.entries().next().value as [number, () => void] | undefined;
		if (!entry) return false;
		timers.delete(entry[0]);
		entry[1]();
		await Bun.sleep(0);
		return true;
	};
	return {
		service: new StudioLoopService(port, 0),
		port,
		submitted,
		errors,
		timers,
		runNext,
		setBlocked(value: boolean) {
			blocked = value;
		},
		setVibe(value: boolean) {
			vibe = value;
		},
		advance(ms: number) {
			now += ms;
		},
		counts: () => ({ compacted, reset }),
	};
}

describe("WP-033 StudioLoopService", () => {
	test("manual prompt preparation holds automatic submission and can resume a previously paused loop", async () => {
		const harness = fixture();
		harness.service.enable("previous");
		harness.service.pause();
		const held = harness.service.holdPrompt();
		held.capture("replacement");
		expect(harness.service.scheduleNext()).toBe(false);
		expect(harness.timers.size).toBe(0);
		held.release();
		await harness.runNext();
		expect(harness.submitted).toEqual(["replacement"]);
	});

	test("pausing during a held prompt invalidates its late capture", async () => {
		const harness = fixture();
		harness.service.enable("previous");
		const held = harness.service.holdPrompt();
		harness.service.pause();
		held.capture("must not revive");
		held.release();
		expect(harness.service.state()?.status).toBe("paused");
		expect(harness.timers.size).toBe(0);
		expect(harness.submitted).toEqual([]);
	});

	test("duration expiry disables a blocked loop without evaluating its condition", async () => {
		const harness = fixture();
		harness.service.enable("repeat", { minutes: 1 });
		harness.setBlocked(true);
		harness.advance(60000);
		harness.service.scheduleNext();
		await harness.runNext();
		expect(harness.service.state()).toBeUndefined();
		expect(harness.timers.size).toBe(0);
	});
	test("checks continuation conditions only after enable and stops on a halt verdict", async () => {
		const harness = fixture();
		let checks = 0;
		harness.port.evaluateCondition = async () => {
			checks += 1;
			return checks === 1 ? { kind: "continue" } : { kind: "halt", message: "done" };
		};
		harness.service.enable("repeat", { turns: 3 }, { command: "test -f done", until: true });
		expect(checks).toBe(0);
		harness.service.scheduleNext();
		await harness.runNext();
		expect(harness.submitted).toEqual(["repeat"]);
		harness.service.scheduleNext();
		await harness.runNext();
		expect(harness.submitted).toEqual(["repeat"]);
		expect(harness.service.state()).toBeUndefined();
	});

	test("pause cancels an in-flight condition and rejects its late continuation", async () => {
		const harness = fixture();
		const pending = Promise.withResolvers<{ kind: "continue" }>();
		let signal: AbortSignal | undefined;
		harness.port.evaluateCondition = async (_condition, currentSignal) => {
			signal = currentSignal;
			return pending.promise;
		};
		harness.service.enable("repeat", undefined, { command: "check", until: false });
		harness.service.scheduleNext();
		await harness.runNext();
		expect(harness.service.state()?.evaluatingCondition).toBe(true);
		harness.service.pause();
		expect(signal?.aborted).toBe(true);
		pending.resolve({ kind: "continue" });
		await Bun.sleep(0);
		expect(harness.submitted).toEqual([]);
		expect(harness.service.state()?.status).toBe("paused");
	});

	test("vibe activation during condition evaluation prevents reset and submission", async () => {
		const harness = fixture("reset");
		const pending = Promise.withResolvers<{ kind: "continue" }>();
		harness.port.evaluateCondition = () => pending.promise;
		harness.service.enable("repeat", undefined, { command: "check", until: true });
		harness.service.scheduleNext();
		await harness.runNext();
		harness.setVibe(true);
		pending.resolve({ kind: "continue" });
		await Bun.sleep(0);
		expect(harness.counts().reset).toBe(0);
		expect(harness.submitted).toEqual([]);
		expect(harness.service.state()).toBeUndefined();
		expect(harness.errors[0]).toBeInstanceOf(StudioLoopError);
	});

	test("condition failures stop the loop without consuming a submission", async () => {
		const harness = fixture();
		harness.port.evaluateCondition = async () => ({ kind: "error", message: "condition timed out" });
		harness.service.enable("repeat", undefined, { command: "sleep 60", until: false });
		harness.service.scheduleNext();
		await harness.runNext();
		expect(harness.submitted).toEqual([]);
		expect(harness.errors[0]).toMatchObject({ message: "condition timed out" });
		expect(harness.service.state()).toBeUndefined();
	});

	test("a blocked session does not launch condition commands", async () => {
		const harness = fixture();
		let checks = 0;
		harness.port.evaluateCondition = async () => {
			checks += 1;
			return { kind: "continue" };
		};
		harness.setBlocked(true);
		harness.service.enable("repeat", undefined, { command: "check", until: false });
		harness.service.scheduleNext();
		await harness.runNext();
		expect(checks).toBe(0);
		harness.setBlocked(false);
		await harness.runNext();
		expect(harness.submitted).toEqual(["repeat"]);
	});
	test("enables, captures a prompt, pauses, resumes, and disables", () => {
		const { service } = fixture();
		expect(service.enable().state).toEqual({ status: "waiting" });
		expect(service.capturePrompt("  repeat me  ")).toEqual({ status: "running", prompt: "repeat me" });
		expect(service.pause()).toEqual({ status: "paused" });
		expect(service.capturePrompt("again")).toEqual({ status: "running", prompt: "again" });
		expect(service.disable()).toEqual({ disabled: true });
		expect(service.state()).toBeUndefined();
	});

	test("runs an iteration limit and disables before a third submission", async () => {
		const f = fixture();
		f.service.enable("repeat", { turns: 2 });
		f.service.scheduleNext();
		await f.runNext();
		expect(f.submitted).toEqual(["repeat"]);
		expect(f.service.state()).toMatchObject({ iterations: 1 });
		f.service.scheduleNext();
		await f.runNext();
		expect(f.submitted).toEqual(["repeat", "repeat"]);
		f.service.scheduleNext();
		await f.runNext();
		expect(f.service.state()).toBeUndefined();
	});

	test("expires a duration limit using the injected clock", async () => {
		const f = fixture();
		f.service.enable("repeat", { minutes: 1 });
		f.advance(60_000);
		f.service.scheduleNext();
		await f.runNext();
		expect(f.submitted).toEqual([]);
		expect(f.service.state()).toBeUndefined();
	});

	test("replaces the limit on an already-enabled loop without dropping the prompt", async () => {
		const f = fixture();
		f.service.enable("repeat", { turns: 1 });
		expect(f.service.setLimit({ turns: 2 })).toEqual({ status: "running", prompt: "repeat" });
		f.service.scheduleNext();
		await f.runNext();
		expect(f.submitted).toEqual(["repeat"]);
		expect(f.service.state()).toMatchObject({ iterations: 1, prompt: "repeat" });
		f.service.scheduleNext();
		await f.runNext();
		expect(f.submitted).toEqual(["repeat", "repeat"]);
		f.service.scheduleNext();
		await f.runNext();
		expect(f.service.state()).toBeUndefined();
	});

	test("setLimit fails closed when loop is not enabled", () => {
		const { service } = fixture();
		expect(() => service.setLimit({ turns: 2 })).toThrow("Loop mode is not enabled");
	});

	test("rejects token limits and conflicting or invalid limits without mutation", () => {
		const { service } = fixture();
		expect(() => service.enable("x", { tokens: 100 })).toThrow(StudioLoopError);
		expect(() => service.enable("x", { turns: 1, minutes: 1 })).toThrow("Specify only one");
		expect(() => service.enable("x", { turns: 0 })).toThrow("positive integer");
		expect(service.state()).toBeUndefined();
	});

	test("defers while blocked and submits after the next idle retry", async () => {
		const f = fixture();
		f.service.enable("repeat");
		f.setBlocked(true);
		f.service.scheduleNext();
		await f.runNext();
		expect(f.submitted).toEqual([]);
		expect(f.timers.size).toBe(1);
		f.setBlocked(false);
		await f.runNext();
		expect(f.submitted).toEqual(["repeat"]);
	});

	test("runs compact/reset actions and fails closed on reset during vibe", async () => {
		const compact = fixture("compact");
		compact.service.enable("repeat");
		compact.service.scheduleNext();
		await compact.runNext();
		expect(compact.counts()).toEqual({ compacted: 1, reset: 0 });

		const reset = fixture("reset");
		reset.setVibe(true);
		reset.service.enable("repeat");
		reset.service.scheduleNext();
		await reset.runNext();
		expect(reset.submitted).toEqual([]);
		expect(reset.service.state()).toBeUndefined();
		expect(reset.errors[0]).toBeInstanceOf(StudioLoopError);
	});

	test("dispose cancels timers and prevents later use", async () => {
		const f = fixture();
		f.service.enable("repeat");
		f.service.scheduleNext();
		expect(f.timers.size).toBe(1);
		f.service.dispose();
		expect(f.timers.size).toBe(0);
		expect(await f.runNext()).toBe(false);
		expect(() => f.service.enable("again")).toThrow("disposed");
	});

	test("listeners receive isolated transition snapshots", () => {
		const { service } = fixture();
		const states: unknown[] = [];
		service.onChange(state => states.push(state));
		service.enable();
		service.capturePrompt("repeat");
		service.pause();
		service.disable();
		expect(states).toEqual([
			{ status: "waiting" },
			{ status: "running", prompt: "repeat" },
			{ status: "paused" },
			undefined,
		]);
	});
});
