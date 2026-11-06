import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../src/config/settings";
import { cfgCompactionModelThresholds } from "../src/session/context-settings";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { StudioSessionCompactionService } from "../src/studio/services/session-compaction-service";
import { resolveSessionCompactionSettings } from "../src/studio/services/session-compaction-policy";
import { formatSessionCompactionInput, parseSessionCompactionInput } from "../src/studio/session-compaction-protocol";

const managers: SessionManager[] = [],
	directories: string[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
const model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, contextWindow: 1_000_000 };
function service(manager: SessionManager, settings: Settings) {
	return new StudioSessionCompactionService({
		get sessionId() {
			return manager.getSessionId();
		},
		sessionManager: manager,
		settings,
		model,
		refreshIdleMaintenance() {},
	} as unknown as AgentSession);
}

test("smart input preserves percentage/token meaning when formatted and reopened", () => {
	for (const [input, expected] of [
		["80", { kind: "percent", value: 80 }],
		["80.5%", { kind: "percent", value: 80.5 }],
		["100", { kind: "tokens", value: 100 }],
		["150000", { kind: "tokens", value: 150000 }],
		["1.001K", { kind: "tokens", value: 1001 }],
		[".5m", { kind: "tokens", value: 500000 }],
		["0.05k", { kind: "tokens", value: 50 }],
		["  ", null],
	] as const) {
		const threshold = parseSessionCompactionInput(input);
		expect(threshold).toEqual(expected);
		expect(parseSessionCompactionInput(formatSessionCompactionInput(threshold))).toEqual(expected);
	}
});

test("conversation threshold survives reopening, wins over model settings, and never leaks into a fork", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-compaction-"));
	directories.push(directory);
	const settings = Settings.isolated({ "compaction.enabled": true });
	cfgCompactionModelThresholds.set(settings, { [`${model.provider}/${model.id}`]: "90%" });
	const manager = SessionManager.create(directory, directory);
	managers.push(manager);
	manager.appendMessage({ role: "user", content: "conversation", timestamp: Date.now() });
	const controls = service(manager, settings);
	expect(controls.get().triggerTokens).toBe(900000);
	expect((await controls.set("75")).triggerTokens).toBe(750000);
	const policy = resolveSessionCompactionSettings(settings, model, manager);
	expect(shouldCompact(749999, model.contextWindow, policy)).toBe(false);
	expect(shouldCompact(750001, model.contextWindow, policy)).toBe(true);
	const file = manager.getSessionFile()!;
	await manager.close();
	const reopened = await SessionManager.open(file);
	managers.push(reopened);
	expect(service(reopened, settings).get().threshold).toEqual({ kind: "percent", value: 75 });
	const fork = await SessionManager.forkFrom(file, directory, directory, undefined, { copyArtifacts: false });
	managers.push(fork);
	expect(service(fork, settings).get().threshold).toBeNull();
	expect(service(fork, settings).get().triggerTokens).toBe(900000);
	expect(cfgCompactionModelThresholds.get(settings)).toEqual({ [`${model.provider}/${model.id}`]: "90%" });
});

test("rewinding retains conversation settings, fixed token inputs override percentage rules, and clear restores them", async () => {
	const settings = Settings.isolated({ "compaction.enabled": true });
	cfgCompactionModelThresholds.set(settings, { [`${model.provider}/${model.id}`]: "90%" });
	const manager = SessionManager.inMemory();
	managers.push(manager);
	const original = manager.appendMessage({ role: "user", content: "before threshold", timestamp: Date.now() });
	const controls = service(manager, settings);
	await controls.set("150k");
	manager.branch(original);
	expect(controls.get().triggerTokens).toBe(150000);
	await controls.set("0.5");
	expect(controls.get().triggerTokens).toBe(5000);
	expect(
		resolveSessionCompactionSettings(settings, { ...model, contextWindow: 200000 }, manager).thresholdTokens,
	).toBe(1000);
	await controls.set("0.5M");
	expect(controls.get().triggerTokens).toBe(500000);
	await controls.set("");
	expect(controls.get().threshold).toBeNull();
	expect(controls.get().triggerTokens).toBe(900000);
});

test("cached conversation thresholds follow new sessions and overrides after ordinary turns", async () => {
	const manager = SessionManager.inMemory();
	managers.push(manager);
	const settings = Settings.isolated({ "compaction.enabled": true });
	const controls = service(manager, settings);
	await controls.set("150k");
	for (let index = 0; index < 100; index++) {
		manager.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
		expect(controls.get().triggerTokens).toBe(150000);
	}
	await manager.newSession();
	expect(controls.get().threshold).toBeNull();
	await controls.set("250k");
	expect(controls.get().triggerTokens).toBe(250000);
});
