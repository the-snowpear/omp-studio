import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { SessionDeleteServiceError, StudioSessionDeleteService, removeSessionPin, type SessionDeleteServiceOptions } from "../src/index.js";

function gzSession(id: string, cwd: string): Buffer {
  return gzipSync(
    `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-08-16T10:00:00.000Z" })}\n`,
  );
}

async function fixture(): Promise<{
  root: string;
  workspace: string;
  sessionsRoot: string;
  archiveRoot: string;
  sessionFile: string;
  artifactsDir: string;
  agentDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-delete-svc-"));
  const workspace = join(root, "workspace");
  const sessionsRoot = join(root, "agent", "sessions");
  const archiveRoot = join(root, "agent", "archive", "sessions");
  const agentDir = join(root, "agent");
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
  await mkdir(join(artifactsDir, "local"), { recursive: true });
  await writeFile(join(artifactsDir, "local", "scratch.txt"), "scratch", "utf8");
  await writeFile(join(artifactsDir, "tool-output.txt"), "artifact", "utf8");
  // 嵌套子代理 transcript 也住在 artifacts 目录里。
  await writeFile(join(artifactsDir, "sub-agent-1.jsonl"), JSON.stringify({ type: "session", id: "sub-agent-1" }), "utf8");
  const old = new Date(Date.now() - 3_600_000);
  await utimes(sessionFile, old, old);
  return { root, workspace, sessionsRoot, archiveRoot, sessionFile, artifactsDir, agentDir };
}

function service(options: {
  workspace: string;
  sessionsRoot: string;
  archiveRoot: string;
  isResident?: (sessionId: string) => boolean;
  purgeRows?: SessionDeleteServiceOptions["purgeRows"];
}): StudioSessionDeleteService {
  return new StudioSessionDeleteService({
    allowedCwd: options.workspace,
    sessionsRoot: options.sessionsRoot,
    archiveRoot: options.archiveRoot,
    ...(options.isResident === undefined ? {} : { isResident: options.isResident }),
    ...(options.purgeRows === undefined ? {} : { purgeRows: options.purgeRows }),
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string {
  assert.ok(error instanceof SessionDeleteServiceError, `expected SessionDeleteServiceError, got ${String(error)}`);
  return error.code;
}

test("delete removes the transcript, artifacts and nested subagent transcripts", async () => {
  const seed = await fixture();
  try {
    const svc = service(seed);
    const result = await svc.delete("session-a");
    assert.deepEqual(result, { sessionId: "session-a", deleted: true, nativeCleanup: { status: "partial", reason: "runtime-unavailable" } });
    assert.ok(!(await exists(seed.sessionFile)), "session file is gone");
    assert.ok(!(await exists(seed.artifactsDir)), "artifacts directory is gone");
    assert.deepEqual(await readdir(join(seed.sessionsRoot, "--project--")), [], "no residue remains in the project dir");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("delete removes an archived session (.jsonl.gz) and its archived artifacts", async () => {
  const seed = await fixture();
  try {
    const stem = "2026-08-16T10-00-00-000Z_session-b";
    const gz = join(seed.archiveRoot, "--project--", `${stem}.jsonl.gz`);
    const gzArtifacts = join(seed.archiveRoot, "--project--", stem);
    await mkdir(join(seed.archiveRoot, "--project--"), { recursive: true });
    await writeFile(gz, gzSession("session-b", seed.workspace), "utf8");
    await mkdir(gzArtifacts, { recursive: true });
    await writeFile(join(gzArtifacts, "out.md"), "artifact", "utf8");

    const svc = service(seed);
    await svc.delete("session-b");
    assert.ok(!(await exists(gz)), "archived session file is gone");
    assert.ok(!(await exists(gzArtifacts)), "archived artifacts are gone");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("delete refuses a missing session, a resident session and a cross-workspace session", async () => {
  const seed = await fixture();
  try {
    const svc = service(seed);
    assert.equal(errorCode(await svc.delete("session-missing").catch((error) => error)), "SESSION_NOT_FOUND");
    assert.equal(
      errorCode(await service({ ...seed, isResident: (sessionId) => sessionId === "session-a" }).delete("session-a").catch((error) => error)),
      "SESSION_RESIDENT",
    );
    assert.ok(await exists(seed.sessionFile), "resident refusal leaves the session file intact");

    const otherWorkspace = join(seed.root, "other");
    await mkdir(otherWorkspace);
    const foreign = new StudioSessionDeleteService({
      allowedCwd: otherWorkspace,
      sessionsRoot: seed.sessionsRoot,
      archiveRoot: seed.archiveRoot,
    });
    assert.equal(errorCode(await foreign.delete("session-a").catch((error) => error)), "WORKSPACE_MISMATCH");
    assert.ok(await exists(seed.sessionFile), "workspace mismatch leaves the session file intact");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("delete refuses a duplicate session id across active and archive trees", async () => {
  const seed = await fixture();
  try {
    const gz = join(seed.archiveRoot, "--project--", "2026-08-16T10-00-00-000Z_session-a.jsonl.gz");
    await mkdir(join(seed.archiveRoot, "--project--"), { recursive: true });
    await writeFile(gz, gzSession("session-a", seed.workspace), "utf8");
    const svc = service(seed);
    assert.equal(errorCode(await svc.delete("session-a").catch((error) => error)), "SESSION_DUPLICATE");
    assert.ok(await exists(seed.sessionFile), "ambiguous delete leaves both copies intact");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("deletion waits for native maintenance after ownership checks and before unlink", async () => {
  const seed = await fixture();
  try {
    let finish!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const purgeRows: NonNullable<SessionDeleteServiceOptions["purgeRows"]> = async input => {
      calls++;
      assert.deepEqual(input, { sessionId: "session-a", sessionFile: seed.sessionFile, agentDir: seed.agentDir });
      assert.equal(await exists(seed.sessionFile), true);
      entered();
      await pending;
      return { status: "complete", diagnostic: { history: { status: "absent" }, stats: { status: "absent" } } };
    };
    const deletion = service({ ...seed, purgeRows }).delete("session-a");
    await started;
    assert.equal(await exists(seed.sessionFile), true, "unlink waits for the one-shot worker to close");
    finish();
    assert.equal((await deletion).nativeCleanup.status, "complete");
    assert.equal(calls, 1);
    assert.equal(await exists(seed.sessionFile), false);
  } finally { await rm(seed.root, { recursive: true, force: true }); }
});

test("a session reopened during maintenance keeps its transcript and artifacts", async () => {
  const seed = await fixture();
  let resident = false;
  try {
    const svc = service({ ...seed, isResident: () => resident, purgeRows: async () => {
      resident = true;
      return { status: "complete", diagnostic: { history: { status: "absent" }, stats: { status: "absent" } } };
    } });
    await assert.rejects(() => svc.delete("session-a"), { code: "SESSION_RESIDENT" });
    assert.equal(await exists(seed.sessionFile), true);
    assert.equal(await exists(seed.artifactsDir), true);
  } finally { await rm(seed.root, { recursive: true, force: true }); }
});

test("native maintenance is not invoked for a resident or foreign session", async () => {
  const seed = await fixture();
  let calls = 0;
  const purgeRows: NonNullable<SessionDeleteServiceOptions["purgeRows"]> = async () => { calls++; throw new Error("must not run"); };
  try {
    await assert.rejects(() => service({ ...seed, isResident: () => true, purgeRows }).delete("session-a"), { code: "SESSION_RESIDENT" });
    await assert.rejects(() => service({ ...seed, workspace: join(seed.root, "foreign"), purgeRows }).delete("session-a"), { code: "WORKSPACE_MISMATCH" });
    assert.equal(calls, 0);
    assert.equal(await exists(seed.sessionFile), true);
  } finally { await rm(seed.root, { recursive: true, force: true }); }
});

test("a native partial result or maintenance exception does not misreport complete cleanup", async () => {
  for (const outcome of ["partial", "throws"] as const) {
    const seed = await fixture();
    try {
      const result = await service({ ...seed, purgeRows: async () => {
        if (outcome === "throws") throw new Error("worker stopped");
        return { status: "partial", reason: "native-purge-partial", diagnostic: { history: { status: "failed", reason: "store-unavailable" }, stats: { status: "absent" } } };
      } }).delete("session-a");
      assert.equal(result.deleted, true);
      assert.equal(result.nativeCleanup.status, "partial");
      assert.equal(result.nativeCleanup.status === "partial" && result.nativeCleanup.reason, outcome === "throws" ? "process-failed" : "native-purge-partial");
      assert.equal(await exists(seed.sessionFile), false);
    } finally { await rm(seed.root, { recursive: true, force: true }); }
  }
});

test("removeSessionPin drops a pinned id and tolerates a missing or corrupt pin file", async () => {
  const seed = await fixture();
  try {
    const pinPath = join(seed.agentDir, "session-pins.json");
    await writeFile(pinPath, JSON.stringify(["session-a", "session-b"], null, "\t"), "utf8");
    await removeSessionPin("session-a", seed.agentDir);
    assert.deepEqual(JSON.parse(await readFile(pinPath, "utf8")), ["session-b"], "only the deleted id is removed");

    await removeSessionPin("session-missing", seed.agentDir);
    assert.deepEqual(JSON.parse(await readFile(pinPath, "utf8")), ["session-b"], "absent id leaves the file untouched");

    await writeFile(pinPath, "not-json{", "utf8");
    await removeSessionPin("session-b", seed.agentDir);
    assert.equal(await readFile(pinPath, "utf8"), "not-json{", "corrupt pin file is never rewritten");
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});
