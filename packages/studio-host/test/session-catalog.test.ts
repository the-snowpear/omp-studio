import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultOmpSessionsRoot, scanSessionCatalog } from "../src/index.js";

async function sessionFile(
  directory: string,
  name: string,
  header: Record<string, unknown>,
): Promise<string> {
  const path = join(directory, `${name}.jsonl`);
  await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify({ type: "message", message: { role: "user", content: "secret body" } })}\n`);
  return path;
}

test("session catalog distinguishes Studio and CLI sessions and supports the visibility toggle", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-"));
  const project = join(root, "--project--");
  await mkdir(project);
  await sessionFile(project, "studio", {
    type: "session",
    id: "studio-id",
    timestamp: "2026-08-11T00:00:00.000Z",
    cwd: "C:\\secret\\studio",
    title: "Studio chat",
    studioOrigin: "studio-host",
  });
  await sessionFile(project, "cli", {
    type: "session",
    id: "cli-id",
    timestamp: "2026-08-10T00:00:00.000Z",
    cwd: "C:\\secret\\cli",
    title: "CLI chat",
  });
  const studioOnly = await scanSessionCatalog({ sessionsRoot: root });
  assert.deepEqual(studioOnly.sessions.map((entry) => [entry.sessionId, entry.origin]), [["studio-id", "studio"]]);
  const all = await scanSessionCatalog({ sessionsRoot: root, includeCliSessions: true });
  assert.deepEqual(new Set(all.sessions.map((entry) => `${entry.sessionId}:${entry.origin}`)), new Set(["studio-id:studio", "cli-id:cli"]));
  assert.ok(!JSON.stringify(all).includes("C:\\secret"));
  assert.ok(!JSON.stringify(all).includes("secret body"));
});

test("session catalog handles title slots, unknown origins, duplicates, corruption, oversize, and symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-edge-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "title-slot.jsonl"), [
    JSON.stringify({ type: "title", v: 1, title: "slot", updatedAt: "2026-08-11T00:00:00.000Z", pad: "" }),
    JSON.stringify({ type: "session", id: "unknown-id", timestamp: "bad", studioOrigin: "future-studio" }),
  ].join("\n"));
  await sessionFile(project, "duplicate-a", { type: "session", id: "duplicate", studioOrigin: "studio-host" });
  await sessionFile(project, "duplicate-b", { type: "session", id: "duplicate", studioOrigin: "studio-host" });
  await writeFile(join(project, "corrupt.jsonl"), "not json\n");
  await writeFile(join(project, "large.jsonl"), "x".repeat(1024));
  const target = await sessionFile(project, "target", { type: "session", id: "target", studioOrigin: "studio-host" });
  if (process.platform === "win32") {
    try {
      await symlink(target, join(project, "linked.jsonl"), "file");
    } catch {
      t.diagnostic("Windows symlink privilege unavailable; symlink branch skipped");
    }
  } else {
    await symlink(target, join(project, "linked.jsonl"));
  }
  const result = await scanSessionCatalog({ sessionsRoot: root, includeCliSessions: true, maxSessionBytes: 512 });
  assert.equal(result.sessions.filter((entry) => entry.sessionId === "duplicate").length, 1);
  assert.equal(result.sessions.find((entry) => entry.sessionId === "unknown-id")?.origin, "unknown");
  assert.equal(result.sessions.find((entry) => entry.sessionId === "unknown-id")?.title, "slot");
  assert.ok(result.diagnostics.some((item) => item.code === "DUPLICATE_SESSION_ID"));
  assert.ok(result.diagnostics.some((item) => item.code === "CORRUPT_SKIPPED"));
  assert.ok(result.diagnostics.some((item) => item.code === "OVERSIZE_SKIPPED"));
});

test("session catalog filters by allowedCwd without exposing the path", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-cwd-"));
  const project = join(root, "project");
  await mkdir(project);
  const allowed = join(root, "workspace-a");
  const other = join(root, "workspace-b");
  await sessionFile(project, "local", {
    type: "session",
    id: "local-id",
    timestamp: "2026-08-11T00:00:00.000Z",
    cwd: allowed,
    title: "Local chat",
    studioOrigin: "studio-host",
  });
  await sessionFile(project, "foreign", {
    type: "session",
    id: "foreign-id",
    timestamp: "2026-08-11T00:00:00.000Z",
    cwd: other,
    title: "Other workspace",
    studioOrigin: "studio-host",
  });
  const filtered = await scanSessionCatalog({ sessionsRoot: root, allowedCwd: allowed });
  assert.deepEqual(filtered.sessions.map((entry) => entry.sessionId), ["local-id"]);
  assert.ok(!JSON.stringify(filtered).includes(other));
  assert.ok(!JSON.stringify(filtered).includes("workspace-b"));
});

test("session catalog reports an unavailable root without exposing it", async () => {
  const result = await scanSessionCatalog({ sessionsRoot: join(tmpdir(), "missing-omp-session-root") });
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.diagnostics, [{ code: "ROOT_UNAVAILABLE", count: 1 }]);
  assert.ok(!JSON.stringify(result).includes("missing-omp-session-root"));
  assert.match(defaultOmpSessionsRoot({ OMP_AGENT_DIR: "C:\\omp-profile\\agent" }), /sessions$/u);
});

test("session catalog scans the cold-archive tree and marks gz members archived", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-arch-"));
  const project = join(root, "--project--");
  const archiveProject = join(root, "archive", "sessions", "--project--");
  await mkdir(project, { recursive: true });
  await mkdir(archiveProject, { recursive: true });
  await sessionFile(project, "live", {
    type: "session",
    id: "live-id",
    cwd: "C:\secret\live",
    title: "Live chat",
    studioOrigin: "studio-host",
  });
  const { gzipSync } = await import("node:zlib");
  await writeFile(
    join(archiveProject, "2026-08-15T00-00-00-000Z_old.jsonl.gz"),
    gzipSync(Buffer.from(
      [
        JSON.stringify({ type: "title", v: 1, title: "Archived chat", updatedAt: "2026-08-15T00:00:00.000Z", pad: "" }),
        JSON.stringify({ type: "session", id: "archived-id", timestamp: "2026-08-15T00:00:00.000Z", cwd: "C:\secret\live", studioOrigin: "studio-host" }),
      ].join("\n") + "\n",
      "utf8",
    )),
  );
  const result = await scanSessionCatalog({ sessionsRoot: root, archiveRoot: join(root, "archive", "sessions"), includeCliSessions: true, allowedCwd: "C:\secret\live" });
  const byId = new Map(result.sessions.map((entry) => [entry.sessionId, entry]));
  assert.equal(byId.get("live-id")?.archived, false);
  assert.equal(byId.get("archived-id")?.archived, true);
  assert.equal(byId.get("archived-id")?.title, "Archived chat");
  assert.ok(!JSON.stringify(result).includes("C:\secret"));
});
