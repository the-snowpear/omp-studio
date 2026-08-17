/**
 * One-shot, read-only Studio telemetry probe for archived sessions.
 *
 * Invoked by the Studio Host as `omp --studio-session-telemetry-probe` with a
 * single JSON request on stdin. The Host passes a *temporary copy* of the
 * session transcript (never the original file), and the probe answers with
 * exactly one JSON line on stdout, then exits.
 *
 * Hard safety rules (see `0024-studio-archived-session-telemetry.patch`):
 * - No extensions, hooks, or MCP servers are loaded or executed.
 * - No model requests, tool calls, agent spawns, or background jobs.
 * - The reconstructed context window comes from the current local model
 *   configuration; when the environment carries dynamic-context influences
 *   (extensions, hooks, MCP configs) the token totals are still real but
 *   `context` is reported as unavailable.
 * - stdout carries exactly one JSON object; diagnostics go to stderr and must
 *   not contain paths, prompts, message content, or credentials.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import { Settings } from "../config/settings";
import type { Skill } from "../extensibility/skills";
import { discoverSkills } from "../sdk";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import type { SessionMessageEntry } from "../session/session-entries";
import { SessionManager } from "../session/session-manager";
import { buildSystemPrompt, projectSystemPromptToolMetadata } from "../system-prompt";
import { BUILTIN_TOOLS, type Tool, type ToolSession } from "../tools";
import type { StudioSessionTelemetry } from "./bridge-protocol";
import { buildStudioSessionTelemetry, type StudioTelemetrySessionPort } from "./session-telemetry";

const MAX_INPUT_BYTES = 64 * 1024;

export interface StudioTelemetryProbeInput {
	readonly schemaVersion: 1;
	readonly requestId: string;
	readonly sessionFile: string;
	readonly expectedSessionId: string;
	readonly allowedCwd: string;
}

export type StudioTelemetryProbeErrorCode =
	| "INVALID_INPUT"
	| "SESSION_NOT_FOUND"
	| "SESSION_MISMATCH"
	| "WORKSPACE_MISMATCH"
	| "SESSION_CORRUPT"
	| "PROBE_UNAVAILABLE";

export type StudioTelemetryProbeOutput =
	| {
			readonly schemaVersion: 1;
			readonly requestId: string;
			readonly ok: true;
			readonly telemetry: StudioSessionTelemetry;
	  }
	| {
			readonly schemaVersion: 1;
			readonly requestId: string;
			readonly ok: false;
			readonly code: StudioTelemetryProbeErrorCode;
			readonly message: string;
	  };

export interface StudioTelemetryProbeIO {
	readonly readInput?: () => Promise<string>;
	readonly writeOutput?: (line: string) => void;
	readonly writeDiagnostic?: (line: string) => void;
	/** Overrides the agent directory (tests). Defaults to the profile agent dir. */
	readonly agentDir?: string;
}

class ProbeInputError extends Error {
	constructor(
		readonly code: StudioTelemetryProbeErrorCode,
		message: string,
	) {
		super(message);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProbeInput(raw: string): { input: StudioTelemetryProbeInput; requestId: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ProbeInputError("INVALID_INPUT", "probe input is not valid JSON");
	}
	if (!isRecord(parsed)) throw new ProbeInputError("INVALID_INPUT", "probe input must be a JSON object");
	const keys = Object.keys(parsed).sort().join(",");
	if (keys !== "allowedCwd,expectedSessionId,requestId,schemaVersion,sessionFile") {
		throw new ProbeInputError("INVALID_INPUT", "probe input fields do not match the expected schema");
	}
	if (parsed.schemaVersion !== 1) throw new ProbeInputError("INVALID_INPUT", "unsupported probe schema version");
	for (const field of ["requestId", "sessionFile", "expectedSessionId", "allowedCwd"] as const) {
		if (typeof parsed[field] !== "string" || (parsed[field] as string).length === 0) {
			throw new ProbeInputError("INVALID_INPUT", "probe input string field is missing or empty");
		}
	}
	const input = parsed as unknown as StudioTelemetryProbeInput;
	return { input, requestId: input.requestId };
}

function sameWorkspace(left: string, right: string): boolean {
	const resolvedLeft = path.resolve(left);
	const resolvedRight = path.resolve(right);
	if (process.platform === "win32" || process.platform === "darwin") {
		return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
	}
	return resolvedLeft === resolvedRight;
}

async function fileExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

async function directoryExists(target: string): Promise<boolean> {
	try {
		const stat = await fs.stat(target);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

function mcpConfigHasServers(raw: unknown): boolean {
	if (!isRecord(raw)) return true; // unparsable config shape: fail closed
	const servers = raw.servers ?? raw.mcpServers;
	if (servers === undefined || servers === null) return false;
	if (!isRecord(servers)) return true;
	return Object.keys(servers).length > 0;
}

/**
 * Detect environment influences whose faithful Context rebuild would require
 * executing extension/hook/MCP code. Detection is intentionally read-only and
 * conservative: an unknown shape counts as dynamic (context is reported
 * unavailable rather than guessed).
 */
export async function detectDynamicContextInfluences(options: {
	readonly settings: Settings;
	readonly allowedCwd: string;
	readonly agentDir: string;
}): Promise<boolean> {
	const { settings, allowedCwd, agentDir } = options;
	const configuredExtensions = settings.get("extensions");
	if (Array.isArray(configuredExtensions) && configuredExtensions.length > 0) return true;

	const mcpCandidates: string[] = [];
	if (settings.get("mcp.enableProjectConfig") !== false) {
		mcpCandidates.push(path.join(allowedCwd, ".mcp.json"), path.join(allowedCwd, "mcp.json"));
	}
	mcpCandidates.push(path.join(allowedCwd, ".omp", "mcp.json"), path.join(agentDir, "mcp.json"));
	for (const candidate of mcpCandidates) {
		if (!(await fileExists(candidate))) continue;
		try {
			const raw = await fs.readFile(candidate, "utf8");
			if (mcpConfigHasServers(JSON.parse(raw))) return true;
		} catch {
			return true;
		}
	}

	const dynamicRoots = [
		path.join(allowedCwd, ".omp", "extensions"),
		path.join(allowedCwd, ".claude", "extensions"),
		path.join(allowedCwd, ".omp", "tools"),
		path.join(allowedCwd, ".claude", "tools"),
	];
	for (const root of dynamicRoots) {
		if (await directoryExists(root)) return true;
	}
	return false;
}

/**
 * Build the read-only tool set a fresh, extension-free session would get.
 * Kernel-availability probes are skipped: the probe must not spawn
 * subprocesses, so eval availability falls back to its static default.
 */
export async function createProbeTools(options: {
	readonly settings: Settings;
	readonly allowedCwd: string;
	readonly sessionFile: string;
	readonly skills: readonly Skill[];
}): Promise<Tool[]> {
	const session: ToolSession = {
		cwd: options.allowedCwd,
		hasUI: false,
		settings: options.settings,
		skills: options.skills,
		skipPythonPreflight: true,
		enableLsp: false,
		enableMCP: false,
		getSessionFile: () => options.sessionFile,
		getSessionSpawns: () => null,
		isDisposed: () => false,
	};
	const tools: Tool[] = [];
	for (const factory of Object.values(BUILTIN_TOOLS)) {
		const tool = await factory(session);
		if (tool !== null) tools.push(tool);
	}
	return tools;
}

/** Resolve the model the probe should assume, from current local config only. */
export function resolveProbeModel(options: {
	readonly settings: Settings;
	readonly registry: ModelRegistry;
	readonly fallbackModelIds: readonly string[];
}): Model | undefined {
	const candidates = options.registry.getAll();
	const roleValue = options.settings.getModelRole("default");
	if (roleValue !== undefined && roleValue.trim().length > 0) {
		const resolved = resolveModelRoleValue(roleValue, candidates, {
			settings: options.settings,
			matchPreferences: getModelMatchPreferences(options.settings),
		});
		if (resolved.model !== undefined) return resolved.model;
	}
	for (const id of options.fallbackModelIds) {
		const match = candidates.find(candidate => candidate.id === id);
		if (match !== undefined) return match;
	}
	// Mirror the fresh-session startup fallback: with no configured role and
	// no recorded session model, assume the first bundled model that actually
	// declares a context window.
	return candidates.find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
}

export interface ProbeStatsSession {
	readonly session: AgentSession;
	readonly manager: SessionManager;
	readonly authStorage: AuthStorage;
	readonly registry: ModelRegistry;
	readonly model: Model | undefined;
	readonly dynamicContext: boolean;
	readonly dispose: () => Promise<void>;
}

export interface ProbeSessionInputs {
	readonly skills: readonly Skill[];
	readonly tools: Tool[];
	readonly systemPrompt: readonly string[];
	readonly model: Model | undefined;
}

/**
 * Derive the non-message inputs (skills, built-in tools, freshly rendered
 * system prompt, current default model) a fresh extension-free session would
 * get in the current environment. Exported so tests can drive the live
 * projector with byte-identical inputs for parity checks.
 */
export async function deriveProbeSessionInputs(options: {
	readonly sessionFile: string;
	readonly allowedCwd: string;
	readonly agentDir: string;
	readonly settings: Settings;
	readonly registry: ModelRegistry;
	readonly fallbackModelIds: readonly string[];
}): Promise<ProbeSessionInputs> {
	const skills = await discoverSkills(options.allowedCwd, options.agentDir, options.settings.getGroup("skills"));
	const tools = await createProbeTools({
		settings: options.settings,
		allowedCwd: options.allowedCwd,
		sessionFile: options.sessionFile,
		skills: skills.skills,
	});
	const model = resolveProbeModel({
		settings: options.settings,
		registry: options.registry,
		fallbackModelIds: options.fallbackModelIds,
	});
	const toolNames = tools.map(tool => tool.name);
	const toolMap = new Map(tools.map(tool => [tool.name, tool]));
	const prompt = await buildSystemPrompt({
		cwd: options.allowedCwd,
		toolNames,
		tools: projectSystemPromptToolMetadata(toolMap, { mode: "compact", toolNames }),
		skills: skills.skills,
		skillsSettings: options.settings.getGroup("skills"),
		model: model?.id,
		includeModelInPrompt: options.settings.get("includeModelInPrompt"),
		personality: options.settings.get("personality"),
		taskBatch: options.settings.get("task.batch"),
		taskMaxConcurrency: options.settings.get("task.maxConcurrency"),
		securityEnabled: options.settings.get("security.enabled"),
		renderMermaid: options.settings.get("tui.renderMermaid"),
	});
	return { skills: skills.skills, tools, systemPrompt: prompt.systemPrompt, model };
}

/**
 * Reconstruct a read-only stats session over a validated transcript copy:
 * current settings + static skills + built-in tools + a freshly rendered
 * system prompt, with the historical message branch replayed into the agent
 * state. Nothing here talks to the network, executes tools, or runs
 * extension code.
 */
export async function createProbeStatsSession(options: {
	readonly sessionFile: string;
	readonly expectedSessionId: string;
	readonly allowedCwd: string;
	readonly settings: Settings;
	readonly agentDir: string;
}): Promise<ProbeStatsSession> {
	const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-studio-telemetry-"));
	const authStorage = await AuthStorage.create(path.join(workDir, "auth.db"));
	const registry = new ModelRegistry(authStorage);
	const manager = await SessionManager.open(options.sessionFile, undefined, undefined, {
		suppressBreadcrumb: true,
		initialCwd: options.allowedCwd,
	});
	let statsSession: AgentSession | undefined;
	let disposed = false;
	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		try {
			await statsSession?.dispose();
		} catch {}
		try {
			await manager.close();
		} catch {}
		authStorage.close();
		await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
	};
	try {
		if (manager.getSessionId() !== options.expectedSessionId) {
			throw new ProbeInputError("SESSION_MISMATCH", "session id does not match the request");
		}
		const fallbackModelIds: string[] = [];
		for (const entry of [...manager.getBranch()].reverse()) {
			if (entry.type === "model_change" && typeof entry.model === "string") {
				fallbackModelIds.push(entry.model);
				break;
			}
			if (entry.type === "session_init" && typeof entry.resolvedModel === "string") {
				fallbackModelIds.push(entry.resolvedModel);
				break;
			}
		}
		const inputs = await deriveProbeSessionInputs({
			sessionFile: options.sessionFile,
			allowedCwd: options.allowedCwd,
			agentDir: options.agentDir,
			settings: options.settings,
			registry,
			fallbackModelIds,
		});
		const messages = manager
			.getBranch()
			.filter((entry): entry is SessionMessageEntry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		const agent = new Agent({
			initialState: {
				model: inputs.model,
				systemPrompt: [...inputs.systemPrompt],
				tools: inputs.tools,
				messages,
			},
		});
		statsSession = new AgentSession({
			agent,
			sessionManager: manager,
			settings: options.settings,
			modelRegistry: registry,
			skills: [...inputs.skills],
		});
		const dynamicContext = await detectDynamicContextInfluences({
			settings: options.settings,
			allowedCwd: options.allowedCwd,
			agentDir: options.agentDir,
		});
		return { session: statsSession, manager, authStorage, registry, model: inputs.model, dynamicContext, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}

async function readStdinCapped(): Promise<string> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = Bun.stdin.stream().getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value !== undefined) {
				total += value.byteLength;
				if (total > MAX_INPUT_BYTES)
					throw new ProbeInputError("INVALID_INPUT", "probe input exceeds the size limit");
				chunks.push(value);
			}
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.from(Buffer.concat(chunks)).toString("utf8");
}

/** Entry point wired from `cli.ts` before any command dispatch. */
export async function runStudioSessionTelemetryProbe(io: StudioTelemetryProbeIO = {}): Promise<number> {
	const writeOutput = io.writeOutput ?? ((line: string) => process.stdout.write(line));
	const writeDiagnostic = io.writeDiagnostic ?? ((line: string) => process.stderr.write(line));
	const readInput = io.readInput ?? readStdinCapped;
	let output: StudioTelemetryProbeOutput;
	let probeSession: ProbeStatsSession | undefined;
	let requestId = "";
	try {
		const parsed = parseProbeInput(await readInput());
		requestId = parsed.requestId;
		const input = parsed.input;
		try {
			const peek = await SessionManager.peekSessionInit(input.sessionFile);
			if (peek === null) {
				output = {
					schemaVersion: 1,
					requestId,
					ok: false,
					code: "SESSION_NOT_FOUND",
					message: "session copy could not be read",
				};
			} else if (!sameWorkspace(peek.cwd, input.allowedCwd)) {
				output = {
					schemaVersion: 1,
					requestId,
					ok: false,
					code: "WORKSPACE_MISMATCH",
					message: "session workspace does not match the allowed workspace",
				};
			} else {
				const agentDir = io.agentDir ?? getAgentDir();
				const settings = await Settings.loadReadOnly({ cwd: input.allowedCwd, agentDir });
				probeSession = await createProbeStatsSession({
					sessionFile: input.sessionFile,
					expectedSessionId: input.expectedSessionId,
					allowedCwd: input.allowedCwd,
					settings,
					agentDir,
				});
				const computed = buildStudioSessionTelemetry({
					sessionId: input.expectedSessionId,
					session: probeSession.session as unknown as StudioTelemetrySessionPort,
					capturedAt: new Date().toISOString(),
				});
				const telemetry: StudioSessionTelemetry = probeSession.dynamicContext
					? {
							...computed,
							context: null,
							unavailableReason: "probe_dynamic_context_disabled",
						}
					: computed;
				output = { schemaVersion: 1, requestId, ok: true, telemetry };
			}
		} catch (error) {
			if (error instanceof ProbeInputError) {
				output = { schemaVersion: 1, requestId, ok: false, code: error.code, message: error.message };
			} else {
				writeDiagnostic(
					`studio telemetry probe failed: ${error instanceof Error ? error.constructor.name : "unknown"}`,
				);
				output = {
					schemaVersion: 1,
					requestId,
					ok: false,
					code: "PROBE_UNAVAILABLE",
					message: "telemetry probe could not complete",
				};
			}
		}
	} catch (error) {
		if (error instanceof ProbeInputError) {
			output = { schemaVersion: 1, requestId, ok: false, code: error.code, message: error.message };
		} else {
			writeDiagnostic(`studio telemetry probe rejected input: ${error instanceof Error ? "parse" : "unknown"}`);
			output = {
				schemaVersion: 1,
				requestId,
				ok: false,
				code: "INVALID_INPUT",
				message: "probe input was rejected",
			};
		}
	} finally {
		await probeSession?.dispose();
	}
	writeOutput(`${JSON.stringify(output)}\n`);
	return 0;
}
