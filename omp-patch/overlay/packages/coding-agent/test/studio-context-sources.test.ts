import { afterEach, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Skill } from "../src/extensibility/skills";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { buildSystemPrompt } from "../src/system-prompt";
import { StudioContextViewService } from "../src/studio/services/context-view-service";

const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});
const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const skill: Skill = {
	name: "fixture",
	description: "Preserve source identity",
	filePath: "/fixture/SKILL.md",
	baseDir: "/fixture",
	source: "user",
};
const secret = "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef";

async function fixture(changed = false): Promise<StudioContextViewService> {
	const built = await buildSystemPrompt({
		cwd: import.meta.dir,
		personality: "none",
		activeRepoContext: null,
		customPrompt: `${"policy ".repeat(3450)}\n${secret}\n`,
		skills: [skill],
		contextFiles: Array.from({ length: 60 }, (_, index) => ({
			path: `/fixture/instructions-${index}.md`,
			content: `Unique instruction ${index}`,
		})),
	});
	const prompt = changed
		? built.systemPrompt.map(block => block.replace("Unique instruction 59", "Changed instruction 59"))
		: built.systemPrompt;
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: prompt, tools: [], messages: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry: new Map(),
		builtInToolNames: [],
		skills: [skill],
		systemPromptSources: built.sources,
	});
	sessions.push(session);
	return new StudioContextViewService(session);
}

test("redacted paged source markers locate the native entry even beyond the first list page", async () => {
	const service = await fixture();
	const index = service.execute({ kind: "context.view.open", sessionId: sessions[0]!.sessionId });
	const base = { sessionId: index.sessionId, snapshotId: index.snapshotId };
	const system = service.execute({ kind: "context.view.list", ...base, category: "system-prompt" });
	let sawSource = false;
	let paged = false;
	let intended: string | undefined;
	for (const entry of system.entries) {
		let offset: number | undefined;
		do {
			const page = service.execute({
				kind: "context.view.entry",
				...base,
				entryId: entry.id,
				...(offset === undefined ? {} : { offset }),
			});
			expect(page.text).not.toContain(secret);
			paged ||= page.nextOffset !== undefined;
			for (const marker of page.sourceMarkers ?? []) {
				const shown = page.text.slice(marker.start, marker.end);
				expect(shown.startsWith("[Shown in ")).toBe(true);
				expect(shown.endsWith("]")).toBe(true);
				expect(marker.entryId).toBeDefined();
				const source = service.execute({ kind: "context.view.entry", ...base, entryId: marker.entryId! });
				expect(source.text).not.toContain("[Shown in ");
				sawSource = true;
				if (shown.includes("instructions-59.md")) intended = marker.entryId;
			}
			if (page.nextOffset !== undefined) expect(page.nextOffset).toBeGreaterThan(offset ?? 0);
			offset = page.nextOffset;
		} while (offset !== undefined);
	}
	expect(sawSource).toBe(true);
	expect(paged).toBe(true);
	expect(intended).toBeDefined();
	const first = service.execute({ kind: "context.view.list", ...base, category: "instruction-files" });
	expect(first.entries.some(entry => entry.id === intended)).toBe(false);
	const focused = service.execute({
		kind: "context.view.list",
		...base,
		category: "instruction-files",
		focusEntryId: intended!,
	});
	expect(focused.entries.some(entry => entry.id === intended)).toBe(true);
	expect(service.execute({ kind: "context.view.entry", ...base, entryId: intended! }).text).toContain(
		"Unique instruction 59",
	);
});

test("a changed native source remains in System Prompt with its caveat instead of a fabricated relocated entry", async () => {
	const service = await fixture(true);
	const index = service.execute({ kind: "context.view.open", sessionId: sessions[0]!.sessionId });
	expect(index.notices?.some(notice => notice.includes("system prompt changed"))).toBe(true);
	const listed = service.execute({
		kind: "context.view.list",
		sessionId: index.sessionId,
		snapshotId: index.snapshotId,
		category: "instruction-files",
		search: "instructions-59.md",
	});
	expect(listed.entries).toEqual([]);
});
