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
		await Promise.resolve();
		await Promise.resolve();
		return true;
	};
	return {
		service: new StudioLoopService(port, 0),
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
