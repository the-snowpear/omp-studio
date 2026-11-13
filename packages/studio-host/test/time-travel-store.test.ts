import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { TimeTravelStore } from "../src/time-travel-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omp-time-travel-test-"));
  const workspace = join(root, "workspace");
  const profile = join(root, "profile");
  await mkdir(workspace);
  return { workspace, profile, store: new TimeTravelStore(profile) };
}

test("snapshots never capture their own storage when the profile is inside the workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "omp-time-travel-home-"));
  const store = new TimeTravelStore(join(workspace, "profile"));
  await writeFile(join(workspace, "file.txt"), "content");
  await store.capture({ workspace, sessionId: "session", leafId: null, phase: "before" });
  const next = await store.capture({ workspace, sessionId: "session", leafId: "one", phase: "after" });
  assert.deepEqual(next.entries.map(entry => entry.path), ["file.txt"]);
});

test("snapshots exclude their own storage reached through a directory alias", async t => {
  const root = await mkdtemp(join(tmpdir(), "omp-time-travel-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const alias = join(root, "alias");
  await mkdir(workspace);
  await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  const store = new TimeTravelStore(join(alias, "profile"));
  await writeFile(join(workspace, "file.txt"), "content");
  await store.capture({ workspace: alias, sessionId: "session", leafId: null, phase: "before" });
  const next = await store.capture({ workspace: alias, sessionId: "session", leafId: "one", phase: "after" });
  assert.deepEqual(next.entries.map(entry => entry.path), ["file.txt"]);
});

function git(workspace: string, ...args: string[]): string {
  return execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

test("legacy checkpoints expose file counts and remain restorable after metadata migration", async t => {
  const { workspace, profile, store } = await fixture();
  const temporary = await realpath(dirname(workspace));
  t.after(async () => {
    const tail = relative(await realpath(tmpdir()), temporary);
    assert.ok(tail && !isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`));
    await rm(temporary, { recursive: true, force: true });
  });
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const canonicalWorkspace = await realpath(workspace);
  const directory = join(profile, "time-travel/v1/sessions", hash(canonicalWorkspace), hash("session"));
  const contentHash = hash("old content");
  const blobDirectory = join(profile, "time-travel/v1/blobs", contentHash.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await mkdir(blobDirectory, { recursive: true });
  await writeFile(join(blobDirectory, `${contentHash}.gz`), gzipSync("old content"));
  const legacy = {
    id: "legacy-point", sessionId: "session", workspace: hash(canonicalWorkspace),
    leafId: "legacy-leaf", phase: "after", createdAt: "2026-01-01T00:00:00.000Z",
    entries: [{ path: "file.txt", kind: "file", hash: contentHash, mode: 0o644 }],
    changes: { added: 1, modified: 0, deleted: 0 },
  };
  await writeFile(join(directory, `${legacy.id}.json`), JSON.stringify(legacy));
  await writeFile(join(workspace, "file.txt"), "current content");

  const timeline = await store.list(workspace, "session");
  assert.equal(timeline[0]?.id, legacy.id);
  assert.equal(timeline[0]?.fileCount, 1);
  assert.deepEqual(timeline[0]?.changes, legacy.changes);
  const preview = await store.preview(workspace, "session", legacy.id);
  const restored = await store.restore({ workspace, sessionId: "session", snapshotId: legacy.id,
    expectedRevision: preview.revision, leafId: "current-leaf" });
  assert.equal(restored.restored, true);
  assert.equal(await readFile(join(workspace, "file.txt"), "utf8"), "old content");
  assert.equal((await store.list(workspace, "session")).find(row => row.id === restored.backup.id)?.fileCount, 1);
  await store.cleanup(null);
  assert.deepEqual(await store.storage(), { snapshots: 0, bytes: 0 });
});

test("captures untracked files and restores the worktree without changing the index", async () => {
  const { workspace, store } = await fixture();
  git(workspace, "init", "-q");
  await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
  await writeFile(join(workspace, "tracked.txt"), "before\n");
  await writeFile(join(workspace, "new.txt"), "untracked\n");
  await writeFile(join(workspace, "ignored.txt"), "private\n");
  git(workspace, "add", ".gitignore", "tracked.txt");
  const first = await store.capture({
    workspace,
    sessionId: "session",
    leafId: null,
    phase: "before",
  });
  assert.deepEqual(
    first.entries.map((entry) => entry.path),
    [".gitignore", "new.txt", "tracked.txt"],
  );
  await writeFile(join(workspace, "tracked.txt"), "after\n");
  await writeFile(join(workspace, "later.txt"), "later\n");
  const staged = git(workspace, "diff", "--cached");
  const preview = await store.preview(workspace, "session", first.id);
  assert.deepEqual(preview.changes, [
    { path: "later.txt", kind: "delete" },
    { path: "tracked.txt", kind: "modify" },
  ]);
  const result = await store.restore({
    workspace,
    sessionId: "session",
    snapshotId: first.id,
    expectedRevision: preview.revision,
    leafId: "later",
  });
  assert.equal(
    await readFile(join(workspace, "tracked.txt"), "utf8"),
    "before\n",
  );
  assert.equal(
    await readFile(join(workspace, "ignored.txt"), "utf8"),
    "private\n",
  );
  await assert.rejects(readFile(join(workspace, "later.txt")));
  assert.equal(git(workspace, "diff", "--cached"), staged);
  const undo = await store.preview(workspace, "session", result.backup.id);
  await store.restore({
    workspace,
    sessionId: "session",
    snapshotId: result.backup.id,
    expectedRevision: undo.revision,
    leafId: null,
  });
  assert.equal(
    await readFile(join(workspace, "tracked.txt"), "utf8"),
    "after\n",
  );
  assert.equal(await readFile(join(workspace, "later.txt"), "utf8"), "later\n");
});

test("honours ignore rules in ordinary folders and reuses unchanged file contents", async () => {
  const { workspace, profile, store } = await fixture();
  await mkdir(join(workspace, "node_modules"));
  await mkdir(join(workspace, "nested"));
  await writeFile(
    join(workspace, "node_modules", "dependency"),
    "large dependency",
  );
  await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
  await writeFile(join(workspace, "nested", ".gitignore"), "hidden.txt\n");
  await writeFile(join(workspace, "nested", "hidden.txt"), "hidden");
  await writeFile(join(workspace, "nested", "visible.txt"), "content");
  const first = await store.capture({
    workspace,
    sessionId: "session",
    leafId: null,
    phase: "before",
  });
  const second = await store.capture({
    workspace,
    sessionId: "session",
    leafId: "one",
    phase: "after",
  });
  assert.deepEqual(
    first.entries.map((entry) => entry.path),
    [".gitignore", "nested/.gitignore", "nested/visible.txt"],
  );
  assert.deepEqual(first.entries, second.entries);
  const blobs = join(profile, "time-travel", "v1", "blobs");
  const dirs = await readdir(blobs);
  const files = (
    await Promise.all(dirs.map((dir) => readdir(join(blobs, dir))))
  ).flat();
  assert.equal(files.length, 3);
});

test("requires a fresh confirmation when workspace contents change", async () => {
  const { workspace, store } = await fixture();
  await writeFile(join(workspace, "file.txt"), "before");
  const snapshot = await store.capture({
    workspace,
    sessionId: "session",
    leafId: null,
    phase: "before",
  });
  await writeFile(join(workspace, "file.txt"), "first edit");
  const preview = await store.preview(workspace, "session", snapshot.id);
  await writeFile(join(workspace, "file.txt"), "second edit");
  await assert.rejects(
    store.restore({
      workspace,
      sessionId: "session",
      snapshotId: snapshot.id,
      expectedRevision: preview.revision,
      leafId: null,
    }),
    /review the restore again/u,
  );
  assert.equal(
    await readFile(join(workspace, "file.txt"), "utf8"),
    "second edit",
  );
});

test("restores file/directory replacements in both directions, including binary files", async () => {
  const { workspace, store } = await fixture();
  const binary = Buffer.from([0, 255, 13, 10, 0, 128]);
  await writeFile(join(workspace, "asset"), binary);
  const file = await store.capture({
    workspace,
    sessionId: "session",
    leafId: "one",
    phase: "after",
  });
  await rm(join(workspace, "asset"));
  await mkdir(join(workspace, "asset"));
  await writeFile(
    join(workspace, "asset", "child.bin"),
    Buffer.from([42, 0, 12]),
  );
  const directory = await store.capture({
    workspace,
    sessionId: "session",
    leafId: "two",
    phase: "after",
  });
  const preview = await store.preview(workspace, "session", file.id);
  const restored = await store.restore({
    workspace,
    sessionId: "session",
    snapshotId: file.id,
    expectedRevision: preview.revision,
    leafId: "two",
  });
  assert.equal(restored.restored, true);
  assert.deepEqual(await readFile(join(workspace, "asset")), binary);
  const next = await store.preview(workspace, "session", directory.id);
  assert.equal(
    (
      await store.restore({
        workspace,
        sessionId: "session",
        snapshotId: directory.id,
        expectedRevision: next.revision,
        leafId: "one",
      })
    ).restored,
    true,
  );
  assert.deepEqual(
    await readFile(join(workspace, "asset", "child.bin")),
    Buffer.from([42, 0, 12]),
  );
});

test("refuses a directory replacement that would delete excluded work", async () => {
  const { workspace, store } = await fixture();
  await writeFile(join(workspace, "asset"), "original");
  const snapshot = await store.capture({
    workspace,
    sessionId: "session",
    leafId: null,
    phase: "before",
  });
  await rm(join(workspace, "asset"));
  await mkdir(join(workspace, "asset"));
  await writeFile(join(workspace, "asset", "secret"), "private");
  await assert.rejects(
    store.preview(workspace, "session", snapshot.id, ["asset/secret"]),
    /excluded files/u,
  );
  assert.equal(
    await readFile(join(workspace, "asset", "secret"), "utf8"),
    "private",
  );
});

test("a damaged snapshot never starts overwriting the workspace", async () => {
  const { workspace, profile, store } = await fixture();
  await writeFile(join(workspace, "a.txt"), "old a");
  await writeFile(join(workspace, "b.txt"), "old b");
  const snapshot = await store.capture({
    workspace,
    sessionId: "session",
    leafId: null,
    phase: "before",
  });
  const entry = snapshot.entries.find((item) => item.path === "b.txt")!;
  assert.equal(entry.kind, "file");
  if (entry.kind !== "file") return;
  await writeFile(
    join(
      profile,
      "time-travel",
      "v1",
      "blobs",
      entry.hash.slice(0, 2),
      `${entry.hash}.gz`,
    ),
    "corrupted",
  );
  await writeFile(join(workspace, "a.txt"), "current a");
  await writeFile(join(workspace, "b.txt"), "current b");
  const preview = await store.preview(workspace, "session", snapshot.id);
  await assert.rejects(
    store.restore({
      workspace,
      sessionId: "session",
      snapshotId: snapshot.id,
      expectedRevision: preview.revision,
      leafId: "current",
    }),
  );
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "current a");
  assert.equal(await readFile(join(workspace, "b.txt"), "utf8"), "current b");
});

test("cleanup removes unreferenced content and keeps shared blobs for retained snapshots", async () => {
  const { workspace, store } = await fixture();
  await writeFile(join(workspace, "shared.txt"), "shared");
  const first = await store.capture({
    workspace,
    sessionId: "first",
    leafId: null,
    phase: "before",
  });
  await writeFile(join(workspace, "later.txt"), "later");
  const second = await store.capture({
    workspace,
    sessionId: "second",
    leafId: null,
    phase: "before",
  });
  const manifests = await store.storage();
  assert.equal(manifests.snapshots, 2);
  const cutoff = new Date(second.createdAt);
  await store.cleanup(cutoff);
  assert.ok(
    (await store.list(workspace, "second")).some((row) => row.id === second.id),
  );
  assert.ok((await store.storage()).bytes > 0);
  if (first.createdAt < second.createdAt)
    assert.equal((await store.list(workspace, "first")).length, 0);
  await store.cleanup(null);
  assert.deepEqual(await store.storage(), { snapshots: 0, bytes: 0 });
});
