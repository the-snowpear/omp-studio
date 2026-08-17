import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";

import { SessionArchiveServiceError, StudioSessionArchiveService } from "../src/index.js";

async function fixture(): Promise<{
  root: string;
  workspace: string;
  sessionsRoot: string;
  archiveRoot: string;
  sessionFile: string;
  artifactsDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-archive-svc-"));
  const workspace = join(root, "workspace");
  const sessionsRoot = join(root, "agent", "sessions");
  const archiveRoot = join(root, "agent", "archive", "sessions");
  const projectDir = join(sessionsRoot, "--project--");
  await mkdir(workspace);
  await mkdir(projectDir, { recursive: true });
  const stem = "2026-08-16T10-00-00-000Z_session-a";
  const sessionFile = join(projectDir, `${stem}.jsonl`);
  const artifactsDir = join(projectDir, stem);
  await writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session", version: 3, id: "session-a", cwd: workspace, timestamp: "2026-08-16T10:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "m-1", parentId: null, timestamp: "2026-08-16T10:00:01.000Z", message: { role: "user", content: "hello" } }),
    ].join("\n") + "\n",
    "utf8",
  );
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, "tool-output.txt"), "artifact", "utf8");
  // 真实会话不是刚写入的：把 mtime 拨到宽限期之前，避免默认 60 秒宽限期
  // 把测试 fixture 当成「崩溃写者」误拒。
  const old = new Date(Date.now() - 3_600_000);
  await utimes(sessionFile, old, old);
  return { root, workspace, sessionsRoot, archiveRoot, sessionFile, artifactsDir };
}

function service(options: {
  workspace: string;
  sessionsRoot: string;
  archiveRoot: string;
  isResident?: (sessionId: string) => boolean;
  writeGraceMs?: number;
  now?: () => Date;
}): StudioSessionArchiveService {
  return new StudioSessionArchiveService({
    allowedCwd: options.workspace,
    sessionsRoot: options.sessionsRoot,
    archiveRoot: options.archiveRoot,
    ...(options.isResident === undefined ? {} : { isResident: options.isResident }),
    writeGraceMs: options.writeGraceMs ?? 0,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string {
  assert.ok(error instanceof SessionArchiveServiceError, `expected SessionArchiveServiceError, got ${String(error)}`);
  return error.code;
}

test("archive moves the session (gzip) and artifacts into the cold-archive tree, unarchive restores them", async () => {
  const seed = await fixture();
  try {
    const svc = service(seed);
    const result = await svc.archive("session-a");
    assert.deepEqual(result, { sessionId: "session-a", archived: true });

    const gz = join(seed.archiveRoot, "--project--", "2026-08-16T10-00-00-000Z_session-a.jsonl.gz");
    assert.ok(await exists(gz), "compressed archive exists");
    assert.ok(!(await exists(seed.sessionFile)), "original session file is gone");
    const artifacts = join(seed.archiveRoot, "--project--", "2026-08-16T10-00-00-000Z_session-a");
    assert.ok(await exists(join(artifacts, "tool-output.txt")), "artifacts moved with the session");
    assert.equal(gunzipSync(await readFile(gz)).toString("utf8").includes('"session-a"'), true, "gzip round-trips the JSONL");

    const restored = await svc.unarchive("session-a");
    assert.deepEqual(restored, { sessionId: "session-a", archived: false });
    assert.ok(await exists(seed.sessionFile), "session file is restored");
    assert.ok(!(await exists(gz)), "compressed member is removed");
    assert.ok(await exists(join(seed.artifactsDir, "tool-output.txt")), "artifacts are restored");
    const files = await readdir(join(seed.archiveRoot, "--project--"));
    assert.deepEqual(files, [], "archive tree is empty again");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive refuses a session that is resident in a Runtime", async () => {
  const seed = await fixture();
  try {
    const svc = service({ ...seed, isResident: (sessionId) => sessionId === "session-a" });
    assert.equal(errorCode(await svc.archive("session-a").catch((error) => error)), "SESSION_RESIDENT");
    assert.ok(await exists(seed.sessionFile), "session file is untouched");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive respects the crash-writer grace window", async () => {
  const seed = await fixture();
  try {
    // Simulate a fresh write (e.g. a live session being appended right now):
    // the fixture's aged mtime is overwritten with a recent one.
    const fresh = new Date();
    await utimes(seed.sessionFile, fresh, fresh);
    const svc = new StudioSessionArchiveService({ allowedCwd: seed.workspace, sessionsRoot: seed.sessionsRoot, archiveRoot: seed.archiveRoot, writeGraceMs: 60_000 });
    assert.equal(errorCode(await svc.archive("session-a").catch((error) => error)), "SESSION_RECENTLY_WRITTEN");
    const forced = await svc.archive("session-a", { skipWriteGrace: true });
    assert.equal(forced.archived, true);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive refuses while a fresh gc lock is held but ignores a stale one", async () => {
  const seed = await fixture();
  try {
    const lock = join(seed.root, "agent", "gc.lock");
    await writeFile(lock, "pid", "utf8");
    const svc = service(seed);
    assert.equal(errorCode(await svc.archive("session-a").catch((error) => error)), "GC_LOCK_HELD");

    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(lock, stale, stale);
    const result = await svc.archive("session-a");
    assert.equal(result.archived, true);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive enforces the workspace boundary and rejects unknown or duplicated identities", async () => {
  const seed = await fixture();
  try {
    const svc = new StudioSessionArchiveService({ allowedCwd: join(seed.root, "other-workspace"), sessionsRoot: seed.sessionsRoot, archiveRoot: seed.archiveRoot, writeGraceMs: 0 });
    assert.equal(errorCode(await svc.archive("session-a").catch((error) => error)), "WORKSPACE_MISMATCH");

    const boundary = service(seed);
    assert.equal(errorCode(await boundary.archive("missing").catch((error) => error)), "SESSION_NOT_FOUND");
    assert.equal(errorCode(await boundary.unarchive("missing").catch((error) => error)), "SESSION_NOT_FOUND");

    const projectDir = join(seed.sessionsRoot, "--project--");
    await writeFile(
      join(projectDir, "2026-08-16T11-00-00-000Z_session-a.jsonl"),
      JSON.stringify({ type: "session", id: "session-a", cwd: seed.workspace, timestamp: "2026-08-16T11:00:00.000Z" }) + "\n",
      "utf8",
    );
    assert.equal(errorCode(await boundary.archive("session-a").catch((error) => error)), "SESSION_DUPLICATE");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("a double archive is reported instead of silently overwriting", async () => {
  const seed = await fixture();
  try {
    const svc = service(seed);
    await svc.archive("session-a");
    const gz = join(seed.archiveRoot, "--project--", "2026-08-16T10-00-00-000Z_session-a.jsonl.gz");
    const original = await readFile(gz);

    // Simulate the rollback failure mode: the source reappeared while the gz stays.
    await writeFile(seed.sessionFile, gunzipSync(original).toString("utf8"), "utf8");
    assert.equal(errorCode(await svc.archive("session-a").catch((error) => error)), "SESSION_ALREADY_ARCHIVED");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive and unarchive refuse when the destination path is occupied by unidentifiable data", async () => {
  const seed = await fixture();
  try {
    const svc = service(seed);
    const gz = join(seed.archiveRoot, "--project--", "2026-08-16T10-00-00-000Z_session-a.jsonl.gz");
    await mkdir(join(seed.archiveRoot, "--project--"), { recursive: true });
    await writeFile(gz, Buffer.from("not gzip, not identifiable"));
    assert.equal(errorCode(await svc.archive("session-a").catch((error) => error)), "DESTINATION_EXISTS");
    assert.ok(await exists(seed.sessionFile), "session file is untouched");
    await rm(gz, { force: true });

    await svc.archive("session-a");
    await writeFile(seed.sessionFile, "someone recreated the plain file", "utf8");
    assert.equal(errorCode(await svc.unarchive("session-a").catch((error) => error)), "DESTINATION_EXISTS");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("a corrupt archive member is treated as absent and never partially restored", async () => {
  const seed = await fixture();
  try {
    const svc = service(seed);
    await svc.archive("session-a");
    const gz = join(seed.archiveRoot, "--project--", "2026-08-16T10-00-00-000Z_session-a.jsonl.gz");
    await writeFile(gz, Buffer.from("this is not gzip"));
    // A corrupt member cannot be identified (its header is unreadable), so
    // locating it honestly reports the session as not archived.
    assert.equal(errorCode(await svc.unarchive("session-a").catch((error) => error)), "SESSION_NOT_FOUND");
    assert.ok(!(await exists(seed.sessionFile)), "no partial plain file is left behind");
    assert.ok(await exists(gz), "the gz member survives for manual recovery");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("a session can be re-archived immediately after unarchive without tripping the write grace window", async () => {
  const seed = await fixture();
  try {
    // Default 60s write grace: the restored file's mtime must be set back to
    // the transcript's last-active time so an immediate re-archive is allowed.
    const svc = new StudioSessionArchiveService({
      allowedCwd: seed.workspace,
      sessionsRoot: seed.sessionsRoot,
      archiveRoot: seed.archiveRoot,
    });
    await svc.archive("session-a");
    await svc.unarchive("session-a");
    const result = await svc.archive("session-a");
    assert.equal(result.archived, true);
    // The fresh gz must also carry the transcript's last-active time, so the
    // same session can keep cycling archive/unarchive without grace hits.
    const gz = await lstat(join(seed.archiveRoot, "--project--", "2026-08-16T10-00-00-000Z_session-a.jsonl.gz"));
    assert.ok(Math.abs(gz.mtimeMs - Date.parse("2026-08-16T10:00:01.000Z")) < 2_000, `gz mtime not restored: ${gz.mtimeMs}`);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("unarchive restores the session mtime from the transcript instead of the restore time", async () => {
  const seed = await fixture();
  try {
    const svc = service(seed);
    await svc.archive("session-a");
    await svc.unarchive("session-a");
    const metadata = await lstat(seed.sessionFile);
    const contentLast = Date.parse("2026-08-16T10:00:01.000Z");
    assert.ok(
      Math.abs(metadata.mtimeMs - contentLast) < 2_000,
      `expected mtime near ${contentLast}, got ${metadata.mtimeMs}`,
    );
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});
