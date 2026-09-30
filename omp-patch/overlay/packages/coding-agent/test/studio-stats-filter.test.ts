import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir, homedir } from "node:os";
import { getAgentDir, getStatsDbPath, setAgentDir } from "@oh-my-pi/pi-utils";
import { closeDb, initDb, insertMessageStats, insertToolCalls } from "@oh-my-pi/omp-stats/db";
import {
	withStudioStatsFilter,
	getOverallStats,
	getStatsByModel,
	getStatsByFolder,
	getToolStats,
	getSessionRollups,
	refreshRollups,
	getRollupStatus,
} from "@oh-my-pi/omp-stats/rollup";
import type { MessageStats, ToolCallStats } from "@oh-my-pi/omp-stats/types";
const originalAgentDir = getAgentDir();
const envKeys = ["PI_CONFIG_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "studio-stats-filter-"));
	for (const key of envKeys) delete process.env[key];
	process.env.PI_CONFIG_DIR = relative(homedir(), root);
	setAgentDir(join(root, "agent"));
	const target = relative(root, getStatsDbPath());
	if (target.startsWith("..") || target.includes(":")) throw Error("Stats test database escaped temporary namespace");
});
// Windows native SQLite handles can remain locked until process exit; retain OS temp fixtures.
afterEach(() => {
	closeDb();
	for (const key of envKeys) {
		if (prior[key] === undefined) delete process.env[key];
		else process.env[key] = prior[key];
	}
	setAgentDir(originalAgentDir);
});

test("native stats filters agree across raw and rolled messages and project tool statistics", async () => {
	await initDb();
	const timestamp = Date.now() - 7200000;
	const base: MessageStats = {
		sessionFile: "/a.jsonl",
		entryId: "a",
		folder: "/project/a",
		model: "one",
		provider: "p",
		api: "openai-responses",
		timestamp,
		duration: 100,
		ttft: 10,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		},
		agentType: "main",
	};
	insertMessageStats([
		base,
		{ ...base, sessionFile: "/b.jsonl", entryId: "b", folder: "/project/b" },
		{ ...base, sessionFile: "/c.jsonl", entryId: "c", model: "two", provider: "q" },
	]);
	const tool: ToolCallStats = {
		sessionFile: base.sessionFile,
		entryId: "a",
		toolCallId: "call-a",
		folder: base.folder,
		toolName: "read",
		model: base.model,
		provider: base.provider,
		timestamp,
		agentType: "main",
		callsInTurn: 1,
		argsChars: 10,
	};
	insertToolCalls([
		tool,
		{ ...tool, sessionFile: "/b.jsonl", entryId: "b", toolCallId: "call-b", folder: "/project/b" },
	]);
	const read = () =>
		withStudioStatsFilter({ folder: "/project/a", model: "one", provider: "p" }, () => ({
			overall: getOverallStats(),
			models: getStatsByModel(),
			folders: getStatsByFolder(),
			tools: getToolStats(),
		}));
	const before = read();
	expect(before.overall.totalRequests).toBe(1);
	expect(before.models).toHaveLength(1);
	expect(before.folders.map(row => row.folder)).toEqual(["/project/a"]);
	expect(before.tools).toHaveLength(1);
	await refreshRollups();
	expect(getRollupStatus().dirtyHours).toBe(0);
	expect(read()).toEqual(before);
	expect(getOverallStats().totalRequests).toBe(3);
	const sessions = withStudioStatsFilter({ folder: "/project/a", model: "one", provider: "p" }, () =>
		getSessionRollups(),
	);
	expect(sessions.map(row => row.sessionFile)).toEqual(["/a.jsonl"]);
	expect(sessions[0].requests).toBe(1);
	expect(withStudioStatsFilter({ folder: "/project/a" }, () => getSessionRollups(Date.now() - 3600000))).toHaveLength(
		0,
	);
	expect(() => withStudioStatsFilter({ model: "\0bad" }, () => getOverallStats())).toThrow();
});
