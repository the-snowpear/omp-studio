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
	} = {},
) {
	const sonnet = model("claude-sonnet-4-5");
	const opus = model("claude-opus-4-6");
	let current: Model | undefined = "current" in overrides ? overrides.current : sonnet;
	let thinking: string | undefined = "medium";
	let configured: string | undefined = "medium";
	const available = overrides.available ?? [sonnet, opus, model("gpt-5-mini", "openai")];
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
	} as unknown as AgentSession;
	return {
		service: new StudioModelControlService(session),
		getCurrent: () => current,
		getConfigured: () => configured,
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
});
