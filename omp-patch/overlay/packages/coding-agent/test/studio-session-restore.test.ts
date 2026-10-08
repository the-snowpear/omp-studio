import { expect, test, spyOn } from "bun:test";
import { SessionManager } from "../src/session/session-manager";
import { MemorySessionStorage } from "../src/session/session-storage";
test("model inspection follows native role restore order without writes or a session writer lock", async () => {
	const manager = SessionManager.inMemory();
	manager.appendModelChange("missing/default", "default");
	manager.appendModelChange("missing/slow", "slow");
	manager.appendThinkingLevelChange("high");
	const storage = new MemorySessionStorage();
	const file = "/sessions/saved.jsonl";
	const source = [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n";
	storage.writeTextSync(file, source);
	const writes = spyOn(storage, "writeTextSync");
	try {
		const result = await SessionManager.peekRestoreModels(file, storage);
		expect(result).toEqual({
			sessionId: manager.getSessionId(),
			selectors: ["missing/slow", "missing/default"],
			thinking: "high",
		});
		expect(writes).not.toHaveBeenCalled();
		expect(await storage.readText(file)).toBe(source);
		await expect(SessionManager.peekRestoreModels("/sessions/absent.jsonl", storage)).rejects.toThrow();
	} finally {
		writes.mockRestore();
		await manager.close();
	}
});
test("model inspection rejects malformed history without repairing or replacing it", async () => {
	const storage = new MemorySessionStorage();
	const file = "/sessions/bad.jsonl";
	const source = "not a session\n";
	storage.writeTextSync(file, source);
	await expect(SessionManager.peekRestoreModels(file, storage)).rejects.toThrow(/incomplete|damaged/);
	expect(await storage.readText(file)).toBe(source);
});
