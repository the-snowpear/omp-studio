import { expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { cfgProvidersCacheWarming } from "../src/session/settings";
import { StudioSessionOptionsService } from "../src/studio/services/session-options-service";
import { applyStudioDefaults } from "../src/studio/settings-defaults";
import { validateWorkbenchOperation, validateWorkbenchResult } from "../src/studio/workbench-protocol";

test("speed changes reject stale model identities and an unadvertised Ultrafast tier before changing settings", async () => {
	const model = {
		...getBundledModel("openai", "gpt-4o-mini")!,
		provider: "openai-codex",
		api: "openai-codex-responses",
		serviceTiers: ["priority"],
	};
	let changes = 0;
	const session = {
		sessionId: "s",
		model,
		settings: Settings.isolated(),
		isSlowModeSupported: () => true,
		getSlowModeScope: () => "session",
		getUsageLimitState: () => undefined,
		isSlowModeEnabled: () => false,
		isFastModeEnabled: () => false,
		isFastModeActive: () => false,
		isUltrafastModeEnabled: () => false,
		effectiveServiceTier: () => undefined,
		setFastMode: () => {
			changes++;
			return true;
		},
		setUltrafastMode: () => {
			changes++;
			return true;
		},
	} as unknown as AgentSession;
	const service = new StudioSessionOptionsService(session);
	const state = service.speed();
	expect(state.supported).toEqual(["normal", "fast", "slow"]);
	await expect(
		service.execute({ kind: "session.speed.set", sessionId: "s", expectedModel: "old/model", speed: "fast" }),
	).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	await expect(
		service.execute({ kind: "session.speed.set", sessionId: "s", expectedModel: state.model!, speed: "ultrafast" }),
	).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	expect(changes).toBe(0);
	validateWorkbenchResult("session.speed.get", state);
});

test("cache warming uses native soft defaults, runtime overrides and persisted writes with effective provenance", async () => {
	const settings = Settings.isolated();
	applyStudioDefaults(settings);
	const service = new StudioSessionOptionsService({ sessionId: "s", settings } as AgentSession);
	await service.execute({ kind: "session.warming.set", sessionId: "s", mode: "streaming", persist: false });
	expect(settings.getGlobalSettings()).not.toHaveProperty("providers.cacheWarming");
	await service.execute({ kind: "session.warming.set", sessionId: "s", mode: "idle", persist: true });
	expect(cfgProvidersCacheWarming.get(settings)).toBe("idle");
	expect(service.warming()).toMatchObject({ source: "global", mode: "idle", state: "unavailable" });
	validateWorkbenchResult("session.warming.get", service.warming());
});

test("unavailable preset leaves roles and current model intact and preset writes preserve other entries", async () => {
	const model = getBundledModel("openai", "gpt-4o-mini")!;
	const settings = Settings.isolated({
		modelRoles: { default: "openai/gpt-4o-mini" },
		modelPresets: { missing: { modelRoles: { default: "gone/model" } } },
	});
	let changes = 0;
	const session = {
		sessionId: "s",
		settings,
		model,
		scopedModels: [],
		getAvailableModels: () => [model],
		modelRegistry: { hasConfiguredAuth: () => true },
		setModel: async () => {
			changes++;
		},
	} as unknown as AgentSession;
	const service = new StudioSessionOptionsService(session);
	const result = await service.execute({ kind: "models.presets.apply", sessionId: "s", name: "missing" });
	expect(result).toMatchObject({ outcome: "unavailable" });
	expect(changes).toBe(0);
	expect(settings.getModelRole("default")).toBe("openai/gpt-4o-mini");
	await service.execute({ kind: "models.presets.save", sessionId: "s", name: "current" });
	await service.execute({ kind: "models.presets.delete", sessionId: "s", name: "current" });
	expect(await service.execute({ kind: "models.presets.list", sessionId: "s" })).toMatchObject({
		presets: [{ name: "missing" }],
	});
	validateWorkbenchOperation({ kind: "models.presets.apply", sessionId: "s", name: "missing" });
	validateWorkbenchResult("models.presets.apply", result);
	expect(() =>
		validateWorkbenchOperation({
			kind: "session.speed.set",
			sessionId: "s",
			expectedModel: "x",
			speed: "fast",
			arbitrary: true,
		}),
	).toThrow();
});
