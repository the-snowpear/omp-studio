import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test, spyOn } from "bun:test";
import { SessionManager } from "../src/session/session-manager";
import { MemorySessionStorage } from "../src/session/session-storage";
import type { AgentSession } from "../src/session/agent-session";
import { StudioSessionTitlesService } from "../src/studio/services/session-titles-service";
import { validateSessionTitlesOperation, validateSessionTitlesResult } from "../src/studio/session-titles-protocol";
test("saved title metadata follows the latest native rename and never changes the session identity or saved bytes", async () => {
	const manager = SessionManager.inMemory(),
		storage = new MemorySessionStorage(),
		file = "/sessions/title.jsonl";
	const id = manager.getSessionId();
	try {
		await manager.setSessionName("Inspect stale locks", "auto", "test", { code: "LOCK", emoji: "🔒" });
		const snapshot = () =>
			[manager.getHeader(), ...manager.getEntries()].map(row => JSON.stringify(row)).join("\n") + "\n";
		const source = snapshot();
		storage.writeTextSync(file, source);
		const writes = spyOn(storage, "writeTextSync");
		try {
			expect(await SessionManager.peekSessionTitle(file, storage)).toEqual({
				sessionId: id,
				title: "Inspect stale locks",
				source: "auto",
				card: { code: "LOCK", emoji: "🔒" },
			});
			expect(writes).not.toHaveBeenCalled();
			expect(await storage.readText(file)).toBe(source);
		} finally {
			writes.mockRestore();
		}
		await manager.setSessionName("My investigation", "user");
		storage.writeTextSync(file, snapshot());
		expect(await SessionManager.peekSessionTitle(file, storage)).toEqual({
			sessionId: id,
			title: "My investigation",
			source: "user",
		});
		expect(manager.getSessionId()).toBe(id);
		storage.writeTextSync(file, "damaged\n");
		await expect(SessionManager.peekSessionTitle(file, storage)).rejects.toThrow(/damaged|incomplete/);
	} finally {
		await manager.close();
	}
});
test("title query rejects a different session and malformed targets instead of opening them", async () => {
	const manager = SessionManager.inMemory(),
		id = manager.getSessionId();
	const session = { sessionId: id, sessionManager: manager } as unknown as AgentSession;
	try {
		await manager.setSessionName("Preview title", "auto", "test", { code: "CARD", emoji: "🧩" });
		const service = new StudioSessionTitlesService(session);
		const operation = { kind: "session.titles.inspect", sessionId: id, targetSessionIds: [id] } as const;
		const result = await service.execute({ ...operation, targetSessionIds: [id] });
		validateSessionTitlesResult("session.titles.inspect", result);
		expect(result.rows[0]?.card?.code).toBe("CARD");
		await expect(service.execute({ ...operation, sessionId: "foreign", targetSessionIds: [id] })).rejects.toThrow(
			/Session changed/,
		);
		expect(() => validateSessionTitlesOperation({ ...operation, targetSessionIds: ["../private"] })).toThrow(
			/identity/,
		);
		expect(() => validateSessionTitlesOperation({ ...operation, targetSessionIds: [id, id] })).toThrow(/distinct/);
	} finally {
		await manager.close();
	}
});
test("title inspection refreshes persisted cards, excludes unknown identities, and rejects a session switch during catalog lookup", async () => {
	const folder = await fs.mkdtemp(path.join(os.tmpdir(), "studio-title-catalog-")),
		file = path.join(folder, "saved.jsonl"),
		manager = SessionManager.inMemory(),
		current = SessionManager.inMemory();
	const id = manager.getSessionId(),
		session = { sessionId: current.getSessionId(), sessionManager: current } as unknown as AgentSession;
	const listed = spyOn(SessionManager, "list").mockResolvedValue([
		{
			path: file,
			id,
			cwd: folder,
			created: new Date(),
			modified: new Date(),
			messageCount: 1,
			size: 0,
			firstMessage: "",
			allMessagesText: "",
		},
	]);
	try {
		const save = async () =>
			Bun.write(
				file,
				[manager.getHeader(), ...manager.getEntries()].map(row => JSON.stringify(row)).join("\n") + "\n",
			);
		await manager.setSessionName("Old title", "auto", "test", { code: "OLD", emoji: "🔎" });
		await save();
		const service = new StudioSessionTitlesService(session),
			operation = {
				kind: "session.titles.inspect",
				sessionId: session.sessionId,
				targetSessionIds: [id, "absent"],
			} as const;
		const first = await service.execute({ ...operation, targetSessionIds: [id, "absent"] });
		expect(first.rows[0]?.card?.code).toBe("OLD");
		expect(first.rows[1]?.state).toBe("missing");
		await manager.setSessionName("User renamed title", "user");
		await save();
		const next = await service.execute({ ...operation, targetSessionIds: [id] });
		expect(next.rows[0]?.title).toBe("User renamed title");
		expect(next.rows[0]?.card).toBeUndefined();
		const original = session.sessionId;
		listed.mockImplementation(async () => {
			Object.defineProperty(session, "sessionId", { value: "switched", configurable: true });
			return [];
		});
		await expect(
			service.execute({ kind: "session.titles.inspect", sessionId: original, targetSessionIds: [id] }),
		).rejects.toThrow(/Session changed/);
	} finally {
		listed.mockRestore();
		await manager.close();
		await current.close();
		await fs.rm(folder, { recursive: true, force: true });
	}
});
