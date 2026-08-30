import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONVERSATION_LIMITS } from "@omp-studio/studio-protocol";

import { SessionArchiveError, StudioSessionArchiveReader } from "../src/index.js";

const HEADER = { type: "session", version: 3, id: "session-a", cwd: "", timestamp: "2026-08-16T10:00:00.000Z" };

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
