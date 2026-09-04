import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { parseStudioRequest, StudioFrameError } from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import {
	StudioModelControlError,
	StudioModelControlService,
} from "@oh-my-pi/pi-coding-agent/studio/services/model-control-service";

function model(id: string, provider = "anthropic"): Model {
	return { id, provider } as Model;
}

function fixture(
	overrides: {
		streaming?: boolean;
		compacting?: boolean;
		current?: Model;
		available?: Model[];
		setModelError?: Error;
		onRefresh?: (strategy?: string) => void | Promise<void>;
		taskOverrides?: Record<string, string | string[]>;
	} = {},
) {
	const sonnet = model("claude-sonnet-4-5");
	const opus = model("claude-opus-4-6");
	let current: Model | undefined = "current" in overrides ? overrides.current : sonnet;
	let thinking: string | undefined = "medium";
	let configured: string | undefined = "medium";
	let available = overrides.available ?? [sonnet, opus, model("gpt-5-mini", "openai")];
	const taskOverrides: Record<string, string | string[]> = { ...(overrides.taskOverrides ?? {}) };
	const settings = {
		get: (path: string) => (path === "task.agentModelOverrides" ? { ...taskOverrides } : undefined),
		override: (path: string, value: Record<string, string | string[]>) => {
			if (path !== "task.agentModelOverrides") throw new Error(`unexpected override path: ${path}`);
			for (const key of Object.keys(taskOverrides)) delete taskOverrides[key];
			Object.assign(taskOverrides, value);
		},
	};
	const session = {
		get model() {
			return current;
		},
		get thinkingLevel() {
			return thinking;
		},
		configuredThinkingLevel: () => configured,
		get isStreaming() {
			return overrides.streaming === true;
		},
		get isCompacting() {
			return overrides.compacting === true;
		},
		getAvailableModels: () => available,
		modelRegistry: {
			refresh: async (strategy?: string) => {
				if (overrides.onRefresh) await overrides.onRefresh(strategy);
			},
		},
		async setModel(next: Model) {
			if (overrides.setModelError) throw overrides.setModelError;
			current = next;
			thinking = "low";
			configured = "low";
		},
		setThinkingLevel(level: string) {
			configured = level;
			thinking = level === "auto" ? "medium" : level === "off" ? undefined : level;
		},
		settings,
	} as unknown as AgentSession;
	return {
		service: new StudioModelControlService(session),
		getCurrent: () => current,
		getConfigured: () => configured,
		setAvailable: (next: Model[]) => {
			available = next;
		},
		taskOverrides,
	};
}

describe("StudioModelControlService", () => {
	test("projects the live session model without credentials", () => {
		const { service } = fixture();
		expect(service.state()).toEqual({
			selector: "anthropic/claude-sonnet-4-5",
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			thinking: "medium",
			configuredThinking: "medium",
		});
	});

	test("switches by provider/id and optionally pins thinking after setModel", async () => {
		const { service, getCurrent } = fixture();
		expect(await service.setModel("anthropic/claude-opus-4-6")).toMatchObject({
			selector: "anthropic/claude-opus-4-6",
			thinking: "low",
		});
		expect(getCurrent()?.id).toBe("claude-opus-4-6");
		expect(await service.setModel("gpt-5-mini", "high")).toMatchObject({
			selector: "openai/gpt-5-mini",
			thinking: "high",
			configuredThinking: "high",
		});
	});

	test("rejects unknown selectors, inherit, and empty input", async () => {
		const { service } = fixture();
		await expect(service.setModel("missing/model")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await expect(service.setModel("")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		expect(() => service.setThinking("inherit")).toThrow(StudioModelControlError);
		try {
			service.setThinking("inherit");
		} catch (error) {
			expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
		}
	});

	test("queues setModel while streaming and applies it later without touching the live session yet", async () => {
		const { service, getCurrent } = fixture({ streaming: true });
		expect(await service.setModel("anthropic/claude-opus-4-6")).toMatchObject({
			selector: "anthropic/claude-opus-4-6",
		});
		expect(getCurrent()?.id).toBe("claude-sonnet-4-5");
		await service.applyPending();
		expect(getCurrent()?.id).toBe("claude-opus-4-6");
	});

	test("queues setThinking while compacting until applyPending", async () => {
		const { service, getConfigured } = fixture({ compacting: true });
		expect(service.setThinking("high")).toMatchObject({
			configuredThinking: "high",
			thinking: "high",
		});
		expect(getConfigured()).toBe("medium");
		await service.applyPending();
		expect(getConfigured()).toBe("high");
	});

	test("setThinking requires an active model", () => {
		const { service } = fixture({ current: undefined });
		expect(() => service.setThinking("high")).toThrow(StudioModelControlError);
		try {
			service.setThinking("high");
		} catch (error) {
			expect(error).toMatchObject({ code: "COMMAND_BLOCKED" });
		}
	});

	test("the Runtime mirror parser accepts model/thinking operations and rejects inherit", () => {
		const base = { type: "studio.request", requestId: "model-op", runtimeEpoch: 1 };
		expect(
			parseStudioRequest({
				...base,
				operation: { kind: "session.model.set", selector: "anthropic/claude-sonnet-4-5", thinking: "high" },
			}).operation.kind,
		).toBe("session.model.set");
		expect(
			parseStudioRequest({ ...base, operation: { kind: "session.thinking.set", level: "auto" } }).operation.kind,
		).toBe("session.thinking.set");
		expect(() =>
			parseStudioRequest({
				...base,
				operation: { kind: "session.model.set", selector: "anthropic/claude-sonnet-4-5", thinking: "inherit" },
			}),
		).toThrow(StudioFrameError);
		expect(() =>
			parseStudioRequest({ ...base, operation: { kind: "session.thinking.set", level: "inherit" } }),
		).toThrow(StudioFrameError);
		expect(() =>
			parseStudioRequest({ ...base, operation: { kind: "session.model.set", selector: "", thinking: "high" } }),
		).toThrow(StudioFrameError);
	});

	test("automatically refreshes modelRegistry and switches when unknown model was recently added", async () => {
		const custom = model("deepseek-chat", "deepseek");
		let refreshed: string | undefined;
		const { service, getCurrent, setAvailable } = fixture({
			available: [model("claude-sonnet-4-5")],
			onRefresh: strategy => {
				refreshed = strategy;
				setAvailable([model("claude-sonnet-4-5"), custom]);
			},
		});
		expect(await service.setModel("deepseek/deepseek-chat")).toMatchObject({
			selector: "deepseek/deepseek-chat",
			provider: "deepseek",
			id: "deepseek-chat",
		});
		expect(refreshed).toBe("offline");
		expect(getCurrent()?.id).toBe("deepseek-chat");
	});

	test("automatically refreshes and queues model while streaming", async () => {
		const custom = model("deepseek-coder", "deepseek");
		let refreshed = false;
		const { service, getCurrent, setAvailable } = fixture({
			streaming: true,
			available: [model("claude-sonnet-4-5")],
			onRefresh: () => {
				refreshed = true;
				setAvailable([model("claude-sonnet-4-5"), custom]);
			},
		});
		expect(await service.setModel("deepseek/deepseek-coder")).toMatchObject({
			selector: "deepseek/deepseek-coder",
		});
		expect(refreshed).toBe(true);
		expect(getCurrent()?.id).toBe("claude-sonnet-4-5");
		await service.applyPending();
		expect(getCurrent()?.id).toBe("deepseek-coder");
	});

	test("still uses the reloaded catalog when refresh fails after the local models.yml reload", async () => {
		const custom = model("deepseek-reasoner", "deepseek");
		const { service, getCurrent, setAvailable } = fixture({
			available: [model("claude-sonnet-4-5")],
			onRefresh: () => {
				// Simulate `ModelRegistry.refresh`: the static reload landed first,
				// then a later discovery pass threw.
				setAvailable([model("claude-sonnet-4-5"), custom]);
				throw new Error("discovery failed after local reload");
			},
		});
		expect(await service.setModel("deepseek/deepseek-reasoner")).toMatchObject({
			selector: "deepseek/deepseek-reasoner",
		});
		expect(getCurrent()?.id).toBe("deepseek-reasoner");
	});

	test("keeps rejecting unknown models when refresh does not surface the selector", async () => {
		const { service } = fixture({
			available: [model("claude-sonnet-4-5")],
			onRefresh: () => {
				throw new Error("refresh unavailable");
			},
		});
		await expect(service.setModel("deepseek/deepseek-chat")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
	});
});

describe("StudioModelControlService task subagent model", () => {
	test("taskState is absent without an override and projects the pinned model when present", () => {
		const inheriting = fixture();
		expect(inheriting.service.taskState()).toBeUndefined();

		const pinned = fixture({ taskOverrides: { task: "anthropic/claude-opus-4-6" } });
		expect(pinned.service.taskState()).toEqual({
			selector: "anthropic/claude-opus-4-6",
			provider: "anthropic",
			id: "claude-opus-4-6",
		});

		// Pattern arrays project their first member, like the TUI picker.
		const pattern = fixture({ taskOverrides: { task: ["openai/gpt-5-mini"] } });
		expect(pattern.service.taskState()).toMatchObject({ selector: "openai/gpt-5-mini" });
	});

	test("taskState stays absent when the override no longer resolves", () => {
		const { service } = fixture({ taskOverrides: { task: "missing/removed-model" } });
		expect(service.taskState()).toBeUndefined();
	});

	test("setTaskModel pins the canonical selector without touching other agent overrides", async () => {
		const { service, taskOverrides } = fixture({ taskOverrides: { reviewer: "openai/gpt-5-mini" } });
		expect(await service.setTaskModel("claude-opus-4-6")).toMatchObject({
			selector: "anthropic/claude-opus-4-6",
		});
		expect(taskOverrides.task).toBe("anthropic/claude-opus-4-6");
		expect(taskOverrides.reviewer).toBe("openai/gpt-5-mini");
	});

	test("setTaskModel(null) clears only the task entry and returns to inheritance", async () => {
		const { service, taskOverrides } = fixture({
			taskOverrides: { task: "anthropic/claude-opus-4-6", reviewer: "openai/gpt-5-mini" },
		});
		expect(await service.setTaskModel(null)).toBeUndefined();
		expect("task" in taskOverrides).toBe(false);
		expect(taskOverrides.reviewer).toBe("openai/gpt-5-mini");
	});

	test("setTaskModel rejects unknown selectors", async () => {
		const { service } = fixture();
		await expect(service.setTaskModel("missing/model")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
	});

	test("onChange fires on pin and clear", async () => {
		const { service } = fixture();
		let changes = 0;
		const unsubscribe = service.onChange(() => {
			changes += 1;
		});
		await service.setTaskModel("claude-opus-4-6");
		await service.setTaskModel(null);
		unsubscribe();
		await service.setTaskModel("claude-opus-4-6");
		expect(changes).toBe(2);
	});
});
