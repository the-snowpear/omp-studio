import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioNativePreferencesService } from "../src/studio/services/native-preferences-service";
import { validateNativePreferenceResult } from "../src/studio/native-preferences-protocol";
test("native preferences preserve overlay precedence and distinguish next-launch OTLP configuration from effective state", async () => {
	const settings = Settings.isolated();
	const service = new StudioNativePreferencesService({ sessionId: "s", settings } as AgentSession);
	const set = (
		key: "title.icons" | "telemetry.otlpExportEnabled",
		value: string | boolean,
		scope: "session" | "global",
	) => service.execute({ kind: "preferences.native.set", sessionId: "s", key, value, scope });
	await set("title.icons", "boring", "global");
	await set("title.icons", "emoji", "session");
	const shadowed = await set("title.icons", "nf+emoji", "global");
	expect(shadowed).toMatchObject({ value: "emoji", effective: "emoji", source: "runtime" });
	validateNativePreferenceResult("preferences.native.set", shadowed);
	expect(
		await service.execute({ kind: "preferences.native.clearOverride", sessionId: "s", key: "title.icons" }),
	).toMatchObject({ value: "nf+emoji", source: "global" });
	expect(await set("telemetry.otlpExportEnabled", false, "global")).toMatchObject({
		value: false,
		effective: true,
		restartRequired: true,
	});
	await expect(set("telemetry.otlpExportEnabled", true, "session")).rejects.toThrow("next launch");
	await expect(set("title.icons", "invalid", "global")).rejects.toThrow();
	await expect(service.execute({ kind: "preferences.native.get", sessionId: "old" })).rejects.toThrow("changed");
});
