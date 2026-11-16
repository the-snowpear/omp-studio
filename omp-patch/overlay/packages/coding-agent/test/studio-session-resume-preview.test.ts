import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir, getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { closeSessionIndex } from "../src/session/session-index";
import { cfgSessionWorktreeScope } from "../src/session/settings";
import { StudioSessionWorktreesService } from "../src/studio/services/session-worktrees-service";
import type { SessionWorktreeResultMap } from "../src/studio/session-worktrees-protocol";
import { makeAssistantMessage } from "./session-manager/helpers";

test("resume preview uses the saved native conversation and configured scope without changing the session", async () => {
	const temp = TempDir.createSync("@studio-resume-preview-");
	const originalAgentDir = getAgentDir();
	const originalEnv = process.env.PI_CODING_AGENT_DIR;
	let manager: SessionManager | undefined;
	let service: StudioSessionWorktreesService | undefined;
	try {
		setAgentDir(temp.join("agent"));
		const cwd = temp.join("workspace");
		await fs.mkdir(cwd);
		manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: "Check the recovered attachments. ".repeat(50), timestamp: 1 });
		manager.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "text", text: "The saved attachments are ready." }],
		});
		await manager.flush();
		await manager.setSessionName("Attachment recovery", "user");
		const before = await fs.readFile(manager.getSessionFile()!);
		const settings = Settings.isolated();
		cfgSessionWorktreeScope.override(settings, "directory");
		const session = { sessionId: manager.getSessionId(), sessionManager: manager, settings } as AgentSession;
		service = new StudioSessionWorktreesService(session);
		const result = (await service.execute({
			kind: "worktrees.session.resume.list",
			sessionId: session.sessionId,
		})) as SessionWorktreeResultMap["worktrees.session.resume.list"];
		expect(result.scope).toBe("directory");
		const row = result.sessions.find(item => item.sessionId === session.sessionId)!;
		expect(row).toMatchObject({
			title: "Attachment recovery",
			currentDirectory: true,
			directoryName: "workspace",
			messageCount: 2,
			status: "complete",
			conversationExcerpt: "The saved attachments are ready.",
		});
		expect(row.firstMessage).toStartWith("Check the recovered attachments.");
		expect(row.firstMessage).toEndWith("…");
		expect(await fs.readFile(manager.getSessionFile()!)).toEqual(before);
	} finally {
		service?.dispose();
		await manager?.close();
		closeSessionIndex();
		setAgentDir(originalAgentDir);
		if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		await temp.remove();
	}
});

for (const stranded of [false, true]) {
	test(`resume preparation keeps missing recorded cwd separate from ${stranded ? "a native-proven current workspace" : "an explicitly chosen execution workspace"}`, async () => {
		const temp = TempDir.createSync("@studio-resume-cwd-");
		const originalAgentDir = getAgentDir();
		const originalEnv = process.env.PI_CODING_AGENT_DIR;
		let manager: SessionManager | undefined;
		let service: StudioSessionWorktreesService | undefined;
		try {
			setAgentDir(temp.join("agent"));
			const recordedCwd = temp.join("removed-worktree");
			const executionCwd = temp.join("chosen-workspace");
			await fs.mkdir(recordedCwd);
			await fs.mkdir(executionCwd);
			// A native /wt session can retain the originating checkout's bucket.
			const currentCwd = stranded ? executionCwd : recordedCwd;
			manager = SessionManager.create(recordedCwd, SessionManager.getDefaultSessionDir(currentCwd));
			manager.appendMessage({ role: "user", content: "Keep my saved conversation", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage());
			await manager.flush();
			const sessionFile = manager.getSessionFile()!;
			const targetSessionId = manager.getSessionId();
			await manager.close();
			manager = undefined;
			const original = await Bun.file(sessionFile).text();
			const session = {
				sessionId: "reader",
				sessionManager: { getCwd: () => currentCwd },
				settings: Settings.isolated(),
			} as unknown as AgentSession;
			service = new StudioSessionWorktreesService(session);
			const operation = {
				kind: "worktrees.session.resume.prepare" as const,
				sessionId: session.sessionId,
				targetSessionId,
				scope: "directory" as const,
			};
			// A still-existing saved directory cannot be silently re-rooted elsewhere.
			await expect(service.execute({ ...operation, executionCwd })).rejects.toMatchObject({
				code: "INVALID_ARGUMENT",
			});
			await fs.rm(recordedCwd, { recursive: true });
			const missing = (await service.execute(
				operation,
			)) as SessionWorktreeResultMap["worktrees.session.resume.prepare"];
			expect(missing.recordedCwd).toBe(recordedCwd);
			expect(missing.cwd).toBe(recordedCwd);
			expect(missing.requiresWorkspaceSelection).toBe(!stranded);
			expect(missing.executionCwd).toBe(stranded ? await fs.realpath(executionCwd) : undefined);
			await expect(
				service.execute({ ...operation, executionCwd: path.join(executionCwd, "missing") }),
			).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
			const chosen = (await service.execute({
				...operation,
				executionWorkspaceId: "chosen",
				executionCwd,
			})) as SessionWorktreeResultMap["worktrees.session.resume.prepare"];
			expect(chosen).toMatchObject({
				targetSessionId,
				requestedSessionId: targetSessionId,
				recordedCwd,
				cwd: recordedCwd,
				executionCwd: await fs.realpath(executionCwd),
				requiresWorkspaceSelection: false,
			});
			expect(await fs.lstat(recordedCwd).catch(() => undefined)).toBeUndefined();
			expect(await Bun.file(sessionFile).text()).toBe(original);
			expect(session.sessionId).toBe("reader");
		} finally {
			service?.dispose();
			await manager?.close();
			closeSessionIndex();
			setAgentDir(originalAgentDir);
			if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalEnv;
			await temp.remove();
		}
	});
}
