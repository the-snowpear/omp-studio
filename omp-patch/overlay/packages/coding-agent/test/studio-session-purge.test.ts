import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { purgeDeletedSessionRows, type SessionPurgeDiagnostic } from "../src/session/session-db-purge";
import { SESSION_PURGE_WORKER_SELECTOR } from "../src/studio/session-purge-worker";
import type { StudioSessionPurgeResponse } from "../src/studio/session-lifecycle-protocol";

async function fixture(archived = false) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-purge-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	const directory = path.join(agentDir, ...(archived ? ["archive", "sessions"] : ["sessions"]), "--temporary--");
	await fs.mkdir(directory, { recursive: true });
	const sessionFile = path.join(directory, archived ? "source.jsonl.gz" : "source.jsonl");
	const content = `${JSON.stringify({ type: "session", id: "source", cwd: root })}\n`;
	await Bun.write(sessionFile, archived ? Bun.gzipSync(content) : content);
	const historyDbPath = path.join(agentDir, "history.db");
	const statsDbPath = path.join(home, ".omp", "stats.db");
	const childFile = path.join(directory, "source", "child.jsonl");
	using history = new Database(historyDbPath);
	history.run("CREATE TABLE history (id INTEGER PRIMARY KEY, session_id TEXT, text TEXT)");
	history.run("CREATE VIRTUAL TABLE history_fts USING fts5(text, content='history', content_rowid='id')");
	history.run("CREATE TABLE session_titles (session_id TEXT, title TEXT)");
	history.run("CREATE TABLE session_recaps (session_id TEXT, recap TEXT)");
	history.run("INSERT INTO history VALUES (1, 'source', 'deleteword'), (2, 'other', 'keepword')");
	history.run("INSERT INTO history_fts(history_fts) VALUES ('rebuild')");
	history.run("INSERT INTO session_titles VALUES ('source', 'gone'), ('other', 'retained')");
	history.run("INSERT INTO session_recaps VALUES ('source', 'gone'), ('other', 'retained')");
	using stats = new Database(statsDbPath);
	stats.run("CREATE TABLE messages (session_file TEXT, text TEXT)");
	stats.run("INSERT INTO messages VALUES (?, 'root'), (?, 'child'), (?, 'sibling')", [
		sessionFile,
		childFile,
		path.join(directory, "source-other", "other.jsonl"),
	]);
	return { root, home, agentDir, sessionFile, historyDbPath, statsDbPath, childFile };
}

function remainingHistory(file: string): string[] {
	using db = new Database(file, { readonly: true });
	return (db.query("SELECT session_id FROM history ORDER BY id").all() as { session_id: string }[]).map(
		row => row.session_id,
	);
}
function remainingStats(file: string): string[] {
	using db = new Database(file, { readonly: true });
	return (db.query("SELECT text FROM messages").all() as { text: string }[]).map(row => row.text);
}

test("native purge removes prompts, titles, recaps, FTS and nested stats without touching another session", async () => {
	const files = await fixture();
	try {
		let diagnostic: SessionPurgeDiagnostic | undefined;
		const result = purgeDeletedSessionRows(files.sessionFile, {
			...files,
			onDiagnostic: value => {
				diagnostic = value;
			},
		});
		expect(result).toBeUndefined();
		expect(diagnostic).toMatchObject({ history: { status: "purged" }, stats: { status: "purged" } });
		expect(remainingHistory(files.historyDbPath)).toEqual(["other"]);
		expect(remainingStats(files.statsDbPath)).toEqual(["sibling"]);
		using history = new Database(files.historyDbPath, { readonly: true });
		expect(history.query("SELECT session_id FROM session_titles").all()).toEqual([{ session_id: "other" }]);
		expect(history.query("SELECT session_id FROM session_recaps").all()).toEqual([{ session_id: "other" }]);
		expect(history.query("SELECT rowid FROM history_fts WHERE history_fts MATCH 'deleteword'").all()).toEqual([]);
		expect(await Bun.file(files.sessionFile).exists()).toBe(true);
	} finally {
		await fs.rm(files.root, { recursive: true, force: true });
	}
});

for (const broken of ["history", "stats"] as const) {
	test(`native purge reports ${broken} failure but still cleans the independent store`, async () => {
		const files = await fixture();
		try {
			await Bun.write(broken === "history" ? files.historyDbPath : files.statsDbPath, "not a sqlite database");
			let diagnostic: SessionPurgeDiagnostic | undefined;
			purgeDeletedSessionRows(files.sessionFile, {
				...files,
				onDiagnostic: value => {
					diagnostic = value;
				},
			});
			expect(diagnostic?.[broken]).toEqual({ status: "failed", reason: "store-unavailable" });
			if (broken === "history") expect(remainingStats(files.statsDbPath)).toEqual(["sibling"]);
			else expect(remainingHistory(files.historyDbPath)).toEqual(["other"]);
			// A consumer diagnostic failure must not break legacy void delete callers.
			purgeDeletedSessionRows(files.sessionFile, {
				...files,
				onDiagnostic: () => {
					throw new Error("diagnostic unavailable");
				},
			});
			expect(await Bun.file(files.sessionFile).exists()).toBe(true);
		} finally {
			await fs.rm(files.root, { recursive: true, force: true });
		}
	});
}

test("the private CLI purge worker cleans an archived transcript in the selected profile without creating a chat", async () => {
	const files = await fixture(true);
	try {
		const roots = Object.fromEntries(
			["roaming", "local", "config", "cache", "data", "state", "temp"].map(name => [
				name,
				path.join(files.root, name),
			]),
		);
		await Promise.all(Object.values(roots).map(directory => fs.mkdir(directory)));
		const env: Record<string, string> = {
			HOME: files.home,
			USERPROFILE: files.home,
			PI_CODING_AGENT_DIR: files.agentDir,
			OMP_AGENT_DIR: files.agentDir,
			PI_CONFIG_DIR: ".omp",
			PI_PROFILE: "",
			OMP_PROFILE: "",
			PI_CONFIG_FILES: "",
			APPDATA: roots.roaming,
			LOCALAPPDATA: roots.local,
			XDG_CONFIG_HOME: roots.config,
			XDG_CACHE_HOME: roots.cache,
			XDG_DATA_HOME: roots.data,
			XDG_STATE_HOME: roots.state,
			TMP: roots.temp,
			TEMP: roots.temp,
			TMPDIR: roots.temp,
			DO_NOT_TRACK: "1",
		};
		for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"])
			if (process.env[name]) env[name] = process.env[name]!;
		const child = Bun.spawn(
			[process.execPath, path.resolve(import.meta.dir, "../src/cli.ts"), SESSION_PURGE_WORKER_SELECTOR],
			{
				cwd: files.root,
				env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		child.stdin.write(
			JSON.stringify({
				schemaVersion: 1,
				requestId: "purge-test",
				sessionId: "source",
				sessionFile: files.sessionFile,
				agentDir: files.agentDir,
			}),
		);
		child.stdin.end();
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
		const response = JSON.parse(stdout) as StudioSessionPurgeResponse;
		expect(response.requestId).toBe("purge-test");
		expect(response.result.status).toBe("complete");
		expect(remainingHistory(files.historyDbPath)).toEqual(["other"]);
		expect(remainingStats(files.statsDbPath)).toEqual(["sibling"]);
		expect(await fs.readdir(path.dirname(files.sessionFile))).toEqual(["source.jsonl.gz"]);
	} finally {
		await fs.rm(files.root, { recursive: true, force: true });
	}
});
