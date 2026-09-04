import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	StudioCommandManifestError,
	StudioCommandManifestService,
} from "@oh-my-pi/pi-coding-agent/studio/services/command-manifest-service";

function fixture(): { service: StudioCommandManifestService; forcedTools: string[] } {
	const forcedTools: string[] = [];
	const session = {
		sessionManager: { getCwd: () => "C:/workspace" },
		settings: {},
		refreshSkills: async () => {},
		setForcedToolChoice: (name: string) => forcedTools.push(name),
	} as unknown as AgentSession;
	return { service: new StudioCommandManifestService(session), forcedTools };
}

function titleFixture(initialTitle?: string, initialSource?: "auto" | "user") {
	let title = initialTitle;
	let source = initialSource;
	const setCalls: Array<{ title: string; source: "auto" | "user"; trigger?: string }> = [];
	const sessionManager = {
		getCwd: () => "C:/workspace",
		getSessionName: () => title,
		get titleSource() {
			return source;
		},
		setSessionName: async (nextTitle: string, nextSource: "auto" | "user", trigger?: string) => {
			setCalls.push({ title: nextTitle, source: nextSource, ...(trigger === undefined ? {} : { trigger }) });
			title = nextTitle;
			source = nextSource;
			return true;
		},
	};
	const session = { sessionManager, settings: {} } as unknown as AgentSession;
	return { service: new StudioCommandManifestService(session), setCalls, sessionManager };
}

const STUDIO_SESSION_TITLE_ENSURE_ID = "studio.session-title.ensure";

describe("WP-044 Studio command manifest", () => {
	test("classifies every builtin with a stable content hash", () => {
		const { service } = fixture();
		const first = service.manifest();
		const second = service.manifest();
		expect(first).toEqual(second);
		expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(first.hash).toBe(service.manifestHash());
		expect(first.commands).toHaveLength(BUILTIN_SLASH_COMMANDS_INTERNAL.length + 1);
		expect(new Set(first.commands.map(command => command.id)).size).toBe(first.commands.length);
		expect(first.unclassifiedBuiltins).toEqual([]);
		expect(first.commands.find(command => command.id === STUDIO_SESSION_TITLE_ENSURE_ID)).toMatchObject({
			implementation: "shared-service",
			presentation: "native",
			risk: "normal",
			effect: "session",
			contractTestId: "CMD-STUDIO-SESSION-TITLE-ENSURE",
		});
		expect(first.commands.find(command => command.id === "builtin.pause")).toMatchObject({
			implementation: "tui-compatibility",
			presentation: "terminal",
		});
	});

	test("invokes a headless builtin through the shared registry", async () => {
		const { service, forcedTools } = fixture();
		const result = await service.invoke("builtin.force", "read run the tests");
		expect(forcedTools).toEqual(["read"]);
		expect(result).toEqual({ output: ["Next turn forced to use read."], result: { prompt: "run the tests" } });
	});

	test("routes TUI-only builtins explicitly and rejects malformed invocation", async () => {
		const { service } = fixture();
		await expect(service.invoke("builtin.pause", undefined)).rejects.toMatchObject({
			code: "TERMINAL_REQUIRED",
			details: { route: "tui.transfer", commandId: "builtin.pause" },
		});
		await expect(service.invoke("builtin.missing", undefined)).rejects.toBeInstanceOf(StudioCommandManifestError);
		await expect(service.invoke("builtin.force", [])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
	});

	test("ensures a missing session title with an awaited auto persistence call", async () => {
		const { service, setCalls } = titleFixture();
		expect(await service.invoke(STUDIO_SESSION_TITLE_ENSURE_ID, "  Studio fallback  ")).toEqual({
			applied: true,
			title: "Studio fallback",
			source: "auto",
		});
		expect(setCalls).toEqual([{ title: "Studio fallback", source: "auto", trigger: "studio-provisional-fallback" }]);
	});

	test("does not overwrite an existing auto or user session title", async () => {
		for (const source of ["auto", "user"] as const) {
			const { service, setCalls } = titleFixture("Existing title", source);
			expect(await service.invoke(STUDIO_SESSION_TITLE_ENSURE_ID, "Replacement")).toEqual({
				applied: false,
				title: "Existing title",
				source,
			});
			expect(setCalls).toEqual([]);
		}
	});

	test("rejects an empty provisional session title", async () => {
		const { service } = titleFixture();
		await expect(service.invoke(STUDIO_SESSION_TITLE_ENSURE_ID, "   ")).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
	});

	test("refreshes and invokes extension and custom command routes from native registries", async () => {
		const prompts: string[] = [];
		const session = {
			sessionManager: { getCwd: () => process.cwd() },
			settings: {},
			extensionRunner: {
				getRegisteredCommands: () => [{ name: "ext:hello", description: "Extension hello" }],
			},
			customCommands: [
				{
					path: "custom.md",
					resolvedPath: "custom.md",
					source: "project",
					command: { name: "custom:hello", description: "Custom hello" },
				},
			],
			mcpPromptCommands: [],
			skills: [],
			setSlashCommands: () => {},
			prompt: async (text: string) => {
				prompts.push(text);
				return true;
			},
		} as unknown as AgentSession;
		const service = new StudioCommandManifestService(session);
		const before = service.manifestHash();
		const manifest = await service.refresh();
		expect(manifest.hash).not.toBe(before);
		expect(manifest.commands.find(command => command.id === "extension.ext:hello")).toMatchObject({
			implementation: "extension-command",
		});
		expect(manifest.commands.find(command => command.id === "prompt-template.custom:hello")).toMatchObject({
			source: "prompt-template",
			implementation: "headless-handle",
		});
		expect(await service.invoke("extension.ext:hello", "world")).toEqual({
			started: true,
			consumed: false,
			source: "extension",
		});
		expect(await service.invoke("prompt-template.custom:hello", { args: "team" })).toMatchObject({
			source: "prompt-template",
		});
		expect(prompts).toEqual(["/ext:hello world", "/custom:hello team"]);
	});
});
