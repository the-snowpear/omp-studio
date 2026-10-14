import { expect, test, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { TempDir, getAgentDir, setAgentDir, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { Settings } from "../src/config/settings";
import { cfgTaskAgentAccountPools, cfgWorktreeOnStart } from "../src/task/settings";
import { cfgComposerPredictions } from "../src/modes/settings";
import { cfgRetryFallbackOn } from "../src/session/settings";
import { SessionManager } from "../src/session/session-manager";
import { resetSessionIndexForTests } from "../src/session/session-index";
import type { AgentSession } from "../src/session/agent-session";
import { StudioFeatureSettingsService } from "../src/studio/services/feature-settings-service";
import { StudioSessionPortabilityService } from "../src/studio/services/session-portability-service";
import { StudioSessionWorktreesService } from "../src/studio/services/session-worktrees-service";
import { StudioMediaFiles } from "../src/studio/services/media-files";
import { StudioMessagePrediction } from "../src/studio/services/message-prediction";
import { StudioSessionCompressionService } from "../src/studio/services/session-compression-service";
import type { PortableExport, SessionImportPreview } from "../src/studio/session-portability-protocol";
import type { SessionWorktreeRow, WorktreeRemovalPreview } from "../src/studio/session-worktrees-protocol";
import type { AgentSessionEvent } from "../src/session/agent-session-events";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { makeAssistantMessage } from "./session-manager/helpers";
import { requestService } from "../src/launch/services";
import { sharedBrowserDaemonName } from "../src/tools/browser/shared-daemon";
import type { ToolSession } from "../src/tools";

test.each([true, false])("typed service controls cannot detach a shared browser (headless=%s)", async headless => {
	await expect(
		requestService({} as ToolSession, { op: "mode", name: sharedBrowserDaemonName(headless), mode: "detached" }),
	).rejects.toThrow("cannot be detached");
});

test("feature settings preserve an empty account pool, reject malformed restrictions, and fence a session switch", async () => {
	const settings = Settings.isolated();
	const session = { sessionId: "main", settings } as AgentSession;
	const service = new StudioFeatureSettingsService(session);
	await service.execute({
		kind: "preferences.features.set",
		sessionId: "main",
		key: "task.agentAccountPools",
		scope: "session",
		value: { reviewer: { anthropic: [] } },
	});
	expect(cfgTaskAgentAccountPools.get(settings).reviewer?.anthropic).toEqual([]);
	await expect(
		service.execute({
			kind: "preferences.features.set",
			sessionId: "main",
			key: "task.agentAccountPools",
			scope: "session",
			value: { reviewer: { anthropic: "all" } },
		}),
	).rejects.toThrow();
	expect(cfgTaskAgentAccountPools.get(settings).reviewer?.anthropic).toEqual([]);
	await service.execute({
		kind: "preferences.features.set",
		sessionId: "main",
		key: "retry.fallbackOn",
		scope: "session",
		value: "usage-limit",
	});
	expect(cfgRetryFallbackOn.get(settings)).toBe("usage-limit");
	await expect(
		service.execute({
			kind: "preferences.features.set",
			sessionId: "stale",
			key: "retry.fallbackOn",
			scope: "session",
			value: "any",
		}),
	).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	expect(cfgRetryFallbackOn.get(settings)).toBe("usage-limit");
});

test("session archives import as forks without overwriting the source, and anonymous exports remove user prose", async () => {
	const temp = TempDir.createSync("@studio-portability-"),
		originalAgentDir = getAgentDir(),
		originalEnv = process.env.PI_CODING_AGENT_DIR;
	let manager: SessionManager | undefined;
	let service: StudioSessionPortabilityService | undefined;
	try {
		setAgentDir(temp.join("agent"));
		const cwd = temp.join("workspace");
		await fs.mkdir(cwd);
		manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: "private customer text 87419", timestamp: 1 });
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		const sessionId = manager.getSessionId(),
			sourceFile = manager.getSessionFile()!;
		const source = await fs.readFile(sourceFile);
		const media = new StudioMediaFiles(temp.join("media"));
		const session = {
			sessionId,
			sessionManager: manager,
			settings: Settings.isolated(),
			isStreaming: false,
			isCompacting: false,
		} as AgentSession;
		service = new StudioSessionPortabilityService(session, media);
		const packed = (await service.execute({
			kind: "session.portability.pack",
			sessionId,
			targetSessionId: sessionId,
		})) as PortableExport;
		const outputDirectory = path.join(
			media.directory,
			"outputs",
			createHash("sha256").update(sessionId).digest("hex"),
		);
		const bytes = await fs.readFile(path.join(outputDirectory, packed.asset.artifactId + ".bin"));
		const transferId = crypto.randomUUID(),
			artifactId = crypto.randomUUID(),
			inputs = path.join(media.directory, "inputs");
		await fs.mkdir(inputs, { recursive: true });
		await fs.writeFile(path.join(inputs, transferId + ".bin"), bytes);
		await fs.writeFile(
			path.join(inputs, transferId + ".json"),
			JSON.stringify({
				artifactId: transferId,
				name: "session.tar",
				kind: "transcript",
				mimeType: "application/x-tar",
				bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			}),
		);
		const review = (await service.execute({
			kind: "session.portability.prepare",
			sessionId,
			artifactId,
			targetCwd: cwd,
			inputTransfers: [{ artifactId, transferId }],
		})) as SessionImportPreview;
		expect(review.conflicts).toBe(true);
		const imported = (await service.execute({
			kind: "session.portability.import",
			sessionId,
			token: review.token,
		})) as { sessionId: string; mode: string };
		expect(imported.mode).toBe("forked");
		expect(imported.sessionId).not.toBe(sessionId);
		expect(await fs.readFile(sourceFile)).toEqual(source);
		await expect(
			service.execute({ kind: "session.portability.import", sessionId, token: review.token }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const anonymous = (await service.execute({
			kind: "session.portability.anonymize",
			sessionId,
			targetSessionId: sessionId,
		})) as PortableExport;
		const contents = await readArchiveEntries({
			path: path.join(outputDirectory, anonymous.asset.artifactId + ".bin"),
			format: "zip",
		});
		const text = [...contents.values()].map(value => new TextDecoder().decode(value)).join("\n");
		expect(text).not.toContain("private customer text 87419");
		expect(text).toContain("redacted");
	} finally {
		service?.dispose();
		await manager?.close();
		resetSessionIndexForTests();
		setAgentDir(originalAgentDir);
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		await temp.remove();
	}
});

test("worktree removal preserves files changed after review and startup policy fences the first prompt", async () => {
	const temp = TempDir.createSync("@studio-worktrees-"),
		originalAgentDir = getAgentDir(),
		originalEnv = process.env.PI_CODING_AGENT_DIR,
		originalWorktrees = process.env.OMP_WORKTREE_DIR;
	let manager: SessionManager | undefined;
	let service: StudioSessionWorktreesService | undefined;
	const git = (cwd: string, ...args: string[]) => {
		const result = Bun.spawnSync(
			["git", "-c", "user.name=Studio Test", "-c", "user.email=test@example.test", ...args],
			{ cwd, stdout: "pipe", stderr: "pipe" },
		);
		if (result.exitCode) throw Error(result.stderr.toString());
	};
	try {
		setAgentDir(temp.join("agent"));
		setWorktreesDir(temp.join("wt"));
		const cwd = temp.join("repo");
		await fs.mkdir(cwd);
		git(cwd, "init", "-q", "-b", "main");
		await fs.writeFile(path.join(cwd, "source.txt"), "source\n");
		git(cwd, "add", ".");
		git(cwd, "commit", "-qm", "initial");
		manager = SessionManager.create(cwd);
		const settings = Settings.isolated();
		cfgWorktreeOnStart.override(settings, "ask");
		const session = {
			sessionId: manager.getSessionId(),
			sessionManager: manager,
			messages: [],
			settings,
			isStreaming: false,
			isCompacting: false,
		} as unknown as AgentSession;
		service = new StudioSessionWorktreesService(session);
		await expect(service.ensureStartResolved()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		await service.execute({ kind: "worktrees.session.continueHere", sessionId: session.sessionId });
		await service.ensureStartResolved();
		const created = (await service.execute({
			kind: "worktrees.session.create",
			sessionId: session.sessionId,
			branch: "wt/review-test",
			keepChanges: false,
		})) as { worktree: SessionWorktreeRow };
		const review = (await service.execute({
			kind: "worktrees.session.remove.prepare",
			sessionId: session.sessionId,
			id: created.worktree.id,
		})) as WorktreeRemovalPreview;
		await fs.writeFile(path.join(created.worktree.directory, "new-work.txt"), "do not remove");
		const result = (await service.execute({
			kind: "worktrees.session.remove.apply",
			sessionId: session.sessionId,
			token: review.token,
		})) as { removed: boolean; messages: string[] };
		expect(result.removed).toBe(false);
		expect(result.messages.join(" ")).toContain("changed");
		expect(await fs.readFile(path.join(created.worktree.directory, "new-work.txt"), "utf8")).toBe("do not remove");
		await expect(
			service.execute({
				kind: "worktrees.session.remove.prepare",
				sessionId: session.sessionId,
				id: created.worktree.id,
			}),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	} finally {
		service?.dispose();
		await manager?.close();
		resetSessionIndexForTests();
		setWorktreesDir(undefined);
		if (originalWorktrees === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = originalWorktrees;
		setAgentDir(originalAgentDir);
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		await temp.remove();
	}
});

test("message suggestions are opt-in, cancel when a draft appears, and still account for a late reply", async () => {
	const settings = Settings.isolated();
	const reply = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
	const usage = mock(() => {}),
		publish = mock(() => {}),
		run = mock(() => reply.promise);
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "Completed" }],
		timestamp: 1,
	} as AssistantMessage;
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		sessionId: "main",
		settings,
		model: { id: "test" },
		messages: [assistant],
		isStreaming: false,
		isCompacting: false,
		ephemeralMaxTokensPreservesRequest: () => true,
		runEphemeralTurn: run,
		waitForIdle: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sessionManager: { getSessionId: () => "main", getLeafId: () => "leaf", appendModelUsage: usage },
	} as unknown as AgentSession;
	const service = new StudioMessagePrediction(session, publish);
	try {
		service.update("channel", 1, true);
		expect(run).not.toHaveBeenCalled();
		cfgComposerPredictions.override(settings, true);
		service.update("channel", 2, true);
		expect(run).toHaveBeenCalledTimes(1);
		const request = run.mock.calls[0] as unknown as [{ signal: AbortSignal }];
		service.update("channel", 3, false);
		expect(request[0].signal.aborted).toBe(true);
		publish.mockClear();
		reply.resolve({
			replyText: "Add regression coverage",
			assistantMessage: {
				...assistant,
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
			},
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(publish).not.toHaveBeenCalled();
		expect(usage).toHaveBeenCalledTimes(1);
	} finally {
		service.dispose();
	}
	expect(listeners.size).toBe(0);
});

test("compression rechecks reviewed files and leaves compressed session bytes readable", async () => {
	const temp = TempDir.createSync("@studio-compression-"),
		originalAgentDir = getAgentDir(),
		originalEnv = process.env.PI_CODING_AGENT_DIR;
	let manager: SessionManager | undefined;
	let service: StudioSessionCompressionService | undefined;
	try {
		setAgentDir(temp.join("agent"));
		const cwd = temp.join("workspace");
		await fs.mkdir(cwd);
		manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: "compressible session content ".repeat(10000), timestamp: 1 });
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		const file = manager.getSessionFile()!;
		await manager.close();
		manager = undefined;
		const old = new Date(Date.now() - 10 * 86400000);
		await fs.utimes(file, old, old);
		service = new StudioSessionCompressionService({
			sessionId: "maintenance",
			settings: Settings.isolated(),
		} as AgentSession);
		const scan = await service.execute({ kind: "maintenance.compression.scan", sessionId: "maintenance" });
		if (!scan.summary?.supported) {
			expect(scan.phase).toBe("complete");
			expect(scan.token).toBeUndefined();
			await expect(
				service.execute({
					kind: "maintenance.compression.apply",
					sessionId: "maintenance",
					token: crypto.randomUUID(),
				}),
			).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
			return;
		}
		expect(scan.summary.candidates).toBeGreaterThan(0);
		await fs.appendFile(file, "\n");
		const skipped = await service.execute({
			kind: "maintenance.compression.apply",
			sessionId: "maintenance",
			token: scan.token!,
		});
		expect(skipped.summary?.compressed).toBe(0);
		const before = await fs.readFile(file);
		await fs.utimes(file, old, old);
		const fresh = await service.execute({ kind: "maintenance.compression.scan", sessionId: "maintenance" });
		const applied = await service.execute({
			kind: "maintenance.compression.apply",
			sessionId: "maintenance",
			token: fresh.token!,
		});
		expect(applied.summary?.errors).toEqual([]);
		expect(applied.summary?.compressed).toBeGreaterThan(0);
		expect(await fs.readFile(file)).toEqual(before);
		await expect(
			service.execute({ kind: "maintenance.compression.apply", sessionId: "maintenance", token: fresh.token! }),
		).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	} finally {
		service?.dispose();
		await manager?.close();
		resetSessionIndexForTests();
		setAgentDir(originalAgentDir);
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		await temp.remove();
	}
});
