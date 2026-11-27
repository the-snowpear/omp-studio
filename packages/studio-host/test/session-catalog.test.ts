import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defaultOmpSessionsRoot,
  scanSessionCatalog,
  SESSION_PIN_ID_MAX_CHARS,
  SESSION_PINS_MAX_BYTES,
  SESSION_PINS_MAX_ENTRIES,
} from "../src/index.js";

async function sessionFile(
  directory: string,
  name: string,
  header: Record<string, unknown>,
): Promise<string> {
  const path = join(directory, `${name}.jsonl`);
  await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify({ type: "message", message: { role: "user", content: "secret body" } })}\n`);
  return path;
}

test("catalog keeps persisted approval waits beyond the title prefix and clears nested waits on parent repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-approval-"));
  const file = join(root, "approval.jsonl");
  const records = [
    { type: "session", id: "waiting", cwd: root, studioOrigin: "studio-host" },
    { type: "title", title: "Awaiting approval" },
    { type: "message", id: "user", parentId: null, message: { role: "user", content: "x".repeat(70000) } },
    { type: "custom", id: "ask", parentId: "user", customType: "tool_approval_requested", data: { toolCallId: "nested", parentToolCallId: "eval" } },
  ];
  await writeFile(file, records.map(row => JSON.stringify(row)).join("\n") + "\n");
  const options = { sessionsRoot: root, archiveRoot: join(root, "missing"), prefixBytes: 65536 };
  assert.equal((await scanSessionCatalog(options)).sessions[0]?.waitingForApproval, true);
  await writeFile(file, [...records, { type: "message", id: "repair", parentId: "ask", message: { role: "toolResult", toolCallId: "eval", content: "Interrupted" } }].map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal((await scanSessionCatalog(options)).sessions[0]?.waitingForApproval, undefined);
});

test("approval badges follow the active branch and preserve it across late off-branch results", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-branches-"));
  const file = join(root, "branches.jsonl");
  await writeFile(file, [
    { type: "session", id: "branches", studioOrigin: "studio-host" },
    { type: "message", id: "root", parentId: null, message: { role: "user", content: "start" } },
    { type: "custom", id: "old-ask", parentId: "root", customType: "tool_approval_requested", data: { toolCallId: "old-tool" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const options = { sessionsRoot: root, archiveRoot: join(root, "missing") };
  const waiting = async () => (await scanSessionCatalog(options)).sessions[0]?.waitingForApproval;
  assert.equal(await waiting(), true);
  await appendFile(file, JSON.stringify({ type: "message", id: "new-branch", parentId: "root", message: { role: "user", content: [{ type: "image", data: "A".repeat(3 * 1024 * 1024), mimeType: "image/png" }] } }) + "\n");
  assert.equal(await waiting(), undefined);
  await appendFile(file, JSON.stringify({ type: "message", id: "late", parentId: "old-ask", activeLeafId: "new-branch", message: { role: "toolResult", toolCallId: "unrelated", content: "late output" } }) + "\n");
  assert.equal(await waiting(), undefined);
  const request = JSON.stringify({ type: "custom", id: "new-ask", parentId: "new-branch", customType: "tool_approval_requested", data: { toolCallId: "current-tool" } });
  await appendFile(file, request.slice(0, 40));
  assert.equal(await waiting(), undefined);
  await appendFile(file, request.slice(40) + "\n");
  assert.equal(await waiting(), true);
  await appendFile(file, JSON.stringify({ type: "message", id: "new-result", parentId: "new-ask", message: { role: "toolResult", toolCallId: "current-tool", content: "done" } }) + "\n");
  assert.equal(await waiting(), undefined);
});

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

test("session catalog hides Runtime metadata-only sessions until the first message", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-empty-"));
  const project = join(root, "--project--");
  await mkdir(project);
  const path = join(project, "empty.jsonl");
  const metadata = [
    JSON.stringify({ type: "title", v: 1, title: "", pad: "" }),
    JSON.stringify({ type: "session", id: "empty-id", timestamp: "2026-08-24T00:00:00.000Z", studioOrigin: "studio-host" }),
    JSON.stringify({ type: "model_change", provider: "test", modelId: "test" }),
    JSON.stringify({ type: "thinking_level_change", thinkingLevel: "medium" }),
  ];
  await writeFile(path, `${metadata.join("\n")}\n`);

  const empty = await scanSessionCatalog({ sessionsRoot: root });
  assert.deepEqual(empty.sessions, []);
  assert.deepEqual(empty.diagnostics, []);

  await writeFile(path, `${metadata.join("\n")}\n${JSON.stringify({ type: "message", message: { role: "user", content: "hello" } })}\n`);
  const started = await scanSessionCatalog({ sessionsRoot: root });
  assert.deepEqual(started.sessions.map((entry) => entry.sessionId), ["empty-id"]);
});

test("locates exact session IDs in registered workspaces, including the cold archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-locate-"));
  const projects = ["one", "two", "unregistered"].map(name => join(root, name));
  const sessions = join(root, "sessions");
  const archive = join(root, "archive", "sessions");
  await mkdir(sessions);
  await mkdir(archive, { recursive: true });
  await sessionFile(sessions, "one", { type: "session", id: "same-id", cwd: projects[0], title: "First" });
  await sessionFile(sessions, "unknown", { type: "session", id: "same-id", cwd: projects[2] });
  await sessionFile(sessions, "different", { type: "session", id: "same-id-other", cwd: projects[1] });
  const { gzipSync } = await import("node:zlib");
  await writeFile(join(archive, "two.jsonl.gz"), gzipSync([
    JSON.stringify({ type: "session", id: "same-id", cwd: projects[1], title: "Second" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "archived" } }),
  ].join("\n") + "\n"));
  const result = await scanSessionCatalog({
    sessionsRoot: sessions, archiveRoot: archive, includeCliSessions: true,
    locate: { sessionId: "same-id", workspaces: [
      { workspaceId: "ws-one", canonicalPath: projects[0]! },
      { workspaceId: "ws-two", canonicalPath: projects[1]! },
    ] },
  });
  assert.deepEqual(result.sessions.map(entry => [entry.workspaceId, entry.title, entry.archived]).sort(), [
    ["ws-one", "First", false], ["ws-two", "Second", true],
  ]);
  assert.ok(!JSON.stringify(result).includes("unregistered"));
});

test("single-session locate reaches a metadata-only session the list views hide", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-locate-empty-"));
  const project = join(root, "project");
  await mkdir(project);
  const metadata = [
    JSON.stringify({ type: "title", v: 1, title: "", pad: "" }),
    JSON.stringify({ type: "session", id: "fresh-id", timestamp: "2026-08-24T00:00:00.000Z", cwd: project, studioOrigin: "studio-host" }),
    JSON.stringify({ type: "model_change", provider: "test", modelId: "test" }),
  ];
  await writeFile(join(project, "fresh.jsonl"), `${metadata.join("\n")}\n`);
  const hidden = await scanSessionCatalog({ sessionsRoot: root, includeCliSessions: true });
  assert.deepEqual(hidden.sessions, []);
  const located = await scanSessionCatalog({
    sessionsRoot: root, includeCliSessions: true,
    locate: { sessionId: "fresh-id", workspaces: [{ workspaceId: "ws-one", canonicalPath: project }] },
  });
  assert.deepEqual(located.sessions.map(entry => [entry.sessionId, entry.workspaceId, entry.archived]), [["fresh-id", "ws-one", false]]);
});

test("session catalog handles title slots, unknown origins, duplicates, corruption, oversize, and symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-edge-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "title-slot.jsonl"), [
    JSON.stringify({ type: "title", v: 1, title: "slot", updatedAt: "2026-08-11T00:00:00.000Z", pad: "" }),
    JSON.stringify({ type: "session", id: "unknown-id", timestamp: "bad", studioOrigin: "future-studio" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
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

test("session catalog keeps last-conversation time stable when opening disposes append Runtime markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-tail-"));
  const project = join(root, "--project--");
  await mkdir(project);
  const { utimes } = await import("node:fs/promises");

  const message = (role: string, timestamp: string) => JSON.stringify({ type: "message", id: `m-${role}`, parentId: "s", timestamp, message: { role, content: `${role} text` } });
  const marker = (customType: string, timestamp: string) => JSON.stringify({ type: "custom", customType, id: `c-${customType}`, parentId: "s", timestamp, data: "{}", runtime: "{}" });

  const alpha = join(project, "alpha.jsonl");
  const beta = join(project, "beta.jsonl");
  const alphaHeader = JSON.stringify({ type: "session", id: "alpha-id", timestamp: "2026-08-01T00:00:00.000Z", cwd: "C:\\alpha", studioOrigin: "studio-host" });
  const betaHeader = JSON.stringify({ type: "session", id: "beta-id", timestamp: "2026-08-02T00:00:00.000Z", cwd: "C:\\beta", studioOrigin: "studio-host" });
  await writeFile(alpha, `${alphaHeader}\n${message("user", "2026-08-03T00:00:00.000Z")}\n${message("assistant", "2026-08-03T01:00:00.000Z")}\n`);
  await writeFile(beta, `${betaHeader}\n${message("user", "2026-08-04T00:00:00.000Z")}\n${message("assistant", "2026-08-04T01:00:00.000Z")}\n`);
  // Fixed mtimes: beta's conversation is newer than alpha's.
  await utimes(alpha, new Date("2026-08-03T02:00:00.000Z"), new Date("2026-08-03T02:00:00.000Z"));
  await utimes(beta, new Date("2026-08-04T02:00:00.000Z"), new Date("2026-08-04T02:00:00.000Z"));

  const byId = new Map((await scanSessionCatalog({ sessionsRoot: root })).sessions.map((entry) => [entry.sessionId, entry]));
  assert.equal(byId.get("alpha-id")?.lastActivityAt, "2026-08-03T01:00:00.000Z");
  assert.equal(byId.get("beta-id")?.lastActivityAt, "2026-08-04T01:00:00.000Z");

  // Opening then disposing alpha appends markers that bump its mtime past
  // beta's, exactly like the Runtime's session_exit records.
  await writeFile(alpha, `${alphaHeader}\n${message("user", "2026-08-03T00:00:00.000Z")}\n${message("assistant", "2026-08-03T01:00:00.000Z")}\n${marker("eval-state-context", "2026-08-09T00:00:00.000Z")}\n${marker("session_exit", "2026-08-09T01:00:00.000Z")}\n`);
  const reshuffled = await scanSessionCatalog({ sessionsRoot: root });
  assert.deepEqual(reshuffled.sessions.map((entry) => entry.sessionId), ["beta-id", "alpha-id"]);
  assert.equal(reshuffled.sessions.find((entry) => entry.sessionId === "alpha-id")?.lastActivityAt, "2026-08-03T01:00:00.000Z");

  // A real new message still moves the session forward.
  await writeFile(alpha, `${alphaHeader}\n${message("user", "2026-08-03T00:00:00.000Z")}\n${message("assistant", "2026-08-03T01:00:00.000Z")}\n${marker("session_exit", "2026-08-09T01:00:00.000Z")}\n${message("assistant", "2026-08-10T00:00:00.000Z")}\n`);
  const advanced = await scanSessionCatalog({ sessionsRoot: root });
  assert.deepEqual(advanced.sessions.map((entry) => entry.sessionId), ["alpha-id", "beta-id"]);
  assert.equal(advanced.sessions.find((entry) => entry.sessionId === "alpha-id")?.lastActivityAt, "2026-08-10T00:00:00.000Z");

  // Displayed custom messages count; hidden ones (display:false) do not.
  const gamma = join(project, "gamma.jsonl");
  const gammaHeader = JSON.stringify({ type: "session", id: "gamma-id", timestamp: "2026-08-05T00:00:00.000Z", cwd: "C:\\gamma", studioOrigin: "studio-host" });
  const hiddenCustom = JSON.stringify({ type: "custom_message", customType: "eval-state-context", content: "hidden", display: false, id: "g1", parentId: "s", timestamp: "2026-08-06T00:00:00.000Z" });
  const shownCustom = JSON.stringify({ type: "custom_message", customType: "todo-nudge", content: "shown", display: true, id: "g2", parentId: "s", timestamp: "2026-08-06T01:00:00.000Z" });
  await writeFile(gamma, `${gammaHeader}\n${hiddenCustom}\n${message("user", "2026-08-05T01:00:00.000Z")}\n${shownCustom}\n`);
  const gammaScan = await scanSessionCatalog({ sessionsRoot: root });
  assert.equal(gammaScan.sessions.find((entry) => entry.sessionId === "gamma-id")?.lastActivityAt, "2026-08-06T01:00:00.000Z");
});

test("session catalog reads global pins and degrades safely for missing, corrupt, and stale ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-pins-"));
  const sessionsRoot = join(root, "sessions");
  const project = join(sessionsRoot, "project");
  await mkdir(project, { recursive: true });
  await sessionFile(project, "pinned", {
    type: "session",
    id: "pinned-id",
    timestamp: "2026-08-11T00:00:00.000Z",
    cwd: "C:\\workspace",
    title: "Pinned chat",
    studioOrigin: "studio-host",
  });
  await sessionFile(project, "ordinary", {
    type: "session",
    id: "ordinary-id",
    timestamp: "2026-08-10T00:00:00.000Z",
    cwd: "C:\\workspace",
    title: "Ordinary chat",
    studioOrigin: "studio-host",
  });

  await writeFile(join(root, "session-pins.json"), JSON.stringify(["pinned-id", "stale-id"]));
  const pinned = await scanSessionCatalog({ sessionsRoot, agentDir: root });
  const byId = new Map(pinned.sessions.map((entry) => [entry.sessionId, entry]));
  assert.equal(byId.get("pinned-id")?.pinned, true);
  assert.equal(byId.get("ordinary-id")?.pinned, false);
  assert.equal(byId.has("stale-id"), false);

  await writeFile(join(root, "session-pins.json"), "not-json");
  const corrupt = await scanSessionCatalog({ sessionsRoot, agentDir: root });
  assert.equal(corrupt.sessions.some((entry) => entry.pinned), false);

  const missing = await scanSessionCatalog({ sessionsRoot, agentDir: join(root, "missing-agent") });
  assert.equal(missing.sessions.some((entry) => entry.pinned), false);
  assert.ok(!JSON.stringify(missing).includes("session-pins.json"));

  await writeFile(join(root, "session-pins.json"), Buffer.alloc(SESSION_PINS_MAX_BYTES + 1, 0x20));
  const oversize = await scanSessionCatalog({ sessionsRoot, agentDir: root });
  assert.equal(oversize.sessions.some((entry) => entry.pinned), false);

  await writeFile(
    join(root, "session-pins.json"),
    JSON.stringify(Array.from({ length: SESSION_PINS_MAX_ENTRIES + 1 }, (_, index) => `session-${index}`)),
  );
  const tooMany = await scanSessionCatalog({ sessionsRoot, agentDir: root });
  assert.equal(tooMany.sessions.some((entry) => entry.pinned), false);

  await writeFile(
    join(root, "session-pins.json"),
    JSON.stringify(["pinned-id", "x".repeat(SESSION_PIN_ID_MAX_CHARS + 1)]),
  );
  const longId = await scanSessionCatalog({ sessionsRoot, agentDir: root });
  assert.equal(longId.sessions.some((entry) => entry.pinned), false);
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
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
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

test("session catalog prefers live title slots and title_change entries over stale header titles and refreshes untitled live slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-catalog-live-title-"));
  const project = join(root, "--project--");
  await mkdir(project, { recursive: true });

  // Case 1: Fixed-width 256-byte title slot updated in place while file size and mtime stay identical.
  const fixedSlot = (title: string): string => {
    const base = JSON.stringify({ type: "title", v: 1, title, updatedAt: "2026-08-24T00:00:00.000Z", pad: "" });
    const pad = " ".repeat(Math.max(0, 255 - Buffer.byteLength(base, "utf8")));
    return `${JSON.stringify({ type: "title", v: 1, title, updatedAt: "2026-08-24T00:00:00.000Z", pad })}\n`;
  };
  const liveFile = join(project, "live-slot.jsonl");
  const restLines = [
    JSON.stringify({ type: "session", id: "slot-session", timestamp: "2026-08-24T00:00:00.000Z", studioOrigin: "studio-host" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "review session title pipeline" } }),
  ].join("\n") + "\n";
  await writeFile(liveFile, fixedSlot("") + restLines);
  const { utimes } = await import("node:fs/promises");
  const fixedTime = new Date("2026-08-24T00:00:05.000Z");
  await utimes(liveFile, fixedTime, fixedTime);

  const initialScan = await scanSessionCatalog({ sessionsRoot: root });
  assert.equal(initialScan.sessions.find((entry) => entry.sessionId === "slot-session")?.title, undefined);

  await writeFile(liveFile, fixedSlot("Updated in-place slot title") + restLines);
  await utimes(liveFile, fixedTime, fixedTime);

  const updatedScan = await scanSessionCatalog({ sessionsRoot: root });
  assert.equal(updatedScan.sessions.find((entry) => entry.sessionId === "slot-session")?.title, "Updated in-place slot title");

  // Case 2: Populated title slot overrides an older header.title, and title_change overrides an empty slot.
  await writeFile(join(project, "slot-overrides-header.jsonl"), [
    JSON.stringify({ type: "title", v: 1, title: "Renamed title", updatedAt: "2026-08-24T00:01:00.000Z", pad: "" }),
    JSON.stringify({ type: "session", id: "override-session", title: "Old header title", studioOrigin: "studio-host" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
  ].join("\n") + "\n");
  await writeFile(join(project, "title-change-fallback.jsonl"), [
    JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-08-24T00:00:00.000Z", pad: "" }),
    JSON.stringify({ type: "session", id: "change-session", studioOrigin: "studio-host" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "title_change", title: "Mid-turn appended title", source: "auto" }),
  ].join("\n") + "\n");

  const finalScan = await scanSessionCatalog({ sessionsRoot: root });
  const byId = new Map(finalScan.sessions.map((entry) => [entry.sessionId, entry.title]));
  assert.equal(byId.get("override-session"), "Renamed title");
  assert.equal(byId.get("change-session"), "Mid-turn appended title");
});
