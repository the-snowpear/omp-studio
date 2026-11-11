import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile, truncate, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";

import { CONVERSATION_LIMITS } from "@omp-studio/studio-protocol";

import { SessionArchiveCacheBudget, SessionArchiveError, StudioSessionArchiveReader } from "../src/index.js";

const HEADER = { type: "session", version: 3, id: "session-a", cwd: "", timestamp: "2026-08-16T10:00:00.000Z" };

test("workspace readers share one retention budget and eviction does not invalidate paging cursors", async () => {
  const budget = new SessionArchiveCacheBudget(), cursorSecret = Buffer.alloc(32, 7);
  const readers: StudioSessionArchiveReader[] = [];
  for (let index = 0; index < 3; index++) {
    const data = await fixture([userLine("m-1", "x".repeat(4 * 1024 * 1024), null), userLine("m-2", "tail", "m-1")]);
    readers.push(new StudioSessionArchiveReader({ allowedCwd: data.workspace, sessionsRoot: dirname(dirname(data.sessionFile)), cursorSecret, cacheBudget: budget }));
  }
  const first = await readers[0]!.readPage({ sessionId: "session-a", limit: 1 });
  for (const reader of readers.slice(1)) await reader.readPage({ sessionId: "session-a", limit: 1 });
  assert.ok(budget.diagnostics().entries <= 2);
  assert.ok(budget.diagnostics().estimatedBytes <= 64 * 1024 * 1024);
  const older = await readers[0]!.readPage({ sessionId: "session-a", cursor: first.olderCursor!, limit: 1 });
  assert.equal(older.items[0]?.itemId, "m-1");
  assert.equal(await readers[0]!.prefetch("session-a"), undefined);
  for (const reader of readers) reader.clearCache();
  assert.equal(budget.diagnostics().rawBytes, 0);
});

function userLine(id: string, text: string, parentId: string | null): string {
  return `${JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-16T10:00:01.000Z",
    message: { role: "user", content: text },
  })}\n`;
}

function assistantToolLine(id: string, toolCallId: string, parentId: string, argument: string): string {
  return `${JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-16T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "Read", arguments: { argument } }],
    },
  })}\n`;
}

function toolResultLine(id: string, toolCallId: string, parentId: string, output: string): string {
  return `${JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-16T10:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "Read",
      content: [{ type: "text", text: output }],
      isError: false,
    },
  })}\n`;
}

async function fixture(lines: readonly string[] = [userLine("m-1", "hello", null)]): Promise<{
  workspace: string;
  sessionFile: string;
  reader: StudioSessionArchiveReader;
}> {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-archive-reader-"));
  const workspace = join(root, "workspace");
  const sessionsRoot = join(root, "agent", "sessions");
  const archiveRoot = join(root, "agent", "archive", "sessions");
  const projectDir = join(sessionsRoot, "--project--");
  await mkdir(workspace);
  await mkdir(projectDir, { recursive: true });
  await mkdir(archiveRoot, { recursive: true });
  const sessionFile = join(projectDir, "2026-08-16T10-00-00-000Z_session-a.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ ...HEADER, cwd: workspace })}\n${lines.join("")}`, "utf8");
  return {
    workspace,
    sessionFile,
    reader: new StudioSessionArchiveReader({ allowedCwd: workspace, sessionsRoot, archiveRoot }),
  };
}

function textOf(item: { readonly kind: string } & Record<string, unknown>): string {
  const content = item.content as ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

test("Time Travel reads the selected branch, preserves later branches, and pages older events", async () => {
  const lines = Array.from({ length: 130 }, (_, index) => userLine(`m-${index}`, `message ${index}`, index ? `m-${index - 1}` : null));
  lines.push(`${JSON.stringify({ type: "custom", customType: "studio-time-travel", id: "restore", parentId: "m-2", timestamp: "2026-08-16T11:00:00.000Z", data: { targetId: "m-2" } })}\n`);
  const { reader } = await fixture(lines);
  const active = await reader.readTimeTravel({ sessionId: "session-a" });
  assert.equal(active.activeLeafId, "restore");
  assert.deepEqual(active.events.map(event => event.id), ["m-0", "m-1", "m-2"]);
  assert.deepEqual(new Set(active.branches.map(branch => branch.leafId)), new Set(["m-129", "restore"]));
  const later = await reader.readTimeTravel({ sessionId: "session-a", branchLeafId: "m-129" });
  assert.equal(later.events.length, 120);
  assert.ok(later.olderCursor);
  const earlier = await reader.readTimeTravel({ sessionId: "session-a", branchLeafId: "m-129", cursor: later.olderCursor });
  assert.equal(earlier.events.length, 10);
  assert.equal(earlier.olderCursor, undefined);
  assert.equal(later.activeLeafId, "restore");
});

test("rejects a non-positive parsed snapshot cache budget", () => {
  assert.throws(
    () => new StudioSessionArchiveReader({ allowedCwd: "C:/workspace", snapshotCacheMaxBytes: 0 }),
    /snapshotCacheMaxBytes must be positive/u,
  );
});

test("reads the persisted tail page without a Runtime", async () => {
  const { reader } = await fixture();
  const page = await reader.readPage({ sessionId: "session-a", limit: 50 });
  assert.equal(page.sessionId, "session-a");
  assert.match(page.transcriptRevision, /^sha256:/u);
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMoreBefore, false);
  assert.equal(textOf(page.items[0] as never), "hello");
});

test("closing one archive reader consumer preserves the other and a cancelled append does not corrupt the next read", async () => {
  const { reader, sessionFile } = await fixture();
  const controller = new AbortController();
  const cancelled = reader.readPage({ sessionId: "session-a" }, controller.signal);
  const remaining = reader.readPage({ sessionId: "session-a" });
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  controller.abort(); await rejected;
  assert.equal((await remaining).items.length, 1);
  await appendFile(sessionFile, userLine("m-2", "second", "m-1"));
  const another = new AbortController();
  const append = reader.readPage({ sessionId: "session-a" }, another.signal);
  const appendRejected = assert.rejects(append, { name: "AbortError" }); another.abort(); await appendRejected;
  assert.equal((await reader.readPage({ sessionId: "session-a" })).items.length, 2);
});

test("an appended session is re-read incrementally and keeps earlier items intact", async () => {
  const { reader, sessionFile } = await fixture();
  const first = await reader.readPage({ sessionId: "session-a", limit: 50 });
  await appendFile(sessionFile, userLine("m-2", "second", "m-1"), "utf8");
  const second = await reader.readPage({ sessionId: "session-a", limit: 50 });
  assert.equal(second.items.length, 2);
  assert.equal(textOf(second.items[0] as never), "hello");
  assert.equal(textOf(second.items[1] as never), "second");
  assert.notEqual(second.transcriptRevision, first.transcriptRevision);
  // 续读必须和整档重读得到同一份投影：itemId / parentId 一并对齐。
  assert.deepEqual(second.items[0], first.items[0]);
});

test("a persisted child append refreshes its conversation and roster without clearing the cache", async t => {
  const { reader, sessionFile, workspace } = await fixture();
  const temporary = await realpath(dirname(workspace));
  t.after(async () => {
    const tail = relative(resolve(tmpdir()), temporary);
    assert.ok(tail && !isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`));
    await rm(temporary, { recursive: true, force: true });
  });
  const children = sessionFile.slice(0, -".jsonl".length);
  await mkdir(children);
  const childFile = join(children, "child-agent.jsonl");
  await writeFile(childFile, `${JSON.stringify({ ...HEADER, id: "child-session", cwd: workspace })}\n${userLine("c-1", "first", null)}`);
  const input = { sessionId: "session-a", agentId: "child-agent" };
  const first = await reader.readPage(input);
  assert.equal((await reader.listPersistedAgents("session-a"))[0]?.updatedAt, "2026-08-16T10:00:01.000Z");

  await appendFile(childFile, userLine("c-2", "second", "c-1").replace("2026-08-16T10:00:01.000Z", "2026-08-16T10:01:00.000Z"));
  const next = await reader.readPage(input);
  assert.deepEqual(next.items.map(item => item.itemId), ["c-1", "c-2"]);
  assert.notEqual(next.transcriptRevision, first.transcriptRevision);

  await appendFile(childFile, userLine("c-3", "third", "c-2").replace("2026-08-16T10:00:01.000Z", "2026-08-16T10:02:00.000Z"));
  assert.equal((await reader.listPersistedAgents("session-a"))[0]?.updatedAt, "2026-08-16T10:02:00.000Z");
  assert.deepEqual((await reader.readPage(input)).items.map(item => item.itemId), ["c-1", "c-2", "c-3"]);
});

test("a session rewritten in place falls back to a full read", async () => {
  const { reader, sessionFile, workspace } = await fixture();
  await reader.readPage({ sessionId: "session-a", limit: 50 });
  await writeFile(
    sessionFile,
    `${JSON.stringify({ ...HEADER, cwd: workspace })}\n${userLine("m-9", "rewritten from scratch", null)}`,
    "utf8",
  );
  const page = await reader.readPage({ sessionId: "session-a", limit: 50 });
  assert.equal(page.items.length, 1);
  assert.equal(textOf(page.items[0] as never), "rewritten from scratch");
});

test("a truncated session is re-read from scratch", async () => {
  const { reader, sessionFile, workspace } = await fixture([userLine("m-1", "hello", null), userLine("m-2", "second", "m-1")]);
  const first = await reader.readPage({ sessionId: "session-a", limit: 50 });
  assert.equal(first.items.length, 2);
  const header = `${JSON.stringify({ ...HEADER, cwd: workspace })}\n`;
  await truncate(sessionFile, Buffer.byteLength(header + userLine("m-1", "hello", null), "utf8"));
  const second = await reader.readPage({ sessionId: "session-a", limit: 50 });
  assert.equal(second.items.length, 1);
  assert.equal(textOf(second.items[0] as never), "hello");
});

test("a cursor issued before an append is rejected as stale", async () => {
  const { reader, sessionFile } = await fixture([userLine("m-1", "hello", null), userLine("m-2", "second", "m-1")]);
  const page = await reader.readPage({ sessionId: "session-a", limit: 1 });
  assert.equal(page.hasMoreBefore, true);
  assert.notEqual(page.olderCursor, undefined);
  await appendFile(sessionFile, userLine("m-3", "third", "m-2"), "utf8");
  await assert.rejects(
    () => reader.readPage({ sessionId: "session-a", limit: 1, cursor: page.olderCursor! }),
    (error: unknown) => error instanceof SessionArchiveError && error.code === "CURSOR_STALE",
  );
});

test("a malformed appended record is reported as corruption", async () => {
  const { reader, sessionFile } = await fixture();
  await reader.readPage({ sessionId: "session-a", limit: 50 });
  await appendFile(sessionFile, "{not json}\n", "utf8");
  await assert.rejects(
    () => reader.readPage({ sessionId: "session-a", limit: 50 }),
    (error: unknown) => error instanceof SessionArchiveError && error.code === "SESSION_CORRUPT",
  );
});

test("paging twice at the same revision yields the same items", async () => {
  const lines = Array.from({ length: 6 }, (_, index) => userLine(`m-${index + 1}`, `line ${index + 1}`, index === 0 ? null : `m-${index}`));
  const { reader } = await fixture(lines);
  const tail = await reader.readPage({ sessionId: "session-a", limit: 2 });
  assert.equal(tail.items.length, 2);
  const older = await reader.readPage({ sessionId: "session-a", limit: 2, cursor: tail.olderCursor! });
  assert.deepEqual(
    older.items.map((item) => textOf(item as never)),
    ["line 3", "line 4"],
  );
  const again = await reader.readPage({ sessionId: "session-a", limit: 2 });
  assert.deepEqual(again.items, tail.items);
});

test("page byte fitting preserves assistant and tool shells before truncating payloads", async () => {
  const payload = "x".repeat(20 * 1024);
  const lines: string[] = [userLine("u-1", "run tools", null)];
  const expectedIds = ["u-1"];
  let parentId = "u-1";
  for (let index = 1; index <= 49; index += 1) {
    const assistantId = `a-${index}`;
    const resultId = `r-${index}`;
    const toolCallId = `call-${index}`;
    lines.push(assistantToolLine(assistantId, toolCallId, parentId, payload));
    lines.push(toolResultLine(resultId, toolCallId, assistantId, payload));
    expectedIds.push(assistantId);
    parentId = resultId;
  }
  const { reader } = await fixture(lines);
  const page = await reader.readPage({ sessionId: "session-a", limit: 50 });

  assert.equal(page.hasMoreBefore, false);
  assert.deepEqual(page.items.map((item) => item.itemId), expectedIds);
  for (const item of page.items.slice(1)) {
    assert.equal(item.kind, "message");
    if (item.kind !== "message") continue;
    const call = item.content.find((block) => block.type === "toolCall");
    const result = item.content.find((block) => block.type === "toolResult");
    assert.equal(call?.type, "toolCall");
    assert.equal(result?.type, "toolResult");
    if (call?.type !== "toolCall" || result?.type !== "toolResult") continue;
    assert.equal(call.toolCallId, result.toolCallId);
    assert.equal(call.truncated, true);
    assert.equal(result.truncated, true);
    assert.ok((result.output?.length ?? 0) < payload.length);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= CONVERSATION_LIMITS.PAGE_MAX_BYTES);
});
