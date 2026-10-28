import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../src/session/agent-session";
import { AgentSession as NativeSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../src/config/settings";
import { cfgSessionMaxCost, cfgSessionWarnCost } from "../src/session/settings";
import { cfgRecapEnabled } from "../src/modes/settings";
import { CostGate } from "../src/session/cost-gate";
import { StudioContextViewService } from "../src/studio/services/context-view-service";
import { StudioSessionOptionsService } from "../src/studio/services/session-options-service";
import { StudioIdleMaintenance } from "../src/studio/services/idle-maintenance-service";
import { StudioResourceService } from "../src/studio/services/resource-service";
import { StudioAdvisorConfigService } from "../src/studio/services/advisor-config-service";
import { StudioInteractionGateway } from "../src/studio/services/interaction-port";
import type { StudioLoopService } from "../src/studio/services/loop-service";
import { applyStudioDefaults } from "../src/studio/settings-defaults";
import type { LocalResourceResultMap } from "../src/studio/local-resources-protocol";

const sessions: NativeSession[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function directory(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-18132-"));
	directories.push(dir);
	return dir;
}

test("session budget blocks the next tree request, null masks inherited caps and clear restores them", async () => {
	const settings = Settings.isolated();
	cfgSessionMaxCost.set(settings, 2);
	cfgSessionWarnCost.set(settings, 1);
	const notices: string[] = [];
	const gate = new CostGate(settings, 0, message => notices.push(message));
	const session = { sessionId: "budget", settings, costGate: gate } as AgentSession;
	const service = new StudioSessionOptionsService(session);
	gate.record(2.5);
	expect(gate.check()?.cap).toBe(2);
	expect(notices).toHaveLength(1);
	await service.execute({
		kind: "session.budget.set",
		sessionId: "budget",
		scope: "session",
		warnCost: null,
		maxCost: null,
	});
	expect(gate.check()).toBeUndefined();
	expect(service.budget().maxCost).toBeNull();
	await service.execute({ kind: "session.budget.clearOverride", sessionId: "budget" });
	expect(gate.check()?.spent).toBe(2.5);
	expect(service.budget().maxCost).toBe(2);
});

test("context viewer redacts credentials, pages a frozen body and expires it on release", async () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const session = new NativeSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["system"],
				messages: [{ role: "user", content: "ghp_" + "Ab3Z".repeat(10) + " page ".repeat(9000), timestamp: 1 }],
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: { getApiKey: async () => "unused" } as never,
		toolRegistry: new Map(),
	});
	sessions.push(session);
	{
		const service = new StudioContextViewService(session);
		const index = service.execute({ kind: "context.view.open", sessionId: session.sessionId });
		const list = service.execute({
			kind: "context.view.list",
			sessionId: session.sessionId,
			snapshotId: index.snapshotId,
			category: "user-messages",
		});
		const first = service.execute({
			kind: "context.view.entry",
			sessionId: session.sessionId,
			snapshotId: index.snapshotId,
			entryId: list.entries[0]!.id,
		});
		expect(first.text).not.toContain("ghp_" + "Ab3Z".repeat(10));
		expect(first.nextOffset).toBeGreaterThan(0);
		let text = first.text,
			offset = first.nextOffset;
		while (offset !== undefined) {
			const next = service.execute({
				kind: "context.view.entry",
				sessionId: session.sessionId,
				snapshotId: index.snapshotId,
				entryId: list.entries[0]!.id,
				offset,
			});
			text += next.text;
			offset = next.nextOffset;
		}
		expect(text.length).toBe(first.totalChars);
		service.execute({ kind: "context.view.release", sessionId: session.sessionId, snapshotId: index.snapshotId });
		expect(() =>
			service.execute({
				kind: "context.view.entry",
				sessionId: session.sessionId,
				snapshotId: index.snapshotId,
				entryId: list.entries[0]!.id,
			}),
		).toThrow("expired");
	}
});

test("idle maintenance needs explicit recap opt-in and known visible unblocked ownership", () => {
	const settings = Settings.isolated();
	applyStudioDefaults(settings);
	expect(cfgRecapEnabled.get(settings)).toBe(false);
	const opted = Settings.isolated({ "recap.enabled": true });
	applyStudioDefaults(opted);
	expect(cfgRecapEnabled.get(opted)).toBe(true);
	let refreshed = 0;
	let worker = true;
	const session = {
		sessionId: "idle",
		settings: opted,
		enableIdleMaintenance: () => {},
		refreshIdleMaintenance: () => refreshed++,
	} as unknown as AgentSession;
	const service = new StudioIdleMaintenance(
		session,
		{ state: () => undefined } as StudioLoopService,
		new StudioInteractionGateway(),
		() => worker,
	);
	expect(service.blocked()).toBe(true);
	service.update({ known: true, visibleSessionIds: ["idle"], blockedSessionIds: ["idle"] });
	expect(service.blocked()).toBe(true);
	service.update({ known: true, visibleSessionIds: ["idle"], blockedSessionIds: [] });
	expect(service.blocked()).toBe(false);
	worker = false;
	expect(service.blocked()).toBe(true);
	expect(refreshed).toBe(2);
	service.dispose();
	expect(service.blocked()).toBe(true);
});

test("local editor saves native bytes but preserves an external edit on version conflict", async () => {
	const root = await directory();
	await fs.mkdir(path.join(root, "local"));
	const file = path.join(root, "local", "notes.md");
	await fs.writeFile(file, "original");
	const session = {
		sessionId: "local",
		studioToolSession: {
			cwd: root,
			settings: Settings.isolated(),
			getArtifactsDir: () => root,
			getSessionId: () => "local",
			getSessionFile: () => undefined,
			skills: [],
			activeRules: [],
		},
	} as unknown as AgentSession;
	const service = new StudioResourceService(session);
	const opened = (await service.local({
		kind: "resource.local.open",
		sessionId: "local",
		uri: "local://notes.md",
	})) as LocalResourceResultMap["resource.local.open"];
	await service.local({
		kind: "resource.local.save",
		sessionId: "local",
		uri: opened.uri,
		version: opened.version,
		text: "saved",
	});
	expect(await fs.readFile(file, "utf8")).toBe("saved");
	await fs.writeFile(file, "external");
	await expect(
		service.local({
			kind: "resource.local.save",
			sessionId: "local",
			uri: opened.uri,
			version: opened.version,
			text: "lost",
		}),
	).rejects.toThrow("changed");
	expect(await fs.readFile(file, "utf8")).toBe("external");
});

test("advisor editor reloads scope/reasoning controls and refuses a stale WATCHDOG save", async () => {
	const root = await directory();
	const settings = await Settings.loadIsolated({ agentDir: path.join(root, "agent"), cwd: root, inMemory: true });
	let applied: unknown;
	const session = {
		sessionId: "advisor",
		settings,
		sessionManager: { getCwd: () => root },
		isStreaming: false,
		isCompacting: false,
		getAdvisorStatusOverview: () => ({ advisors: [] }),
		applyAdvisorConfigs: (rows: unknown) => {
			applied = rows;
			return 0;
		},
	} as unknown as AgentSession;
	const service = new StudioAdvisorConfigService(session);
	const view = await service.execute({ kind: "advisors.config.get", sessionId: "advisor", scope: "user" });
	await service.execute({
		kind: "advisors.config.save",
		sessionId: "advisor",
		scope: "user",
		version: view.version,
		document: { advisors: [{ name: "review", enabled: false, scope: "subagent", includeReasoning: false }] },
	});
	expect(applied).toMatchObject([{ scope: "subagent", includeReasoning: false }]);
	await expect(
		service.execute({
			kind: "advisors.config.save",
			sessionId: "advisor",
			scope: "user",
			version: view.version,
			document: { advisors: [] },
		}),
	).rejects.toThrow("changed");
});
