import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioNativePreferencesService } from "../src/studio/services/native-preferences-service";
import { cfgTitleLanguage, titleLanguageInstruction } from "../src/utils/title-settings";
import { cfgThinkLanguage, thinkingLanguageInstruction } from "../src/session/settings";
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
test("OMP 18.12 native preferences are listed in their groups and round-trip through the Runtime settings", async () => {
	const settings = Settings.isolated();
	const service = new StudioNativePreferencesService({ sessionId: "s", settings } as AgentSession);
	const listed = (await service.execute({ kind: "preferences.native.get", sessionId: "s" })) as {
		preferences: Array<{ key: string; group: string; choices?: unknown[] }>;
	};
	const byKey = new Map(listed.preferences.map(row => [row.key, row]));
	expect(byKey.get("advisor.continueSeverity")).toMatchObject({
		group: "advisor",
		choices: ["nit", "concern", "blocker"],
	});
	expect(byKey.get("lsp.requestTimeout")?.group).toBe("tools");
	expect(byKey.get("title.language")).toMatchObject({
		group: "titles",
		choices: ["auto", "zh", "en"],
		value: "auto",
	});
	expect(byKey.get("think.language")).toMatchObject({
		group: "thinking",
		choices: ["auto", "zh", "en"],
		value: "auto",
	});
	const saved = await service.execute({
		kind: "preferences.native.set",
		sessionId: "s",
		key: "sharpshooter.minPromptLength",
		value: 40,
		scope: "session",
	});
	expect(saved).toMatchObject({ value: 40, source: "runtime", group: "tools" });
	const language = await service.execute({
		kind: "preferences.native.set",
		sessionId: "s",
		key: "title.language",
		value: "zh",
		scope: "session",
	});
	expect(language).toMatchObject({ value: "zh", source: "runtime" });
	const thinking = await service.execute({
		kind: "preferences.native.set",
		sessionId: "s",
		key: "think.language",
		value: "en",
		scope: "session",
	});
	expect(thinking).toMatchObject({ value: "en", source: "runtime", group: "thinking" });
});
test("think.language resolves to exactly one thinking-language instruction", () => {
	const settings = Settings.isolated();
	expect(thinkingLanguageInstruction(settings)).toBeUndefined();
	cfgThinkLanguage.override(settings, "zh");
	expect(thinkingLanguageInstruction(settings)).toContain("Simplified Chinese");
	cfgThinkLanguage.override(settings, "en");
	expect(thinkingLanguageInstruction(settings)).toContain("English");
	cfgThinkLanguage.override(settings, "auto");
	expect(thinkingLanguageInstruction(settings)).toBeUndefined();
});
test("title.language appends exactly one language line to generated-title prompts", () => {
	const settings = Settings.isolated();
	expect(titleLanguageInstruction(settings)).toBeUndefined();
	cfgTitleLanguage.override(settings, "zh");
	expect(titleLanguageInstruction(settings)).toContain("Simplified Chinese");
	cfgTitleLanguage.override(settings, "en");
	expect(titleLanguageInstruction(settings)).toContain("English");
	cfgTitleLanguage.override(settings, "auto");
	expect(titleLanguageInstruction(settings)).toBeUndefined();
});
