import { expect, mock, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import { cfgCompactionModelThresholds } from "../src/session/context-settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioFeatureSettingsService } from "../src/studio/services/feature-settings-service";

const model = {
	provider: "openai",
	id: "gpt-5.6-terra",
	contextWindow: 272_000,
	cost: { longContext: { inputThreshold: 272_000 } },
} as Model;
const tiers = { standard: 272_000, extended: 1_050_000 };

function service(settings: Settings, reapplyModelPolicies = mock(async () => {})) {
	return new StudioFeatureSettingsService({
		sessionId: "main",
		settings,
		modelRegistry: { find: () => model, contextWindowTiers: () => tiers, reapplyModelPolicies },
	} as unknown as AgentSession);
}

test("model compaction uses the native preview and confirmation, and completes only after model policies refresh", async () => {
	const settings = Settings.isolated({ extendedContext: false });
	const entered = Promise.withResolvers<void>(),
		refreshed = Promise.withResolvers<void>();
	const reapply = mock(async () => {
		entered.resolve();
		await refreshed.promise;
	});
	const bridge = service(settings, reapply);
	const operation = { sessionId: "main", selector: "openai/gpt-5.6-terra", input: "400k" };
	expect(await bridge.execute({ kind: "models.compaction.preview", ...operation })).toMatchObject({
		valid: true,
		window: 1_050_000,
		trigger: 340_000,
		extended: true,
	});
	expect(await bridge.execute({ kind: "models.compaction.set", ...operation })).toMatchObject({
		saved: false,
		confirmationRequired: true,
		summary: expect.stringContaining("costs more"),
	});
	expect(cfgCompactionModelThresholds.get(settings)).toEqual({});
	expect(reapply).not.toHaveBeenCalled();
	let complete = false;
	const saving = bridge.execute({ kind: "models.compaction.set", ...operation, confirmed: true }).then(result => {
		complete = true;
		return result;
	});
	await entered.promise;
	expect(complete).toBe(false);
	refreshed.resolve();
	expect(await saving).toMatchObject({ saved: true, confirmationRequired: false });
	expect(cfgCompactionModelThresholds.get(settings)).toEqual({ "openai/gpt-5.6-terra": 400_000 });
	expect(reapply).toHaveBeenCalledTimes(1);
});

test("clearing a model threshold restores the native matching prefix without replacing other model entries", async () => {
	const settings = Settings.isolated({ extendedContext: false });
	cfgCompactionModelThresholds.set(settings, { "openai/*": "f100000", "openai/gpt-5.6-terra": 400_000 });
	const reapply = mock(async () => {}),
		bridge = service(settings, reapply);
	const operation = { sessionId: "main", selector: "openai/gpt-5.6-terra", input: "" };
	expect(await bridge.execute({ kind: "models.compaction.preview", ...operation })).toMatchObject({
		valid: true,
		trigger: 100_000,
		window: 272_000,
	});
	expect(await bridge.execute({ kind: "models.compaction.set", ...operation })).toMatchObject({
		saved: true,
		confirmationRequired: false,
	});
	expect(cfgCompactionModelThresholds.get(settings)).toEqual({ "openai/*": "f100000" });
	expect(reapply).toHaveBeenCalledTimes(1);
});
