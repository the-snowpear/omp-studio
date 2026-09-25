import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactLibrary } from "../src/artifact-library.js";

test("bounded text artifacts round-trip exactly and reject changed payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-artifact-text-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: dir });
    const record = await library.saveText({ kind: "annotation", name: "notes.json", text: '{"note":"原文"}', sessionId: "s" });
    assert.equal((await library.readText(record.artifactId)).text, '{"note":"原文"}');
    assert.throws(() => library.saveText({ kind: "export", name: "../outside.txt", text: "no" }), /filename/u);
    const file = await library.resolve(record.artifactId);
    await writeFile(file.path, '{"note":"改文"}');
    await assert.rejects(library.readText(record.artifactId), /changed/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("session deletion fences streams still in flight and never removes exported copies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-artifacts-delete-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: dir });
    const registration = { kind: "audio" as const, name: "clip.wav", mimeType: "audio/wav", sessionId: "session", workspaceId: "workspace" };
    const saved = await library.registerBytes(registration, Buffer.from("saved"));
    const exported = join(dir, "exported.wav");
    await writeFile(exported, "saved");
    let release!: () => void; let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = library.register(registration, (async function* () { yield Buffer.from("first"); started(); await gate; yield Buffer.from("last"); })());
    const rejection = assert.rejects(pending, /session.*deleted/u);
    await begun; await library.finishSession("session", true); release(); await rejection;
    assert.equal((await library.list()).total, 0);
    await assert.rejects(library.resolve(saved.artifactId), /does not exist/u);
    assert.equal(await readFile(exported, "utf8"), "saved");
    await library.finishSession("retained", false);
    const retained = await library.registerBytes({ ...registration, sessionId: "retained" }, Buffer.from("keep"));
    assert.equal(retained.sessionId, undefined);
    assert.equal(retained.workspaceId, "workspace");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("changing storage roots preserves earlier files; deleting a session retains its generated assets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-artifacts-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: dir });
    const first = await library.registerBytes({ kind: "image", name: "result.png", mimeType: "image/png", sessionId: "one", workspaceId: "workspace" }, Buffer.from("first image"));
    const original = await library.resolve(first.artifactId);
    const external = join(dir, "user-selected");
    await library.setDirectory(external);
    const second = await library.registerBytes({ kind: "video", name: "result.mp4", mimeType: "video/mp4", sessionId: "one" }, Buffer.from("second video"));
    assert.equal((await library.resolve(first.artifactId)).path, original.path);
    assert.ok((await library.resolve(second.artifactId)).path.startsWith(external));
    await library.detachSession("one");
    assert.equal((await library.list({ sessionId: "one" })).total, 0);
    assert.equal((await library.list()).total, 2);
    assert.equal(await readFile(original.path, "utf8"), "first image");
    const reopened = new ArtifactLibrary({ profileDirectory: dir });
    assert.equal((await reopened.list()).total, 2);
    assert.equal((await reopened.state()).locationName, "user-selected");
    await reopened.remove(first.artifactId);
    assert.equal((await reopened.list()).total, 1);
    assert.equal((await reopened.resolve(second.artifactId)).record.sha256.length, 64);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("partial/oversized streams never appear as saved artifacts and do not block reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-artifacts-stream-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: dir, maxArtifactBytes: 5 });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const saving = library.register({ kind: "audio", name: "audio.wav", mimeType: "audio/wav" }, (async function* () {
      yield Buffer.from("123"); started(); await gate; yield Buffer.from("456");
    })());
    const rejected = assert.rejects(saving, /size limit/u);
    await ready;
    assert.equal((await library.list()).total, 0);
    release(); await rejected;
    assert.equal((await library.list()).total, 0);
    assert.deepEqual(await readdir(join(dir, "artifact-library/v1/content")), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("payload validation detects changed files and IDs cannot escape the library", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-artifacts-boundary-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: dir });
    const record = await library.registerBytes({ kind: "export", name: "result.txt", mimeType: "text/plain" }, Buffer.from("original"));
    const { path } = await library.resolve(record.artifactId);
    await writeFile(path, "changed size");
    await assert.rejects(library.resolve(record.artifactId), /changed/u);
    await assert.rejects(library.resolve("../../other"), /Invalid artifact ID/u);
    await assert.rejects(library.remove("../../other"), /Invalid artifact ID/u);
    await assert.rejects(library.list({ limit: 0 }), /page size/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("concurrent completions preserve both records and pagination is deterministic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-artifacts-concurrent-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: dir, now: () => new Date("2026-09-24T00:00:00Z") });
    await Promise.all(["a", "b", "c"].map(name => library.registerBytes({ kind: "transcript", name: `${name}.txt`, mimeType: "text/plain" }, Buffer.from(name))));
    const first = await library.list({ limit: 2 });
    assert.equal(first.total, 3); assert.ok(first.nextCursor);
    const second = await library.list({ limit: 2, cursor: first.nextCursor });
    assert.equal(second.artifacts.length, 1);
    assert.equal(new Set([...first.artifacts, ...second.artifacts].map(item => item.artifactId)).size, 3);
    assert.equal(first.totalBytes, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
