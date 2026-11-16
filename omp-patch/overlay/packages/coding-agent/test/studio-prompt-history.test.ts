import { afterEach, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { HistoryStorage } from "../src/session/history-storage";
import { StudioPromptHistoryService } from "../src/studio/services/prompt-history-service";
import type { PromptHistoryQueryResultMap } from "../src/studio/prompt-history-protocol";

afterEach(() => HistoryStorage.close());

test("prompt history keeps native scopes, reads complete text on demand, and deletes the selected FTS row", async () => {
	using temp = TempDir.createSync("@studio-prompt-history-");
	const history = HistoryStorage.open(temp.join("history.db"));
	const cwd = temp.join("project");
	await history.add("first prompt", cwd, "one");
	await history.add("other project prompt", temp.join("other"), "two");
	const longPrompt = `details ${"内容".repeat(400)}`;
	await history.add(longPrompt, cwd, "one");
	const session = { sessionId: "one", sessionManager: { getCwd: () => cwd } };
	const service = new StudioPromptHistoryService(session);
	const list = service.execute({
		kind: "history.prompts.list",
		sessionId: "one",
		scope: "workspace",
	}) as PromptHistoryQueryResultMap["history.prompts.list"];
	expect(list.items.map(item => item.id)).toEqual(history.getRecent(50, { cwd }).map(entry => entry.id));
	expect(list.items).toHaveLength(2);
	const item = list.items[0]!;
	expect(new TextEncoder().encode(item.preview).byteLength).toBeLessThanOrEqual(480);
	const reference = { sessionId: "one", scope: "workspace" as const, id: item.id, revision: item.revision };
	expect(service.execute({ kind: "history.prompts.read", ...reference })).toMatchObject({
		prompt: longPrompt,
		truncated: false,
	});
	expect(service.execute({ kind: "history.prompts.delete", ...reference })).toEqual({ id: item.id, deleted: true });
	expect(history.search("details", 20)).toEqual([]);
	expect(
		history
			.getRecent(20)
			.map(entry => entry.prompt)
			.sort(),
	).toEqual(["first prompt", "other project prompt"]);
	HistoryStorage.close();
});

test("resubmission and scope/session changes cannot delete the row the user no longer previewed", async () => {
	using temp = TempDir.createSync("@studio-history-revision-");
	const history = HistoryStorage.open(temp.join("history.db"));
	const cwd = temp.join("project");
	await history.add("repeat me", cwd, "one");
	const session = { sessionId: "one", sessionManager: { getCwd: () => cwd } };
	const service = new StudioPromptHistoryService(session);
	const list = service.execute({
		kind: "history.prompts.list",
		sessionId: "one",
	}) as PromptHistoryQueryResultMap["history.prompts.list"];
	const item = list.items[0]!;
	const old = history.getById(item.id)!;
	await history.add("repeat me", cwd, "one");
	expect(history.delete(item.id, old)).toBe(false);
	expect(() =>
		service.execute({
			kind: "history.prompts.delete",
			sessionId: "one",
			scope: "workspace",
			id: item.id,
			revision: item.revision,
		}),
	).toThrow("changed");
	expect(history.getById(item.id)?.useCount).toBe(2);
	session.sessionId = "new-session";
	expect(() =>
		service.execute({
			kind: "history.prompts.read",
			sessionId: "one",
			scope: "workspace",
			id: item.id,
			revision: item.revision,
		}),
	).toThrow("session changed");
	HistoryStorage.close();
});
