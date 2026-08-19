import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONVERSATION_LIMITS } from "@omp-studio/studio-protocol";

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
      if (call?.type === "toolCall") assert.deepEqual(call.arguments, { path: "README.md", apiKey: "[redacted]" });
    }
    const older = await reader.readPage({ sessionId: "session-a", cursor: latest.olderCursor, limit: 2 });
    assert.deepEqual(older.items.map((item) => item.itemId), ["user-1"]);
    assert.equal(older.hasMoreBefore, false);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader omits developer and synthetic/steering user harness messages", async () => {
  const seed = await fixture([]);
  const entries: Entry[] = [
    { type: "session", id: "session-a", cwd: seed.workspace, timestamp: "2026-08-15T00:00:00.000Z" },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-15T00:00:01.000Z",
      message: { role: "user", content: "hello" },
    },
    {
      type: "message",
      id: "developer-1",
      parentId: "user-1",
      timestamp: "2026-08-15T00:00:01.500Z",
      message: {
        role: "developer",
        content: [{ type: "text", text: "<system-reminder>\nYou stopped with 2 incomplete todo item(s):\n</system-reminder>" }],
        attribution: "agent",
      },
    },
    {
      type: "message",
      id: "synthetic-1",
      parentId: "developer-1",
      timestamp: "2026-08-15T00:00:01.600Z",
      message: {
        role: "user",
        content: "<instruction>MUST read local://annotation-channel-v2-plan.md</instruction>",
        synthetic: true,
      },
    },
    {
      type: "message",
      id: "steer-1",
      parentId: "synthetic-1",
      timestamp: "2026-08-15T00:00:01.700Z",
      message: { role: "user", content: "steer the turn", steering: true },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "steer-1",
      timestamp: "2026-08-15T00:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    },
  ];
  await writeFile(seed.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({
      sessionsRoot: seed.sessions,
      allowedCwd: seed.workspace,
      cursorSecret: Buffer.alloc(32, 7),
    });
    const page = await reader.readPage({ sessionId: "session-a", limit: 10 });
    assert.deepEqual(page.items.map((item) => item.itemId), ["user-1", "assistant-1"]);
    const serialized = JSON.stringify(page);
    assert.equal(serialized.includes("system-reminder"), false);
    assert.equal(serialized.includes("<instruction>"), false);
    assert.equal(serialized.includes("steer the turn"), false);
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
        data: { lines: 3, preview: ["one", "two", "three"], token: "[redacted]" },
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

test("archive reader exposes revisions and validated probe copies without touching the original", async () => {
  const seed = await fixture([]);
  const complete = `${records(seed.workspace).map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  // Simulate a crash-truncated tail: an incomplete final line must be dropped.
  await writeFile(seed.file, `${complete}{"type":"message","id":"tail-partial"`, "utf8");
  const probeDir = join(seed.root, "probe");
  await mkdir(probeDir);
  try {
    const reader = new StudioSessionArchiveReader({
      sessionsRoot: seed.sessions,
      allowedCwd: seed.workspace,
      cursorSecret: Buffer.alloc(32, 7),
    });
    const revision = await reader.readRevision("session-a");
    assert.equal(revision.sessionId, "session-a");
    assert.match(revision.transcriptRevision, /^sha256:/u);

    const before = await (await import("node:fs/promises")).stat(seed.file);
    const copy = await reader.createProbeCopy("session-a", probeDir);
    assert.equal(copy.sessionId, "session-a");
    assert.equal(copy.transcriptRevision, revision.transcriptRevision);
    assert.ok(copy.temporarySessionFile.startsWith(probeDir));
    const copyContent = await (await import("node:fs/promises")).readFile(copy.temporarySessionFile, "utf8");
    assert.equal(copyContent, complete);
    const after = await (await import("node:fs/promises")).stat(seed.file);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);

    await assert.rejects(() => reader.readRevision("session-missing"), (error: unknown) => {
      assert.ok(error instanceof SessionArchiveError);
      assert.equal(error.code, "SESSION_NOT_FOUND");
      return true;
    });
    await assert.rejects(() => reader.createProbeCopy("session-missing", probeDir), /Session is not available/u);
    await assert.rejects(() => reader.createProbeCopy("session-a", join(seed.root, "no-such-dir")), /usable directory/u);
    await assert.rejects(() => reader.createProbeCopy("session-a", "relative/dir"), /absolute directory/u);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader pages cold-archive .jsonl.gz sessions with the same workspace gate", async () => {
  const seed = await fixture([]);
  const complete = `${records(seed.workspace).map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  // Simulate omp gc: gzip the session into <agentDir>/archive/sessions keeping the layout.
  const archiveProject = join(seed.root, "archive", "sessions", "project");
  await mkdir(archiveProject, { recursive: true });
  const { gzipSync } = await import("node:zlib");
  const gz = join(archiveProject, "2026-08-15T00-00-00-000Z_session-a.jsonl.gz");
  await writeFile(gz, gzipSync(Buffer.from(complete, "utf8"), { level: 9 }));
  await rm(seed.file, { force: true });
  try {
    const reader = new StudioSessionArchiveReader({
      sessionsRoot: seed.sessions,
      allowedCwd: seed.workspace,
      cursorSecret: Buffer.alloc(32, 7),
    });
    const page = await reader.readPage({ sessionId: "session-a", limit: 10 });
    assert.equal(page.sessionId, "session-a");
    assert.equal(page.items.length, 3);
    assert.equal(page.items[0]?.kind, "message");
    assert.match(page.transcriptRevision, /^sha256:/u);

    const revision = await reader.readRevision("session-a");
    assert.equal(revision.sessionId, "session-a");

    const probeDir = join(seed.root, "probe");
    await mkdir(probeDir);
    const copy = await reader.createProbeCopy("session-a", probeDir);
    const copyContent = await (await import("node:fs/promises")).readFile(copy.temporarySessionFile, "utf8");
    assert.equal(copyContent, complete);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader shrinks over-budget pages below PAGE_MAX_BYTES and keeps paging consistent", async () => {
  const seed = await fixture([]);
  const bigText = "x".repeat(300 * 1024);
  const entries: Entry[] = [{ type: "session", id: "session-a", cwd: seed.workspace, timestamp: "2026-08-15T00:00:00.000Z" }];
  let parentId: string | null = null;
  for (let index = 1; index <= 4; index += 1) {
    const id = `big-${index}`;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: `2026-08-15T00:00:0${index}.000Z`,
      message: { role: "user", content: `${id}:${bigText}` },
    });
    parentId = id;
  }
  await writeFile(seed.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    const page = await reader.readPage({ sessionId: "session-a", limit: 10 });
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= CONVERSATION_LIMITS.PAGE_MAX_BYTES);
    assert.ok(page.items.length >= 1 && page.items.length < 4);
    assert.equal(page.items.at(-1)?.itemId, "big-4");
    assert.equal(page.hasMoreBefore, true);
    assert.ok(page.olderCursor);
    const older = await reader.readPage({ sessionId: "session-a", cursor: page.olderCursor, limit: 10 });
    assert.ok(Buffer.byteLength(JSON.stringify(older), "utf8") <= CONVERSATION_LIMITS.PAGE_MAX_BYTES);
    const firstOnPage = page.items[0]?.itemId;
    assert.ok(firstOnPage !== undefined && !older.items.some((item) => item.itemId === firstOnPage));
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader shrinks a single item that alone exceeds the page budget", async () => {
  const seed = await fixture([]);
  const bigText = "y".repeat(300 * 1024);
  const entries: Entry[] = [
    { type: "session", id: "session-a", cwd: seed.workspace, timestamp: "2026-08-15T00:00:00.000Z" },
    {
      type: "message",
      id: "huge-1",
      parentId: null,
      timestamp: "2026-08-15T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: bigText },
          { type: "text", text: bigText },
          { type: "text", text: bigText },
        ],
      },
    },
  ];
  await writeFile(seed.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    const page = await reader.readPage({ sessionId: "session-a", limit: 10 });
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= CONVERSATION_LIMITS.PAGE_MAX_BYTES);
    assert.equal(page.items.length, 1);
    const item = page.items[0];
    assert.equal(item?.kind, "message");
    if (item?.kind === "message") {
      for (const block of item.content) {
        assert.equal(block.type, "text");
        if (block.type === "text") {
          assert.ok(Buffer.byteLength(block.text, "utf8") <= 256);
          assert.equal(block.truncated, true);
        }
      }
    }
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader accepts an empty-boundary head cursor from an empty projection", async () => {
  const seed = await fixture([]);
  await writeFile(
    seed.file,
    `${JSON.stringify({ type: "session", id: "session-a", cwd: seed.workspace, timestamp: "2026-08-15T00:00:00.000Z" })}\n`,
    "utf8",
  );
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    const head = await reader.readPage({ sessionId: "session-a" });
    assert.deepEqual(head.items, []);
    const paged = await reader.readPage({ sessionId: "session-a", cursor: head.headCursor });
    assert.deepEqual(paged.items, []);
    assert.equal(paged.hasMoreBefore, false);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader emits image placeholders and shortens home paths like the online read plane", async () => {
  const seed = await fixture([]);
  const homePath = join(homedir(), "secret.txt");
  const entries: Entry[] = [
    { type: "session", id: "session-a", cwd: seed.workspace, timestamp: "2026-08-15T00:00:00.000Z" },
    {
      type: "message",
      id: "mixed-1",
      parentId: null,
      timestamp: "2026-08-15T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "image", data: "base64-bytes", mimeType: "image/png" },
          { type: "text", text: homePath },
          { type: "toolCall", id: "call-home", name: "Read", arguments: { path: homePath } },
        ],
      },
    },
  ];
  await writeFile(seed.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    const page = await reader.readPage({ sessionId: "session-a", limit: 10 });
    const item = page.items[0];
    assert.equal(item?.kind, "message");
    if (item?.kind === "message") {
      assert.deepEqual(item.content[0], { type: "text", text: "", truncated: true });
      assert.equal(item.content[1]?.type, "text");
      if (item.content[1]?.type === "text") assert.equal(item.content[1].text, "~/secret.txt");
      assert.equal(item.content[2]?.type, "toolCall");
      if (item.content[2]?.type === "toolCall") {
        assert.deepEqual(item.content[2].arguments, { path: "~/secret.txt" });
      }
    }
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader inserts orphan tool results in chronological order", async () => {
  const seed = await fixture([]);
  const entries: Entry[] = [
    { type: "session", id: "session-a", cwd: seed.workspace, timestamp: "2026-08-15T00:00:00.000Z" },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-15T00:00:01.000Z",
      message: { role: "user", content: "hi" },
    },
    {
      type: "message",
      id: "orphan-1",
      parentId: "user-1",
      timestamp: "2026-08-15T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "missing",
        toolName: "Bash",
        content: [{ type: "text", text: "out" }],
        isError: false,
      },
    },
    {
      type: "message",
      id: "user-2",
      parentId: "orphan-1",
      timestamp: "2026-08-15T00:00:03.000Z",
      message: { role: "user", content: "later" },
    },
  ];
  await writeFile(seed.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    const page = await reader.readPage({ sessionId: "session-a", limit: 10 });
    assert.deepEqual(page.items.map((item) => item.itemId), ["user-1", "orphan-1", "user-2"]);
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader marks omitted tool-result images and unique empty ids", async () => {
  const seed = await fixture([]);
  const entries: Entry[] = [
    { type: "session", id: "session-a", cwd: seed.workspace, timestamp: "2026-08-15T00:00:00.000Z" },
    {
      type: "message",
      id: "res-1",
      parentId: null,
      timestamp: "2026-08-15T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "",
        toolName: "Read",
        content: [
          { type: "text", text: "caption" },
          { type: "image", data: "base64", mimeType: "image/png" },
        ],
        details: { token: "secret" },
        isError: false,
      },
    },
    {
      type: "message",
      id: "res-2",
      parentId: "res-1",
      timestamp: "2026-08-15T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "",
        toolName: "Read",
        content: [{ type: "text", text: "other" }],
        isError: false,
      },
    },
  ];
  await writeFile(seed.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    const page = await reader.readPage({ sessionId: "session-a", limit: 10 });
    assert.equal(page.items.length, 2);
    const first = page.items[0];
    assert.equal(first?.kind, "message");
    if (first?.kind === "message") {
      const result = first.content.find((block) => block.type === "toolResult");
      assert.equal(result?.type, "toolResult");
      if (result?.type === "toolResult") {
        assert.equal(result.output, "caption");
        assert.equal(result.truncated, true);
        assert.deepEqual(result.data, { token: "[redacted]", omitted: "image" });
        assert.notEqual(result.toolCallId, "tool-call");
      }
    }
    const second = page.items[1];
    assert.equal(second?.kind, "message");
    if (first?.kind === "message" && second?.kind === "message") {
      const left = first.content.find((block) => block.type === "toolResult");
      const right = second.content.find((block) => block.type === "toolResult");
      assert.notEqual(
        left?.type === "toolResult" ? left.toolCallId : "",
        right?.type === "toolResult" ? right.toolCallId : "",
      );
    }
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader caps oversized toolCall arguments instead of emitting an over-budget block", async () => {
  const seed = await fixture([]);
  const entries: Entry[] = [
    { type: "session", id: "session-a", cwd: seed.workspace, timestamp: "2026-08-15T00:00:00.000Z" },
    {
      type: "message",
      id: "big-args-1",
      parentId: null,
      timestamp: "2026-08-15T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-big", name: "Write", arguments: { blob: "z".repeat(300 * 1024) } }],
      },
    },
  ];
  await writeFile(seed.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({ sessionsRoot: seed.sessions, allowedCwd: seed.workspace });
    const page = await reader.readPage({ sessionId: "session-a", limit: 10 });
    const item = page.items[0];
    assert.equal(item?.kind, "message");
    if (item?.kind === "message") {
      assert.deepEqual(item.content[0], {
        type: "toolCall",
        toolCallId: "call-big",
        toolName: "Write",
        arguments: { truncated: true },
        truncated: true,
      });
    }
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader keeps the workspace boundary for gz members and caps their decompressed size", async () => {
  const seed = await fixture([]);
  const complete = `${records(seed.workspace).map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const archiveProject = join(seed.root, "archive", "sessions", "project");
  await mkdir(archiveProject, { recursive: true });
  const { gzipSync } = await import("node:zlib");
  await writeFile(join(archiveProject, "2026-08-15T00-00-00-000Z_session-a.jsonl.gz"), gzipSync(Buffer.from(complete, "utf8")));
  await rm(seed.file, { force: true });
  try {
    const foreign = new StudioSessionArchiveReader({
      sessionsRoot: seed.sessions,
      allowedCwd: join(seed.root, "another-workspace"),
      cursorSecret: Buffer.alloc(32, 7),
    });
    await assert.rejects(() => foreign.readPage({ sessionId: "session-a", limit: 5 }), (error: unknown) => {
      assert.ok(error instanceof SessionArchiveError);
      assert.equal(error.code, "WORKSPACE_MISMATCH");
      return true;
    });

    // Decompressed cap: a member larger than maxSessionBytes once inflated
    // indexes fine (the header scan stops after its 64KB prefix) but must
    // fail closed when the full page read inflates past the cap.
    const big = [
      JSON.stringify({ type: "session", version: 3, id: "session-a", cwd: seed.workspace, timestamp: "2026-08-15T00:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "m-1", parentId: null, timestamp: "2026-08-15T00:00:01.000Z", message: { role: "user", content: "x".repeat(120_000) } }),
    ].join("\n") + "\n";
    await writeFile(join(archiveProject, "2026-08-15T00-00-00-000Z_session-a.jsonl.gz"), gzipSync(Buffer.from(big, "utf8")));
    const capped = new StudioSessionArchiveReader({
      sessionsRoot: seed.sessions,
      allowedCwd: seed.workspace,
      maxSessionBytes: 65_600,
      cursorSecret: Buffer.alloc(32, 7),
    });
    await assert.rejects(() => capped.readPage({ sessionId: "session-a", limit: 5 }), (error: unknown) => {
      assert.ok(error instanceof SessionArchiveError);
      assert.equal(error.code, "SESSION_TOO_LARGE");
      return true;
    });
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("archive reader pages a persisted child transcript next to the parent session file", async () => {
  const seed = await fixture(records("wrong-cwd"));
  const childDir = join(seed.sessions, "session");
  await mkdir(childDir);
  await writeFile(
    join(childDir, "WorkerEcho.jsonl"),
    [
      JSON.stringify({ type: "session", id: "child-echo", cwd: seed.workspace, timestamp: "2026-08-18T00:00:00.000Z" }),
      JSON.stringify({
        type: "session_init",
        id: "init-1",
        parentId: null,
        timestamp: "2026-08-18T00:00:00.000Z",
        task: "Complete the assignment below, thoroughly: You are a demo worker.",
      }),
      JSON.stringify({
        type: "message",
        id: "child-user",
        parentId: null,
        timestamp: "2026-08-18T00:00:01.000Z",
        message: { role: "user", content: "simulate a style pass" },
      }),
      JSON.stringify({
        type: "message",
        id: "child-assistant",
        parentId: "child-user",
        timestamp: "2026-08-18T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input: 10, output: 8, cost: { total: 0.003 } },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(seed.file, `${records(seed.workspace).map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  try {
    const reader = new StudioSessionArchiveReader({
      sessionsRoot: seed.sessions,
      allowedCwd: seed.workspace,
      cursorSecret: Buffer.alloc(32, 7),
    });
    const page = await reader.readPage({ sessionId: "session-a", agentId: "WorkerEcho", limit: 10 });
    assert.equal(page.sessionId, "child-echo");
    assert.equal(page.items.some((item) => item.kind === "message" && item.role === "user"), true);
    const listed = await reader.listPersistedAgents("session-a");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.agentId, "WorkerEcho");
    assert.equal(listed[0]?.status, "parked");
    assert.equal(listed[0]?.usage?.requests, 1);
    await assert.rejects(
      () => reader.readPage({ sessionId: "session-a", agentId: "MissingAgent" }),
      (error: unknown) => error instanceof SessionArchiveError && error.code === "AGENT_NOT_FOUND",
    );
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});

test("agent-scoped archive reads still require the parent session to belong to the workspace", async () => {
  const seed = await fixture(records("wrong-cwd"));
  const childDir = join(seed.sessions, "session");
  await mkdir(childDir);
  await writeFile(
    join(childDir, "WorkerEcho.jsonl"),
    [
      JSON.stringify({ type: "session", id: "child-echo", cwd: seed.workspace, timestamp: "2026-08-18T00:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        id: "child-user",
        parentId: null,
        timestamp: "2026-08-18T00:00:01.000Z",
        message: { role: "user", content: "simulate a style pass" },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  try {
    const reader = new StudioSessionArchiveReader({
      sessionsRoot: seed.sessions,
      allowedCwd: seed.workspace,
      cursorSecret: Buffer.alloc(32, 7),
    });
    await assert.rejects(
      () => reader.readPage({ sessionId: "session-a", agentId: "WorkerEcho", limit: 10 }),
      (error: unknown) => error instanceof SessionArchiveError && error.code === "WORKSPACE_MISMATCH",
    );
    await assert.rejects(
      () => reader.listPersistedAgents("session-a"),
      (error: unknown) => error instanceof SessionArchiveError && error.code === "WORKSPACE_MISMATCH",
    );
  } finally {
    await rm(seed.root, { recursive: true, force: true });
  }
});
