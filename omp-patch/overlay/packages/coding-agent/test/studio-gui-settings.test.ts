import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioRuntimeSettingsService } from "../src/studio/services/runtime-settings-service";
import { GUI_SETTING_DEFINITIONS, GUI_SETTING_KEYS } from "../src/studio/gui-settings-protocol";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AgentSession as LiveAgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage } from "../src/session/auth-storage";
import { AgentStorage } from "../src/session/agent-storage";
import { convertToLlm } from "../src/session/messages";
import { cfgCompaction } from "../src/session/context-settings";
import { cfgEditFuzzyMatch, cfgEditFuzzyThreshold } from "../src/edit/settings";
import { cfgLspDiagnosticsOnEdit } from "../src/lsp/settings";
import { cfgTaskMaxConcurrency, cfgTaskMaxRecursionDepth } from "../src/task/settings";
import { cfgRetryEnabled, cfgModelToolCallLoopGuardThreshold } from "../src/session/settings";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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

test("GUI settings change live queue handling and native consumers", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-settings-live-"));
	let session: LiveAgentSession | undefined;
	let auth: AuthStorage | undefined;
	try {
		const settings = Settings.isolated();
		const agent = new Agent();
		auth = await AuthStorage.create(path.join(dir, "auth.db"));
		session = new LiveAgentSession({
			agent,
			settings,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(auth, path.join(dir, "models.yml")),
		});
		const service = new StudioRuntimeSettingsService(session);
		await service.set("steeringMode", "all", false);
		await service.set("followUpMode", "all", false);
		await service.set("interruptMode", "wait", false);
		await Promise.resolve();
		expect(agent.getSteeringMode()).toBe("all");
		expect(agent.getFollowUpMode()).toBe("all");
		expect(agent.getInterruptMode()).toBe("wait");
		await service.set("compaction.enabled", false, false);
		await service.set("compaction.thresholdPercent", 75, false);
		expect(cfgCompaction.get(settings)).toMatchObject({ enabled: false, thresholdPercent: 75 });
		expect(session.autoCompactionEnabled).toBe(false);
		await service.set("edit.fuzzyMatch", false, false);
		await service.set("edit.fuzzyThreshold", 0.9, false);
		await service.set("lsp.diagnosticsOnEdit", true, false);
		expect([
			cfgEditFuzzyMatch.get(settings),
			cfgEditFuzzyThreshold.get(settings),
			cfgLspDiagnosticsOnEdit.get(settings),
		]).toEqual([false, 0.9, true]);
		await service.set("task.maxConcurrency", 4, false);
		await service.set("task.maxRecursionDepth", -1, false);
		await service.set("retry.enabled", false, false);
		expect(session.autoRetryEnabled).toBe(false);
		await service.set("model.toolCallLoopGuard.threshold", 8, false);
		expect([
			cfgTaskMaxConcurrency.get(settings),
			cfgTaskMaxRecursionDepth.get(settings),
			cfgRetryEnabled.get(settings),
			cfgModelToolCallLoopGuardThreshold.get(settings),
		]).toEqual([4, -1, false, 8]);
	} finally {
		await session?.dispose();
		auth?.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("global writes persist while a session override remains in force", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-settings-persist-"));
	let settings: Settings | undefined;
	try {
		settings = await Settings.loadIsolated({ agentDir: dir, cwd: dir });
		const service = new StudioRuntimeSettingsService({ settings } as AgentSession);
		await service.set("steeringMode", "all", false);
		await service.set("steeringMode", "one-at-a-time", true);
		expect(service.snapshot().steeringMode).toBe("all");
		expect(service.activation().sources?.steeringMode).toBe("runtime");
		const reloaded = await Settings.loadReadOnly({ agentDir: dir, cwd: dir });
		expect(new StudioRuntimeSettingsService({ settings: reloaded } as AgentSession).snapshot().steeringMode).toBe(
			"one-at-a-time",
		);
	} finally {
		AgentStorage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

for (const [mode, expectedCalls] of [
	["all", 2],
	["one-at-a-time", 3],
] as const) {
	test(`follow-up messages use the ${mode} policy configured through Studio`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-settings-queue-"));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		auth.keys.setRuntime("anthropic", "test-only");
		const mock = createMockModel({
			responses: [{ content: ["initial"] }, { content: ["first"] }, { content: ["second"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-only",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: [], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = new LiveAgentSession({
			agent,
			settings: Settings.isolated({ "compaction.enabled": false }),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(auth, path.join(dir, "models.yml")),
		});
		try {
			await new StudioRuntimeSettingsService(session).set("followUpMode", mode, false);
			await Promise.resolve();
			let queued = false;
			agent.setOnBeforeYield(async () => {
				if (queued) return;
				queued = true;
				await session.followUp("first queued message");
				await session.followUp("second queued message");
			});
			await session.prompt("start");
			await session.waitForIdle();
			expect(mock.calls).toHaveLength(expectedCalls);
			const next = JSON.stringify(mock.calls[1]!.context.messages);
			expect(next).toContain("first queued message");
			expect(next.includes("second queued message")).toBe(mode === "all");
		} finally {
			await session.dispose();
			auth.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
}
