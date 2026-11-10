import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionArchiveWorkerPool } from "../src/session-archive-pool.js";

test("one lazy archive Worker serves pages and revisions across view lifetimes, and releases on Host shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-archive-pool-")), cwd = join(root, "workspace"), sessionsRoot = join(root, "sessions");
  await mkdir(cwd); await mkdir(sessionsRoot);
  const file = join(sessionsRoot, "session-a.jsonl");
  const message = (id: string, parentId: string | null) => JSON.stringify({ type: "message", id, parentId, timestamp: "2026-11-10T00:00:00Z", message: { role: "user", content: `message ${id}` } }) + "\n";
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "session-a", cwd, timestamp: "2026-11-10T00:00:00Z" }) + "\n" + message("a", null) + message("b", "a"));
  const pool = new SessionArchiveWorkerPool({ sessionsRoot, archiveRoot: join(root, "archive") });
  try {
    assert.equal(pool.diagnostics().workers, 0);
    const first = await pool.reader(cwd).readPage({ sessionId: "session-a", limit: 1 });
    assert.equal(first.items[0]?.itemId, "b");
    const older = await pool.reader(cwd).readPage({ sessionId: "session-a", cursor: first.olderCursor!, limit: 1 });
    assert.equal(older.items[0]?.itemId, "a");
    assert.equal(pool.diagnostics().workers, 1);
    assert.ok(pool.diagnostics().rawBytes! > 0);
    const cancelled = new AbortController();
    const discarded = pool.reader(cwd).readPage({ sessionId: "session-a" }, cancelled.signal);
    const rejected = assert.rejects(discarded, { name: "AbortError" }); cancelled.abort(); await rejected;
    await appendFile(file, message("c", "b"));
    const next = await pool.reader(cwd).readPage({ sessionId: "session-a" });
    assert.equal(next.items.length, 3);
    assert.notEqual(next.transcriptRevision, first.transcriptRevision);
    assert.equal((await pool.reader(cwd).readRevision("session-a")).transcriptRevision, next.transcriptRevision);
    const secondCwd = join(root, "second-workspace"); await mkdir(secondCwd);
    await writeFile(join(sessionsRoot, "session-b.jsonl"), JSON.stringify({ type: "session", version: 3, id: "session-b", cwd: secondCwd }) + "\n" + message("other", null));
    assert.equal((await pool.reader(secondCwd).readPage({ sessionId: "session-b" })).items[0]?.itemId, "other");
    assert.equal((await pool.reader(cwd).readPage({ sessionId: "session-a" })).items.length, 3);
    assert.equal(pool.diagnostics().indexedSessions, 2);
  } finally { await pool.dispose(); }
  assert.equal(pool.diagnostics().workers, 0);
});
