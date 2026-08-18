import { describe, expect, test } from "bun:test";
import type { StudioRequest } from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import {
	StudioRuntimeCommandArbiter,
	StudioRuntimeCommandError,
} from "@oh-my-pi/pi-coding-agent/studio/command-arbiter";

const request = (operation: StudioRequest["operation"], requestId: string): StudioRequest => ({
	type: "studio.request",
	requestId,
	runtimeEpoch: 7,
	operation,
});

describe("WP-014 Runtime command arbiter", () => {
	test("allows only one GUI/TUI process-exclusive command into the service", async () => {
		const arbiter = new StudioRuntimeCommandArbiter(() => ({
			runtimeEpoch: 7,
			stateVersion: 0,
			isStreaming: true,
			isCompacting: false,
		}));
		let executions = 0;
		const held = Promise.withResolvers<void>();
		const gui = arbiter.run(request({ kind: "runtime.pause" }, "gui-pause"), "command-gui", "gui", async () => {
			executions += 1;
			await held.promise;
		});
		expect(arbiter.currentLease()).toMatchObject({ holder: "gui", generation: 1, commandId: "command-gui" });
		await expect(
			arbiter.run(
				request({ kind: "runtime.resume", expectedPauseEpoch: 1 }, "tui-resume"),
				"command-tui",
				"tui",
				() => {
					executions += 1;
				},
			),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(executions).toBe(1);
		held.resolve();
		await gui;
		expect(arbiter.currentLease()).toBeUndefined();
	});

	test("fences interaction transfer by owner and generation", () => {
		const arbiter = new StudioRuntimeCommandArbiter(() => ({
			runtimeEpoch: 7,
			stateVersion: 0,
			isStreaming: false,
			isCompacting: false,
		}));
		const opened = arbiter.openInteraction("command-one", "gui");
		expect(() => arbiter.transferInteraction(opened.interactionId, "tui", "gui")).toThrow(StudioRuntimeCommandError);
		const transferred = arbiter.transferInteraction(opened.interactionId, "gui", "tui");
		expect(transferred).toMatchObject({ owner: "tui", generation: 2 });
		expect(() => arbiter.completeInteraction(opened.interactionId, "command-one", "tui", 1)).toThrow(
			StudioRuntimeCommandError,
		);
		arbiter.completeInteraction(opened.interactionId, "command-one", "tui", 2);
		expect(() => arbiter.completeInteraction(opened.interactionId, "command-one", "tui", 2)).toThrow(
			StudioRuntimeCommandError,
		);
	});

	test("lets core.abort interrupt a prompt that still holds the exclusive lease", async () => {
		const arbiter = new StudioRuntimeCommandArbiter(
			() => ({
				runtimeEpoch: 7,
				stateVersion: 4,
				isStreaming: true,
				isCompacting: false,
			}),
			["core.prompt", "core.abort", "core.followUp"],
		);
		const held = Promise.withResolvers<void>();
		let abortRan = false;
		const prompt = arbiter.run(
			request({ kind: "core.prompt", text: "hi" }, "prompt-1"),
			"command-prompt",
			"gui",
			async () => {
				await held.promise;
			},
		);
		expect(arbiter.currentLease()).toMatchObject({ holder: "gui", commandId: "command-prompt" });
		await arbiter.run(request({ kind: "core.abort" }, "abort-1"), "command-abort", "gui", () => {
			abortRan = true;
		});
		expect(abortRan).toBe(true);
		expect(arbiter.currentLease()).toMatchObject({ commandId: "command-prompt" });
		await arbiter.run(
			{ ...request({ kind: "core.followUp", text: "nudge" }, "follow-1"), expectedStateVersion: 1 },
			"command-follow",
			"gui",
			() => {},
		);
		held.resolve();
		await prompt;
		expect(arbiter.currentLease()).toBeUndefined();
	});

	test("still serializes a second exclusive command while prompt holds the lease", async () => {
		const arbiter = new StudioRuntimeCommandArbiter(
			() => ({
				runtimeEpoch: 7,
				stateVersion: 0,
				isStreaming: true,
				isCompacting: false,
			}),
			["core.prompt", "runtime.pause"],
		);
		const held = Promise.withResolvers<void>();
		const prompt = arbiter.run(
			request({ kind: "core.prompt", text: "hi" }, "prompt-1"),
			"command-prompt",
			"gui",
			async () => {
				await held.promise;
			},
		);
		await expect(
			arbiter.run(request({ kind: "runtime.pause" }, "pause-1"), "command-pause", "gui", () => {}),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		held.resolve();
		await prompt;
	});

	test("lets session.model.set run while prompt holds the exclusive lease and while compacting", async () => {
		const arbiter = new StudioRuntimeCommandArbiter(
			() => ({
				runtimeEpoch: 7,
				stateVersion: 4,
				isStreaming: true,
				isCompacting: false,
			}),
			["core.prompt", "session.model.set", "session.thinking.set", "mode.plan.enter", "permissions.mode.set"],
		);
		const held = Promise.withResolvers<void>();
		let modelSet = false;
		const prompt = arbiter.run(
			request({ kind: "core.prompt", text: "hi" }, "prompt-1"),
			"command-prompt",
			"gui",
			async () => {
				await held.promise;
			},
		);
		await arbiter.run(
			request({ kind: "session.model.set", selector: "anthropic/claude-opus-4-6" }, "model-1"),
			"command-model",
			"gui",
			() => {
				modelSet = true;
			},
		);
		expect(modelSet).toBe(true);
		let planEntered = false;
		await arbiter.run(request({ kind: "mode.plan.enter" }, "plan-1"), "command-plan", "gui", () => {
			planEntered = true;
		});
		expect(planEntered).toBe(true);
		let approvalSet = false;
		await arbiter.run(
			request({ kind: "permissions.mode.set", mode: "write", persist: true }, "perm-1"),
			"command-perm",
			"gui",
			() => {
				approvalSet = true;
			},
		);
		expect(approvalSet).toBe(true);
		held.resolve();
		await prompt;

		const compacting = new StudioRuntimeCommandArbiter(
			() => ({
				runtimeEpoch: 7,
				stateVersion: 4,
				isStreaming: false,
				isCompacting: true,
			}),
			["session.thinking.set", "runtime.pause", "mode.plan.enter", "permissions.mode.set"],
		);
		await compacting.run(
			request({ kind: "session.thinking.set", level: "high" }, "think-1"),
			"command-think",
			"gui",
			() => {},
		);
		await compacting.run(request({ kind: "mode.plan.enter" }, "plan-1"), "command-plan", "gui", () => {});
		await compacting.run(
			request({ kind: "permissions.mode.set", mode: "always-ask", persist: false }, "perm-2"),
			"command-perm-compact",
			"gui",
			() => {},
		);
		await expect(
			compacting.run(request({ kind: "runtime.pause" }, "pause-1"), "command-pause", "gui", () => {}),
		).rejects.toMatchObject({ code: "BUSY_COMPACTING" });
	});

	test("lets permissions.mode.set run while an interaction is open", async () => {
		const arbiter = new StudioRuntimeCommandArbiter(
			() => ({
				runtimeEpoch: 7,
				stateVersion: 4,
				isStreaming: false,
				isCompacting: false,
			}),
			["permissions.mode.set", "runtime.pause"],
		);
		arbiter.openInteraction("command-ask", "gui");
		let approvalSet = false;
		await arbiter.run(
			request({ kind: "permissions.mode.set", mode: "write", persist: true }, "perm-ask"),
			"command-perm-ask",
			"gui",
			() => {
				approvalSet = true;
			},
		);
		expect(approvalSet).toBe(true);
		await expect(
			arbiter.run(request({ kind: "runtime.pause" }, "pause-ask"), "command-pause-ask", "gui", () => {}),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	});
});
