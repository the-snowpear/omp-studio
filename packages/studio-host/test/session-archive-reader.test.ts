import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionArchiveError, StudioSessionArchiveReader } from "../src/index.js";

type Entry = Record<string, unknown>;

async function fixture(entries: Entry[], suffix = "\n") {
  const root = await mkdtemp(join(tmpdir(), "omp-studio-archive-"));
  const workspace = join(root, "workspace");
  const sessions = join(root, "sessions");
  await mkdir(workspace);
  await mkdir(sessions);
  const file = join(sessions, "session.jsonl");
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}${suffix}`, "utf8");
  return { root, workspace, sessions, file };
}

function records(workspace: string): Entry[] {
  return [
    { type: "session", id: "session-a", cwd: workspace, timestamp: "2026-08-15T00:00:00.000Z" },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-15T00:00:01.000Z",
      message: { role: "user", content: "hello" },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-08-15T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking" },
          { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "README.md", apiKey: "secret" } },
          { type: "text", text: "done" },
        ],
      },
    },
    {
      type: "message",
      id: "user-2",
      parentId: "assistant-1",
      timestamp: "2026-08-15T00:00:03.000Z",
      message: { role: "user", content: "next" },
    },
  ];
}

test("archive reader pages persistent history without a Runtime and redacts tool secrets", async () => {
  const seed = await fixture([]);
  await writeFile(seed.file, `${records(seed.workspace).map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({
      sessionsRoot: seed.sessions,
      allowedCwd: seed.workspace,
      cursorSecret: Buffer.alloc(32, 7),
    });
    const latest = await reader.readPage({ sessionId: "session-a", limit: 2 });
    assert.equal(latest.sessionId, "session-a");
    assert.match(latest.transcriptRevision, /^sha256:/u);
    assert.equal(latest.branchLeafId, "user-2");
    assert.deepEqual(latest.items.map((item) => item.itemId), ["assistant-1", "user-2"]);
    assert.equal(latest.hasMoreBefore, true);
    assert.ok(latest.olderCursor);
    const assistant = latest.items[0];
    assert.equal(assistant?.kind, "message");
    if (assistant?.kind === "message") {
      const call = assistant.content.find((block) => block.type === "toolCall");
      assert.equal(call?.type, "toolCall");
      if (call?.type === "toolCall") assert.deepEqual(call.arguments, { path: "README.md", apiKey: "[REDACTED]" });
    }
    const older = await reader.readPage({ sessionId: "session-a", cursor: latest.olderCursor, limit: 2 });
    assert.deepEqual(older.items.map((item) => item.itemId), ["user-1"]);
    assert.equal(older.hasMoreBefore, false);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader joins independent tool results before paging and preserves safe details", async () => {
  const seed = await fixture([]);
  const entries = records(seed.workspace).slice(0, 3);
  entries.push({
    type: "message",
    id: "tool-result-1",
    parentId: "assistant-1",
    timestamp: "2026-08-15T00:00:02.500Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Read",
      content: [{ type: "text", text: "file body" }],
      details: { lines: 3, preview: ["one", "two", "three"], token: "must-redact" },
      isError: false,
    },
  });
  await writeFile(seed.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    const page = await reader.readPage({ sessionId: "session-a", limit: 10 });
    assert.deepEqual(page.items.map((item) => item.itemId), ["user-1", "assistant-1"]);
    const assistant = page.items[1];
    assert.equal(assistant?.kind, "message");
    if (assistant?.kind === "message") {
      assert.deepEqual(assistant.content.at(-1), {
        type: "toolResult",
        toolCallId: "call-1",
        toolName: "Read",
        output: "file body",
        data: { lines: 3, preview: ["one", "two", "three"], token: "[REDACTED]" },
        isError: false,
      });
    }
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader suppresses empty assistant error entries", async () => {
  const seed = await fixture([]);
  const entries = records(seed.workspace);
  entries.push({
    type: "message",
    id: "empty-error",
    parentId: "user-2",
    timestamp: "2026-08-15T00:00:04.000Z",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" },
  });
  await writeFile(seed.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    const page = await reader.readPage({ sessionId: "session-a", limit: 10 });
    assert.equal(page.items.some((item) => item.itemId === "empty-error"), false);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader ignores only an incomplete append tail", async () => {
  const seed = await fixture([]);
  const complete = records(seed.workspace).slice(0, 2);
  await writeFile(
    seed.file,
    `${complete.map((entry) => JSON.stringify(entry)).join("\n")}\n{\"type\":\"message\",\"id\":\"partial`,
    "utf8",
  );
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    const page = await reader.readPage({ sessionId: "session-a" });
    assert.deepEqual(page.items.map((item) => item.itemId), ["user-1"]);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader rejects malformed complete records", async () => {
  const seed = await fixture([]);
  const [header, message] = records(seed.workspace);
  await writeFile(seed.file, `${JSON.stringify(header)}\n{bad-json}\n${JSON.stringify(message)}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    await assert.rejects(
      () => reader.readPage({ sessionId: "session-a" }),
      (error: unknown) => error instanceof SessionArchiveError && error.code === "SESSION_CORRUPT",
    );
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader rejects workspace mismatches and duplicate identities", async () => {
  const seed = await fixture([]);
  const data = `${records(seed.workspace).map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(seed.file, data, "utf8");
  try {
    const wrong = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: join(seed.root, "other") });
    await assert.rejects(
      () => wrong.readPage({ sessionId: "session-a" }),
      (error: unknown) => error instanceof SessionArchiveError && error.code === "WORKSPACE_MISMATCH",
    );
    await writeFile(join(seed.sessions, "duplicate.jsonl"), data, "utf8");
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    await assert.rejects(
      () => reader.readPage({ sessionId: "session-a" }),
      (error: unknown) => error instanceof SessionArchiveError && error.code === "SESSION_DUPLICATE",
    );
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive index refreshes when a duplicate session file is added", async () => {
  const seed = await fixture([]);
  const data = `${records(seed.workspace).map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(seed.file, data, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    await reader.readPage({ sessionId: "session-a" });
    await writeFile(join(seed.sessions, "duplicate-after-cache.jsonl"), data, "utf8");
    await assert.rejects(
      () => reader.readPage({ sessionId: "session-a" }),
      (error: unknown) => error instanceof SessionArchiveError && error.code === "SESSION_DUPLICATE",
    );
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});
test("archive cursor becomes stale after a complete append changes the revision", async () => {
  const seed = await fixture([]);
  const initial = records(seed.workspace).slice(0, 3);
  await writeFile(seed.file, `${initial.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({
      sessionsRoot: seed.sessions,
      allowedCwd: seed.workspace,
      cursorSecret: Buffer.alloc(32, 9),
    });
    const first = await reader.readPage({ sessionId: "session-a", limit: 1 });
    const cursor = first.olderCursor;
    assert.ok(cursor);
    await writeFile(seed.file, `${records(seed.workspace).map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    await assert.rejects(
      () => reader.readPage({ sessionId: "session-a", cursor, limit: 1 }),
      (error: unknown) => error instanceof SessionArchiveError && error.code === "CURSOR_STALE",
    );
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});
