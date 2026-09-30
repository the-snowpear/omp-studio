import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioRuntimeSettingsService } from "../src/studio/services/runtime-settings-service";
import { GUI_SETTING_DEFINITIONS, GUI_SETTING_KEYS } from "../src/studio/gui-settings-protocol";

test("GUI preview defaults agree with isolated native settings", () => {
	const settings = Settings.isolated();
	const service = new StudioRuntimeSettingsService({ settings } as AgentSession);
	const values = service.snapshot();
	expect(GUI_SETTING_KEYS.map(key => ({ key, value: values[key] }))).toEqual(
		GUI_SETTING_KEYS.map(key => ({ key, value: GUI_SETTING_DEFINITIONS[key].default })),
	);
});
test("GUI settings report session override provenance and reject invalid thresholds", async () => {
	const settings = Settings.isolated();
	const service = new StudioRuntimeSettingsService({ settings } as AgentSession);
	await service.set("providers.cacheWarming", "off", false);
	expect(service.snapshot()["providers.cacheWarming"]).toBe("off");
	expect(service.activation().sources?.["providers.cacheWarming"]).toBe("runtime");
	expect(
		await service
			.set("task.agentCompactionThresholdOverrides", { reviewer: "101%" }, false)
			.catch(error => error.code),
	).toBe("INVALID_ARGUMENT");
});
