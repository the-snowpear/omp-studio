import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { defaultThemes } from "@oh-my-pi/pi-coding-agent/modes/theme/defaults";
import { createTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/loader";
import type { ThemeJson } from "@oh-my-pi/pi-coding-agent/modes/theme/schema";
import { setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { StudioRuntimeCommandArbiter } from "@oh-my-pi/pi-coding-agent/studio/command-arbiter";
import { createStudioRemoteUiFactory } from "@oh-my-pi/pi-coding-agent/studio/remote-extension-ui";
import {
	StudioInteractionGateway,
	StudioRemoteInteractionPort,
} from "@oh-my-pi/pi-coding-agent/studio/services/interaction-port";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	const blocks = result.content ?? [];
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

/**
 * Real Runtime E2E (plan §验收): a genuine AgentSession + the production
 * ExtensionToolWrapper approval gate + the Studio remote interaction port.
 * No mocks on the tool/approval/port path; only the model call is absent
 * because tools execute directly.
 */
describe("studio real tool approval and ask E2E", () => {
	let tempDir: string;
	let session: AgentSession;

	beforeAll(async () => {
		// AskTool's "Done selecting" label reads the module theme singleton;
		// the TUI initializes it at startup, so do the same here.
		setThemeInstance(createTheme(Object.values(defaultThemes)[0] as ThemeJson));
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-approval-e2e-${Snowflake.next()}-`));
		const cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager,
			settings: Settings.isolated(BASE_SETTINGS),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash"],
			hasUI: true,
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		// Windows can briefly hold tempdir handles after dispose; best-effort cleanup.
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				removeSyncWithRetries(tempDir);
				break;
			} catch {
				await Bun.sleep(50 * (attempt + 1));
			}
		}
	}, 15_000);

	function remoteUi() {
		const arbiter = new StudioRuntimeCommandArbiter(
			() => ({ runtimeEpoch: 1, stateVersion: 0, isStreaming: false, isCompacting: false }),
			[],
		);
		const port = new StudioRemoteInteractionPort(
			arbiter,
			() => {},
			() => {},
		);
		const gateway = new StudioInteractionGateway();
		gateway.bind(port);
		const factory = createStudioRemoteUiFactory(gateway);
		const toolCall = { batchId: "b", index: 0, total: 1, toolCalls: [{ id: "e2e-call-1", name: "bash" }] };
		return { port, ui: factory(toolCall), toolCall };
	}

	async function respond(
		port: StudioRemoteInteractionPort,
		decision: "submit" | "cancel",
		value?: unknown,
	): Promise<void> {
		const request = port.pending()?.request;
		if (!request) throw new Error("no pending interaction");
		port.respond({
			kind: "interaction.respond",
			interactionId: request.interactionId,
			commandId: request.commandId,
			decision,
			...(value === undefined ? {} : { value }),
		});
	}

	test("Review mode: bash approval card allows once and the tool continues", async () => {
		const bash = session.getToolByName("bash");
		if (!bash) throw new Error("Expected bash tool");
		const { port, ui, toolCall } = remoteUi();
		const settings = Settings.isolated({ ...BASE_SETTINGS, "tools.approvalMode": "always-ask" });
		const result = bash.execute("e2e-approval-allow", { command: "echo approved-e2e" }, undefined, undefined, {
			settings,
			ui,
			toolCall,
		} as AgentToolContext);
		const pending = port.pending();
		expect(pending).toBeDefined();
		expect(pending?.request).toMatchObject({
			kind: "approval",
			approvalType: "bash",
			commandId: "studio-tool:e2e-call-1",
		});
		await respond(port, "submit", true);
		const outcome = await result;
		expect(textOf(outcome)).toContain("approved-e2e");
		expect(port.pending()).toBeUndefined();
	});

	test("Review mode: cancelling the bash approval denies the tool", async () => {
		const bash = session.getToolByName("bash");
		if (!bash) throw new Error("Expected bash tool");
		const { port, ui, toolCall } = remoteUi();
		const settings = Settings.isolated({ ...BASE_SETTINGS, "tools.approvalMode": "always-ask" });
		const result = bash.execute("e2e-approval-deny", { command: "echo must-not-run" }, undefined, undefined, {
			settings,
			ui,
			toolCall,
		} as AgentToolContext);
		expect(port.pending()).toBeDefined();
		await respond(port, "cancel");
		await expect(result).rejects.toThrow("Tool call denied by user: bash");
	});

	test("yolo mode creates no approval card and runs directly", async () => {
		const bash = session.getToolByName("bash");
		if (!bash) throw new Error("Expected bash tool");
		const { port, ui, toolCall } = remoteUi();
		const settings = Settings.isolated({ ...BASE_SETTINGS, "tools.approvalMode": "yolo" });
		const result = await bash.execute("e2e-yolo", { command: "echo yolo-e2e" }, undefined, undefined, {
			settings,
			ui,
			toolCall,
		} as AgentToolContext);
		expect(textOf(result)).toContain("yolo-e2e");
		expect(port.pending()).toBeUndefined();
	});

	test("Live Ask sends every question in one ask card and returns the chosen labels", async () => {
		const askTool = new AskTool(session as never);
		const { port, ui, toolCall } = remoteUi();
		const result = askTool.execute(
			"e2e-ask-1",
			{
				questions: [
					{
						id: "backend",
						question: "Which backend?",
						options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
					},
					{
						id: "cache",
						question: "Cache layer?",
						header: "缓存",
						options: [{ label: "Redis" }, { label: "Memory" }],
					},
				],
			},
			undefined,
			undefined,
			{ hasUI: true, ui, toolCall } as AgentToolContext,
		);
		const pending = port.pending();
		expect(pending?.request).toMatchObject({
			kind: "ask",
			commandId: "studio-tool:e2e-call-1",
			title: "Agent 提问",
		});
		if (pending?.request.kind !== "ask") throw new Error("expected ask");
		expect(pending.request.questions.map(question => question.id)).toEqual(["backend", "cache"]);
		await respond(port, "submit", {
			results: [
				{ id: "backend", selectedOptions: ["PostgreSQL"] },
				{ id: "cache", selectedOptions: ["Redis"] },
			],
		});
		const outcome = await result;
		expect(textOf(outcome)).toContain("PostgreSQL");
		expect(textOf(outcome)).toContain("Redis");
		expect(port.pending()).toBeUndefined();
	});
});
