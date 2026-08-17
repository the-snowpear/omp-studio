import * as crypto from "node:crypto";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import type { FileSlashCommand } from "../../extensibility/slash-commands";
import type { AgentSession } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../../session/messages";
import { BUILTIN_SLASH_COMMANDS_INTERNAL, lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../../slash-commands/types";

export interface StudioOperatorCommand {
	id: string;
	name: string;
	aliases: string[];
	description: string;
	source: "builtin" | "skill" | "extension" | "prompt-template" | "file-command";
	implementation: "shared-service" | "headless-handle" | "tui-compatibility" | "extension-command";
	interactionKinds: Array<"confirm" | "select" | "input" | "editor" | "approval" | "ask">;
	presentation: "generic-form" | "terminal" | "native";
	availability: "available";
	argumentSchema?: { type: "string"; hint?: string };
	risk: "normal" | "sensitive" | "destructive";
	effect: "read" | "session" | "workspace" | "process" | "external";
	contractTestId: string;
}

export interface StudioOperatorCommandManifest {
	generatedAt: string;
	upstreamCommit: string;
	hash: string;
	commands: StudioOperatorCommand[];
	unclassifiedBuiltins: string[];
}

const UPSTREAM_COMMIT = "45e12e5bb758198a920c6070e7e64cb33b21beac";
const DESTRUCTIVE = new Set(["drop", "clear", "fork"]);
const READ_ONLY = new Set(["help", "version", "stats", "models", "tree", "branch", "goal"]);

export class StudioCommandManifestError extends Error {
	constructor(
		readonly code: "COMMAND_UNKNOWN" | "INVALID_ARGUMENT" | "TERMINAL_REQUIRED",
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "StudioCommandManifestError";
	}
}

export class StudioCommandManifestService {
	#current: StudioOperatorCommandManifest;
	#commandsById = new Map<string, StudioOperatorCommand>();

	constructor(private readonly session: AgentSession) {
		this.#current = this.#replace(BUILTIN_SLASH_COMMANDS_INTERNAL.map(command => builtinDescriptor(command)));
	}

	manifest(): StudioOperatorCommandManifest {
		return structuredClone(this.#current);
	}

	manifestHash(): string {
		return this.#current.hash;
	}

	async refresh(): Promise<StudioOperatorCommandManifest> {
		const { buildAvailableSlashCommands } = await import("../../slash-commands/available-commands");
		const commands = BUILTIN_SLASH_COMMANDS_INTERNAL.map(command => builtinDescriptor(command));
		const availableSession = {
			extensionRunner: this.session.extensionRunner,
			customCommands: this.session.customCommands ?? [],
			mcpPromptCommands: this.session.mcpPromptCommands ?? [],
			skills: this.session.skills ?? [],
			skillsSettings: this.session.skillsSettings,
			setSlashCommands: (commands: FileSlashCommand[]) => this.session.setSlashCommands?.(commands),
			sessionManager: this.session.sessionManager,
		};
		for (const command of await buildAvailableSlashCommands(availableSession)) {
			if (command.source === "builtin") continue;
			commands.push({
				id: `${manifestSource(command.source)}.${command.name}`,
				name: command.name,
				aliases: [...(command.aliases ?? [])],
				description: command.description ?? `/${command.name}`,
				source: manifestSource(command.source),
				implementation:
					command.source === "extension"
						? "extension-command"
						: command.source === "skill"
							? "shared-service"
							: "headless-handle",
				interactionKinds: [],
				presentation: command.source === "extension" ? "generic-form" : "native",
				availability: "available",
				...(command.input === undefined ? {} : { argumentSchema: { type: "string", hint: command.input.hint } }),
				risk: "normal",
				effect: "session",
				contractTestId: `CMD-${command.source.toUpperCase()}-${command.name.toUpperCase().replaceAll("-", "_")}`,
			});
		}
		this.#current = this.#replace(commands);
		return this.manifest();
	}

	async invoke(commandId: string, args: unknown): Promise<unknown> {
		const descriptor = this.#commandsById.get(commandId);
		const name =
			descriptor?.name ?? (commandId.startsWith("builtin.") ? commandId.slice("builtin.".length) : commandId);
		const command = lookupBuiltinSlashCommand(name);
		if (!command && descriptor === undefined) {
			throw new StudioCommandManifestError("COMMAND_UNKNOWN", `Unknown operator command ${commandId}`);
		}
		const argumentText = normalizeArguments(args);
		if (!command && descriptor !== undefined) return await this.#invokeDynamic(descriptor, argumentText);
		if (!command) throw new StudioCommandManifestError("COMMAND_UNKNOWN", `Unknown operator command ${commandId}`);
		if (!command.handle) {
			throw new StudioCommandManifestError("TERMINAL_REQUIRED", `/${command.name} requires the TUI`, {
				route: "tui.transfer",
				commandId: `builtin.${command.name}`,
			});
		}
		if (argumentText && !command.allowArgs) {
			throw new StudioCommandManifestError("INVALID_ARGUMENT", `/${command.name} does not accept arguments`);
		}
		const output: string[] = [];
		const runtime: SlashCommandRuntime = {
			session: this.session,
			sessionManager: this.session.sessionManager,
			settings: this.session.settings,
			cwd: this.session.sessionManager.getCwd(),
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {
				await this.session.refreshSkills();
				await this.refresh();
			},
		};
		const result = await command.handle(
			{ name: command.name, args: argumentText, text: `/${command.name}${argumentText ? ` ${argumentText}` : ""}` },
			runtime,
		);
		return { output, result: result ?? { consumed: true } };
	}

	#replace(commands: StudioOperatorCommand[]): StudioOperatorCommandManifest {
		const unclassifiedBuiltins: string[] = [];
		const hash = stableCommandManifestHash({ upstreamCommit: UPSTREAM_COMMIT, commands, unclassifiedBuiltins });
		this.#commandsById = new Map(commands.map(command => [command.id, command]));
		return {
			generatedAt: "1970-01-01T00:00:00.000Z",
			upstreamCommit: UPSTREAM_COMMIT,
			hash,
			commands,
			unclassifiedBuiltins,
		};
	}

	async #invokeDynamic(command: StudioOperatorCommand, argumentText: string): Promise<unknown> {
		const text = `/${command.name}${argumentText ? ` ${argumentText}` : ""}`;
		if (command.source === "skill") {
			const parsed = parseSkillInvocation(text);
			const skill =
				parsed === undefined ? undefined : this.session.skills.find(candidate => candidate.name === parsed.name);
			if (parsed === undefined || skill === undefined) {
				throw new StudioCommandManifestError("COMMAND_UNKNOWN", "Skill command is no longer available");
			}
			const built = await buildSkillPromptMessage(skill, parsed.args, "user");
			await this.session.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: built.message,
					display: true,
					details: built.details,
					attribution: "user",
				},
				{ streamingBehavior: "steer" },
			);
			return { queued: true, source: command.source };
		}
		const started = await this.session.prompt(text);
		return { started, consumed: !started, source: command.source };
	}
}

function manifestSource(
	source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file",
): StudioOperatorCommand["source"] {
	switch (source) {
		case "custom":
		case "mcp_prompt":
			return "prompt-template";
		case "file":
			return "file-command";
		default:
			return source;
	}
}

function builtinDescriptor(command: (typeof BUILTIN_SLASH_COMMANDS_INTERNAL)[number]): StudioOperatorCommand {
	return {
		id: `builtin.${command.name}`,
		name: command.name,
		aliases: [...(command.aliases ?? [])],
		description: command.description,
		source: "builtin",
		implementation: command.handle ? "headless-handle" : "tui-compatibility",
		interactionKinds: [],
		presentation: command.handle ? "generic-form" : "terminal",
		availability: "available",
		...(command.inlineHint === undefined
			? {}
			: { argumentSchema: { type: "string" as const, hint: command.inlineHint } }),
		risk: DESTRUCTIVE.has(command.name) ? "destructive" : "normal",
		effect: READ_ONLY.has(command.name) ? "read" : "session",
		contractTestId: `CMD-BUILTIN-${command.name.toUpperCase().replaceAll("-", "_")}`,
	};
}

function stableCommandManifestHash(value: {
	upstreamCommit: string;
	commands: StudioOperatorCommand[];
	unclassifiedBuiltins: string[];
}): string {
	return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function normalizeArguments(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value.trim();
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const keys = Object.keys(value);
		if (keys.length === 1 && keys[0] === "args" && typeof (value as { args?: unknown }).args === "string") {
			return (value as { args: string }).args.trim();
		}
	}
	throw new StudioCommandManifestError("INVALID_ARGUMENT", "Operator command arguments must be a string or {args}");
}
