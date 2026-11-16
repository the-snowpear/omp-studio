import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentStorage } from "../src/session/agent-storage";
import {
	validateFeatureSettingsOperation,
	type FeatureSettingRow,
	type FeatureSettingsOperation,
} from "../src/studio/feature-settings-protocol";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { hasNativeJudge } from "../src/judgment";
import type { AgentSession } from "../src/session/agent-session";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";
import { StudioFeatureSettingsService } from "../src/studio/services/feature-settings-service";
import type { FeatureSettingKey, FeatureSettingValue } from "../src/studio/feature-settings-protocol";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { standaloneFindSpotlight } from "../src/spotlight/session";

const auths: Array<{ close(): void }> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const auth of auths.splice(0)) auth.close();
});
function featureSettings() {
	const settings = Settings.isolated();
	const service = new StudioFeatureSettingsService({ sessionId: "settings", settings } as AgentSession);
	return {
		settings,
		service,
		set: (key: FeatureSettingKey, value: FeatureSettingValue, scope: "session" | "global" = "session") =>
			service.execute({ kind: "preferences.features.set", sessionId: "settings", key, value, scope }),
		clear: (key: FeatureSettingKey) =>
			service.execute({ kind: "preferences.features.clearOverride", sessionId: "settings", key }),
	};
}

test("auxiliary provider settings restrict foreign native judges while retaining the active provider", async () => {
	const f = featureSettings();
	const auth = createInMemoryAuthStorage();
	auths.push(auth);
	const registry = new ModelRegistry(auth, "/nonexistent/studio-policy-models.yml");
	const judge = {
		id: "jev-preview",
		name: "Judge",
		api: "typesafe",
		provider: "typesafe",
		kind: "judge",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<Api>;
	vi.spyOn(registry, "getAvailable").mockReturnValue([judge]);
	vi.spyOn(registry, "getAll").mockReturnValue([judge]);
	f.settings.setModelRole("judge", "typesafe/jev-preview");
	expect(hasNativeJudge(f.settings, registry, { ...judge, provider: "foreign" })).toBe(true);
	await f.set("models.noJudge", true);
	expect(hasNativeJudge(f.settings, registry, { ...judge, provider: "foreign" })).toBe(false);
	expect(hasNativeJudge(f.settings, registry, judge)).toBe(true);
	await f.set("models.noJudge", false, "global");
	expect(hasNativeJudge(f.settings, registry, { ...judge, provider: "foreign" })).toBe(false);
	await f.clear("models.noJudge");
	expect(hasNativeJudge(f.settings, registry, { ...judge, provider: "foreign" })).toBe(true);
	await f.set("spotlight.experiment.enabled", true);
	expect(standaloneFindSpotlight(f.settings)).toBeDefined();
	await f.set("models.noSpotlight", true);
	expect(standaloneFindSpotlight(f.settings)).toBeUndefined();
	await f.set("models.noSpotlight", false);
	await f.set("models.offline", true);
	expect(standaloneFindSpotlight(f.settings)).toBeUndefined();
	expect(hasNativeJudge(f.settings, registry, judge)).toBe(true);
	expect(hasNativeJudge(f.settings, registry)).toBe(false);
});

test("Bash environment grants use the native approval rules and clear back to inherited policy", async () => {
	const f = featureSettings();
	vi.spyOn(f.settings, "getShellConfig").mockReturnValue({
		shell: "/bin/bash",
		args: ["-c"],
		env: {},
		prefix: undefined,
	});
	const bash = new BashTool({ settings: f.settings } as ToolSession);
	if (typeof bash.approval !== "function") throw new Error("Expected native dynamic Bash approval");
	await f.set("bash.patterns", [{ match: "cargo test*", approval: "allow", env: ["RUSTFLAGS"] }]);
	expect(bash.approval({ command: "CI=1 cargo test" })).toBe("exec");
	await f.set("bash.allowedEnvVars", ["CI"]);
	expect(bash.approval({ command: "CI=1 cargo test" })).toMatchObject({ policy: "allow" });
	expect(bash.approval({ command: "RUSTFLAGS=-Dwarnings cargo test" })).toMatchObject({ policy: "allow" });
	expect(bash.approval({ command: "LD_PRELOAD=other.so cargo test" })).toBe("exec");
	await f.clear("bash.allowedEnvVars");
	expect(bash.approval({ command: "CI=1 cargo test" })).toBe("exec");
});

test("advanced settings preserve session precedence and native invalid thresholds leave the previous value", async () => {
	const f = featureSettings();
	await f.set("find.hitThreshold", 0.7, "global");
	await f.set("find.hitThreshold", 0.8);
	await expect(f.set("find.hitThreshold", 2)).rejects.toThrow("find.hitThreshold");
	expect(await f.clear("find.hitThreshold")).toMatchObject({ value: 0.7, source: "global" });
	await f.set("find.verifyModel", "typesafe/jev-preview", "global");
	await f.set("encourageEdits", false);
	await f.set("commit.enabled", false);
	await f.set("todo.midRunNudges", "backoff");
	await f.set("shellPath", "/isolated/bin/bash");
	await f.set("ttsr.repeatMode", "after-gap", "global");
	await f.set("ttsr.repeatMode", "once");
	expect(await f.clear("ttsr.repeatMode")).toMatchObject({ value: "after-gap", source: "global" });
	expect(await f.clear("commit.enabled")).toMatchObject({ value: true, source: "default" });
	const saved = f.settings.getGlobalSettings();
	expect(saved).toMatchObject({
		find: { hitThreshold: 0.7, verifyModel: "typesafe/jev-preview" },
		ttsr: { repeatMode: "after-gap" },
	});
	expect(saved).not.toHaveProperty("shellPath");
});

test("editing authored Bash rules never promotes project or path-scoped grants to another project", async () => {
	const dir = TempDir.createSync("@studio-feature-layers-");
	const agentDir = dir.join("agent");
	const projectA = dir.join("a");
	const projectB = dir.join("b");
	const globalRule = { match: "scope-status*", approval: "allow" };
	const scoped = { path: projectA, patterns: [{ match: "scope-path-only*", approval: "allow", env: ["CI"] }] };
	const globals = [globalRule, scoped, { match: "*", approval: "prompt" }];
	try {
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(dir.join("a", ".omp"), { recursive: true });
		await fs.mkdir(projectB, { recursive: true });
		await Bun.write(dir.join("agent", "config.yml"), JSON.stringify({ bash: { patterns: globals } }));
		await Bun.write(
			dir.join("a", ".omp", "config.yml"),
			JSON.stringify({ bash: { patterns: [{ match: "scope-project-only*", approval: "allow" }] } }),
		);
		const settings = await Settings.loadIsolated({ cwd: projectA, agentDir });
		const service = new StudioFeatureSettingsService({ sessionId: "settings", settings } as AgentSession);
		const result = (await service.execute({ kind: "preferences.features.get", sessionId: "settings" })) as {
			settings: FeatureSettingRow[];
		};
		const row = result.settings.find(item => item.key === "bash.patterns")!;
		expect(row.value).toContainEqual({ match: "scope-project-only*", approval: "allow" });
		expect(row.editableValues!.global).toEqual(globals);
		const authored = row.editableValues!.global as FeatureSettingValue[];
		const change: FeatureSettingsOperation = {
			kind: "preferences.features.set",
			sessionId: "settings",
			key: "bash.patterns",
			scope: "global",
			value: [{ ...globalRule, approval: "prompt" }, ...authored.slice(1)],
		};
		validateFeatureSettingsOperation(change);
		await service.execute(change);
		const other = await Settings.loadIsolated({ cwd: projectB, agentDir });
		vi.spyOn(other, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-c"],
			env: {},
			prefix: undefined,
		});
		const bash = new BashTool({ settings: other } as ToolSession);
		if (typeof bash.approval !== "function") throw new Error("Expected native dynamic Bash approval");
		expect(bash.approval({ command: "scope-project-only" })).toMatchObject({ policy: "prompt" });
		expect(bash.approval({ command: "scope-path-only" })).toMatchObject({ policy: "prompt" });
		expect(other.getGlobalSettings()).toMatchObject({
			bash: { patterns: [{ ...globalRule, approval: "prompt" }, scoped, { match: "*", approval: "prompt" }] },
		});
		const overridden = (await service.execute({
			kind: "preferences.features.set",
			sessionId: "settings",
			key: "bash.patterns",
			scope: "session",
			value: [{ match: "temporary*", approval: "deny" }],
		})) as FeatureSettingRow;
		expect(overridden.editableValues!.session).toEqual([{ match: "temporary*", approval: "deny" }]);
		const cleared = (await service.execute({
			kind: "preferences.features.clearOverride",
			sessionId: "settings",
			key: "bash.patterns",
		})) as FeatureSettingRow;
		expect(cleared.editableValues!.session).toBeNull();
		expect(cleared.value).toContainEqual({ match: "scope-project-only*", approval: "allow" });
	} finally {
		AgentStorage.close();
		await dir.remove();
	}
});
