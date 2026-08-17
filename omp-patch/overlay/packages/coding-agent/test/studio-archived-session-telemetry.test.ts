import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { StudioSessionTelemetry } from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import type { ConversationRuntimeEvent } from "@oh-my-pi/pi-coding-agent/studio/conversation-protocol";
import {
	deriveProbeSessionInputs,
	detectDynamicContextInfluences,
	runStudioSessionTelemetryProbe,
	type StudioTelemetryProbeOutput,
} from "@oh-my-pi/pi-coding-agent/studio/session-telemetry-probe";
import { StudioStateProjector } from "@oh-my-pi/pi-coding-agent/studio/state-projector";
import type { StudioHostRuntime } from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";

interface Fixture {
	readonly root: string;
	readonly workspace: string;
	readonly agentDir: string;
	readonly sessionFile: string;
	readonly sessionId: string;
	readonly userMessage: UserMessage;
	readonly assistantMessage: AssistantMessage;
}

let fixtureRoot: string | undefined;
let authStorage: AuthStorage | undefined;
let registry: ModelRegistry | undefined;

async function makeWorkspace(root: string, name: string): Promise<string> {
	const workspace = path.join(root, name);
	await fs.mkdir(workspace, { recursive: true });
	return workspace;
}

async function writeFixtureSession(options: {
	workspace: string;
	sessionId: string;
	cwd: string;
	name?: string;
}): Promise<string> {
	const sessionFile = path.join(options.workspace, options.name ?? "session-copy.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: options.sessionId,
		timestamp: "2026-08-16T00:00:00.000Z",
		cwd: options.cwd,
	};
	const lines = [JSON.stringify(header)];
	for (const [index, message] of [fixtureUserMessage(), fixtureAssistantMessage()].entries()) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `entry-${index + 1}`,
				parentId: index === 0 ? null : "entry-1",
				timestamp: "2026-08-16T00:00:01.000Z",
				message,
			}),
		);
	}
	await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");
	return sessionFile;
}

function fixtureUserMessage(): UserMessage {
	return {
		role: "user",
		content: "Hello archived session",
		timestamp: 1_755_292_800_000,
	};
}

function fixtureAssistantMessage(): AssistantMessage {
	const model = registry?.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
	if (!model) throw new Error("Expected bundled model with context window");
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1_000,
			output: 40,
			cacheRead: 100,
			cacheWrite: 60,
			totalTokens: 1_200,
			reasoningTokens: 12,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
		stopReason: "stop",
		timestamp: 1_755_292_810_000,
	};
}

async function createFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-studio-probe-test-"));
	const workspace = await makeWorkspace(root, "ws");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const model = registry?.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
	if (!model) throw new Error("Expected bundled model with context window");
	await fs.writeFile(path.join(agentDir, "config.yml"), `modelRoles:\n  default: "${model.id}"\n`, "utf8");
	const sessionId = "session-archive-probe";
	const sessionFile = await writeFixtureSession({ workspace, sessionId, cwd: workspace });
	return {
		root,
		workspace,
		agentDir,
		sessionFile,
		sessionId,
		userMessage: fixtureUserMessage(),
		assistantMessage: fixtureAssistantMessage(),
	};
}

async function runProbe(
	fixture: Fixture,
	options: {
		readonly requestOverrides?: Record<string, unknown>;
		readonly rawInput?: string;
		readonly workspace?: string;
		readonly sessionFile?: string;
		readonly expectedSessionId?: string;
	} = {},
): Promise<{ output: StudioTelemetryProbeOutput; lines: string[]; diagnostics: string[]; exitCode: number }> {
	const lines: string[] = [];
	const diagnostics: string[] = [];
	const request = {
		schemaVersion: 1,
		requestId: "req-1",
		sessionFile: options.sessionFile ?? fixture.sessionFile,
		expectedSessionId: options.expectedSessionId ?? fixture.sessionId,
		allowedCwd: options.workspace ?? fixture.workspace,
		...options.requestOverrides,
	};
	const exitCode = await runStudioSessionTelemetryProbe({
		readInput: async () => options.rawInput ?? JSON.stringify(request),
		writeOutput: line => lines.push(line),
		writeDiagnostic: line => diagnostics.push(line),
		agentDir: fixture.agentDir,
	});
	if (lines.length !== 1) throw new Error(`probe wrote ${lines.length} stdout lines`);
	return { output: JSON.parse(lines[0]) as StudioTelemetryProbeOutput, lines, diagnostics, exitCode };
}

function fakeRuntime(session: AgentSession, sessionId: string): StudioHostRuntime {
	let conversationListener: ((event: ConversationRuntimeEvent) => void) | undefined;
	return {
		runtimeId: "runtime-parity",
		runtimeEpoch: 1,
		sessionId,
		sessionManager: SessionManager.inMemory(),
		session,
		services: {
			pause: { state: () => ({ paused: false, pauseEpoch: 0 }), onChange: () => () => {} },
			loop: { state: () => undefined, onChange: () => () => {} },
			live: { state: () => ({ status: "off" }), onChange: () => () => {} },
			modes: { state: () => ({}), onChange: () => () => {} },
			commands: { manifestHash: () => "sha256:commands" },
			agents: { list: () => [], onChange: () => () => {} },
			jobs: { list: () => [] },
			conversation: {
				onEvent: (listener: (event: ConversationRuntimeEvent) => void) => {
					conversationListener = listener;
					return () => {
						if (conversationListener === listener) conversationListener = undefined;
					};
				},
			},
		},
	} as unknown as StudioHostRuntime;
}

beforeAll(async () => {
	fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-studio-probe-auth-"));
	authStorage = await AuthStorage.create(path.join(fixtureRoot, "auth.db"));
	registry = new ModelRegistry(authStorage);
});

afterAll(async () => {
	authStorage?.close();
	if (fixtureRoot !== undefined) await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("studio archived session telemetry probe", () => {
	test("recomputes telemetry from a session copy and prints exactly one JSON line", async () => {
		const fixture = await createFixture();
		try {
			const { output, lines, exitCode } = await runProbe(fixture);
			expect(exitCode).toBe(0);
			expect(lines).toHaveLength(1);
			expect(output.ok).toBe(true);
			if (!output.ok) return;
			const telemetry = output.telemetry;
			expect(telemetry.sessionId).toBe(fixture.sessionId);
			expect(telemetry.tokens.total).toBe(1_200);
			expect(telemetry.tokens.input).toBe(1_000);
			expect(telemetry.lastCompletedTurn?.total).toBe(1_200);
			expect(telemetry.lastCompletedTurn?.cost).toBe(0.03);
			expect(telemetry.context).not.toBeNull();
			const context = telemetry.context;
			if (context === null) return;
			expect(context.contextWindow).toBeGreaterThan(0);
			for (const value of [
				context.systemPromptTokens,
				context.systemContextTokens,
				context.systemToolsTokens,
				context.skillsTokens,
				context.messagesTokens,
			]) {
				expect(Number.isSafeInteger(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(0);
			}
			const after = await fs.readFile(fixture.sessionFile, "utf8");
			expect(after).toContain(fixture.sessionId);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("matches the live projector for an AgentSession fed with the same inputs", async () => {
		const fixture = await createFixture();
		let liveSession: AgentSession | undefined;
		let projector: StudioStateProjector | undefined;
		try {
			const settings = await Settings.loadReadOnly({ cwd: fixture.workspace, agentDir: fixture.agentDir });
			const inputs = await deriveProbeSessionInputs({
				sessionFile: fixture.sessionFile,
				allowedCwd: fixture.workspace,
				agentDir: fixture.agentDir,
				settings,
				registry: registry as ModelRegistry,
				fallbackModelIds: [],
			});
			const agent = new Agent({
				initialState: {
					model: inputs.model,
					systemPrompt: [...inputs.systemPrompt],
					tools: inputs.tools,
					messages: [fixture.userMessage, fixture.assistantMessage],
				},
			});
			liveSession = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: registry as ModelRegistry,
				skills: [...inputs.skills],
			});
			projector = new StudioStateProjector(fakeRuntime(liveSession, fixture.sessionId));
			const live = projector.snapshot().telemetry;
			if (live === undefined) throw new Error("expected live telemetry snapshot");
			const { output } = await runProbe(fixture);
			if (!output.ok) throw new Error("expected probe success");
			const recomputed: StudioSessionTelemetry = { ...output.telemetry, capturedAt: live.capturedAt };
			expect(recomputed).toEqual(live);
		} finally {
			projector?.dispose();
			await liveSession?.dispose();
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects malformed stdin payloads", async () => {
		const fixture = await createFixture();
		try {
			const extra = await runProbe(fixture, { requestOverrides: { extra: true } });
			expect(extra.output.ok).toBe(false);
			if (extra.output.ok) return;
			expect(extra.output.code).toBe("INVALID_INPUT");

			const badVersion = await runProbe(fixture, { requestOverrides: { schemaVersion: 2 } });
			expect(badVersion.output.ok).toBe(false);
			if (badVersion.output.ok) return;
			expect(badVersion.output.code).toBe("INVALID_INPUT");

			const notJson = await runProbe(fixture, { rawInput: "not json" });
			expect(notJson.output.ok).toBe(false);
			if (notJson.output.ok) return;
			expect(notJson.output.code).toBe("INVALID_INPUT");
			expect(notJson.output.requestId).toBe("");

			const oversized = await runProbe(fixture, { rawInput: "x".repeat(70_000) });
			expect(oversized.output.ok).toBe(false);
			if (oversized.output.ok) return;
			expect(oversized.output.code).toBe("INVALID_INPUT");

			const blank = await runProbe(fixture, { requestOverrides: { sessionFile: "" } });
			expect(blank.output.ok).toBe(false);
			if (blank.output.ok) return;
			expect(blank.output.code).toBe("INVALID_INPUT");
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("fails closed for missing sessions, workspace mismatches, and session mismatches", async () => {
		const fixture = await createFixture();
		try {
			const missing = await runProbe(fixture, {
				sessionFile: path.join(fixture.root, "missing.jsonl"),
			});
			expect(missing.output.ok).toBe(false);
			if (missing.output.ok) return;
			expect(missing.output.code).toBe("SESSION_NOT_FOUND");

			const otherWorkspace = await makeWorkspace(fixture.root, "ws-other");
			const mismatchedFile = await writeFixtureSession({
				workspace: fixture.workspace,
				sessionId: fixture.sessionId,
				cwd: otherWorkspace,
				name: "session-other-cwd.jsonl",
			});
			const mismatch = await runProbe(fixture, { sessionFile: mismatchedFile });
			expect(mismatch.output.ok).toBe(false);
			if (mismatch.output.ok) return;
			expect(mismatch.output.code).toBe("WORKSPACE_MISMATCH");

			const identity = await runProbe(fixture, { expectedSessionId: "session-someone-else" });
			expect(identity.output.ok).toBe(false);
			if (identity.output.ok) return;
			expect(identity.output.code).toBe("SESSION_MISMATCH");
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("reports real tokens with context unavailable when dynamic extensions are present", async () => {
		const fixture = await createFixture();
		try {
			await fs.mkdir(path.join(fixture.workspace, ".omp", "extensions"), { recursive: true });
			const { output } = await runProbe(fixture);
			expect(output.ok).toBe(true);
			if (!output.ok) return;
			expect(output.telemetry.tokens.total).toBe(1_200);
			expect(output.telemetry.context).toBeNull();
			expect(output.telemetry.unavailableReason).toBe("probe_dynamic_context_disabled");
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("dynamic-context detection covers settings, MCP configs, and extension roots", async () => {
		const fixture = await createFixture();
		try {
			const settings = Settings.isolated({});
			expect(
				await detectDynamicContextInfluences({
					settings,
					allowedCwd: fixture.workspace,
					agentDir: fixture.agentDir,
				}),
			).toBe(false);

			const withExtensionSetting = Settings.isolated({ extensions: ["some-extension"] });
			expect(
				await detectDynamicContextInfluences({
					settings: withExtensionSetting,
					allowedCwd: fixture.workspace,
					agentDir: fixture.agentDir,
				}),
			).toBe(true);

			await fs.writeFile(
				path.join(fixture.workspace, ".mcp.json"),
				JSON.stringify({ mcpServers: { fetch: { command: "x" } } }),
				"utf8",
			);
			expect(
				await detectDynamicContextInfluences({
					settings,
					allowedCwd: fixture.workspace,
					agentDir: fixture.agentDir,
				}),
			).toBe(true);
			await fs.rm(path.join(fixture.workspace, ".mcp.json"), { force: true });

			await fs.writeFile(path.join(fixture.workspace, "mcp.json"), "{not json", "utf8");
			expect(
				await detectDynamicContextInfluences({
					settings,
					allowedCwd: fixture.workspace,
					agentDir: fixture.agentDir,
				}),
			).toBe(true);
			await fs.rm(path.join(fixture.workspace, "mcp.json"), { force: true });

			await fs.mkdir(path.join(fixture.workspace, ".claude", "tools"), { recursive: true });
			expect(
				await detectDynamicContextInfluences({
					settings,
					allowedCwd: fixture.workspace,
					agentDir: fixture.agentDir,
				}),
			).toBe(true);
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
});
