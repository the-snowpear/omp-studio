import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
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
