import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactLibrary } from "@omp-studio/studio-host";
import { RuntimeMediaFiles } from "../src/runtime-media-files.js";

test("media input grants are independent and outputs promote once without resurrection after deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-media-files-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: root }); const bridge = new RuntimeMediaFiles(library); const directory = join(root, "private");
    const image = await library.registerBytes({ kind: "image", name: "input.png", mimeType: "image/png" }, Buffer.from("test-image"));
    const one = await bridge.stage(directory, image.artifactId); const two = await bridge.stage(directory, image.artifactId);
    assert.notEqual(one.transferId, two.transferId); assert.equal(one.artifactId, image.artifactId);
    assert.equal(await readFile(join(directory, "inputs", one.transferId + ".bin"), "utf8"), "test-image");
    await bridge.releaseInputs(directory, [one]); assert.equal(await readFile(join(directory, "inputs", two.transferId + ".bin"), "utf8"), "test-image");
    const artifactId = randomUUID(); const jobId = randomUUID(); const bytes = Buffer.from("generated");
    await mkdir(join(directory, "outputs", createHash("sha256").update("s").digest("hex")), { recursive: true }); await writeFile(join(directory, "outputs", createHash("sha256").update("s").digest("hex"), artifactId + ".bin"), bytes);
    const output = { artifactId, kind: "image" as const, name: "output.png", mimeType: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const [first, duplicate] = await Promise.all([bridge.promote(directory, "s", "w", jobId, output), bridge.promote(directory, "s", "w", jobId, output)]);
    assert.equal(first.artifactId, duplicate.artifactId); assert.equal((await library.list({})).total, 2);
    await library.remove(first.artifactId);
    await assert.rejects(() => bridge.promote(directory, "s", "w", jobId, output), /explicitly removed/u);
    assert.equal((await library.list({})).total, 1);
    await assert.rejects(() => bridge.stage(directory, "../../private"), /identifier/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session deletion promotes unread outputs by default and cascades private files only when selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-media-delete-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: root }), bridge = new RuntimeMediaFiles(library), directory = join(root, "private");
    for (const cascade of [false, true]) {
      const sessionId = String(cascade), key = createHash("sha256").update(sessionId).digest("hex"), jobId = randomUUID(), artifactId = randomUUID();
      const bytes = Buffer.from("private-output"), asset = { artifactId, kind: "image", name: "output.png", mimeType: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      const outputs = join(directory, "outputs", key), jobs = join(directory, "jobs", key);
      await mkdir(outputs, { recursive: true }); await mkdir(jobs, { recursive: true });
      await writeFile(join(outputs, artifactId + ".bin"), bytes); await writeFile(join(jobs, jobId + ".json"), JSON.stringify({ job: { id: jobId, sessionId }, outputs: [asset] }));
      await bridge.finishSession(directory, sessionId, cascade); await library.finishSession(sessionId, cascade);
      await assert.rejects(readFile(join(outputs, artifactId + ".bin")), { code: "ENOENT" });
      await assert.rejects(readFile(join(jobs, jobId + ".json")), { code: "ENOENT" });
      assert.equal(JSON.parse(await readFile(join(directory, "deleted-sessions", key + ".json"), "utf8")).cascade, cascade);
    }
    const retained = await library.list({}); assert.equal(retained.total, 1); assert.equal(retained.artifacts[0]!.sessionId, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session HTML exports promote to the library and saved copies survive internal deletion", async () => {
 const root=await mkdtemp(join(tmpdir(),"studio-session-export-"));
 try {
  const library=new ArtifactLibrary({profileDirectory:root}), bridge=new RuntimeMediaFiles(library), directory=join(root,"private");
  const artifactId=randomUUID(),exportId=randomUUID(),sessionId="exported-session",key=createHash("sha256").update(sessionId).digest("hex");
  const bytes=Buffer.from("<html>complete session fixture</html>"),outputs=join(directory,"outputs",key);
  await mkdir(outputs,{recursive:true});await writeFile(join(outputs,artifactId+".bin"),bytes);
  const asset={artifactId,kind:"export" as const,name:"session.html",mimeType:"text/html",bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
  const record=await bridge.promote(directory,sessionId,"workspace",exportId,asset);
  assert.equal(record.kind,"export");
  const stored=await library.resolve(record.artifactId);
  const copy=join(root,"user-saved-copy.html");
  await writeFile(copy,await readFile(stored.path));
  const recovered=await bridge.promote(directory,sessionId,"workspace",exportId,asset);
  assert.equal(recovered.artifactId,record.artifactId);
  await library.remove(record.artifactId);
  await bridge.finishSession(directory,sessionId,true);
  assert.deepEqual(await readFile(copy),bytes);
  await assert.rejects(()=>bridge.promote(directory,sessionId,"workspace",exportId,asset),/explicitly removed/);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("session archive grants require the dedicated transfer path and cannot become media inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-archive-grant-"));
  try {
    const library = new ArtifactLibrary({ profileDirectory: root }), bridge = new RuntimeMediaFiles(library), directory = join(root, "private");
    const archive = await library.registerBytes({ kind: "export", name: "session.tar", mimeType: "application/x-tar" }, Buffer.from("archive bytes"));
    await assert.rejects(() => bridge.stage(directory, archive.artifactId), /unsupported/u);
    const granted = await bridge.stage(directory, archive.artifactId, 1024, "session", true);
    const metadata = JSON.parse(await readFile(join(directory, "inputs", granted.transferId + ".json"), "utf8"));
    assert.equal(metadata.sourceArtifactId, archive.artifactId);
    assert.equal(metadata.sessionId, "session");
    if (process.platform !== "win32") {
      for (const suffix of [".bin", ".json"]) {
        assert.equal((await stat(join(directory, "inputs", granted.transferId + suffix))).mode & 0o777, 0o600);
      }
      assert.equal((await stat(join(directory, "inputs"))).mode & 0o777, 0o700);
    }
    const report = await library.registerBytes({ kind: "export", name: "report.html", mimeType: "text/html" }, Buffer.from("report"));
    await assert.rejects(() => bridge.stage(directory, report.artifactId, 1024, "session", true), /unsupported/u);
    await assert.rejects(() => bridge.stage(directory, archive.artifactId, 2, "session", true), /64 MiB/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
