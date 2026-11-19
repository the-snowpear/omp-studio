import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import test, { beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { WorkspaceId } from "@omp-studio/client-contract";
import { WorkspaceRegistry } from "@omp-studio/studio-host";
import { createOmpWorkspaceService } from "@omp-studio/host-client-api/workspaces";
import { createSystemFileService, normalizeSystemPath } from "../src/system-files.js";
import { setDesktopLanguage } from "../src/desktop-language-shared.js";

beforeEach(() => { setDesktopLanguage("zh"); });

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "omp-system-files-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(parse(root).base.startsWith("omp-system-files-"));
    await rm(root, { recursive: true, force: true });
  });
  return { root, registry: new WorkspaceRegistry(join(root, "registry.json")) };
}

test("system browser lists metadata, hidden files and the containing workspace", async t => {
  const { root, registry } = await fixture(t);
  const project = join(root, "project"), src = join(project, "src");
  await mkdir(src, { recursive: true });
  await writeFile(join(src, "notes.txt"), "hello");
  await writeFile(join(src, ".hidden"), "hidden");
  await mkdir(join(src, "folder"));
  const workspace = await registry.upsertByPath(project);
  const service = createSystemFileService({ registry, knownFolders: { downloads: src } });
  const listing = await service.list({ path: src });
  assert.deepEqual(listing.entries.map(entry => entry.name), ["folder", "notes.txt"]);
  const file = listing.entries[1]!;
  assert.equal(file.size, 5);
  assert.ok(file.mtimeMs! > 0);
  assert.deepEqual(listing.workspace, { workspaceId: workspace.workspaceId, relativePath: "src" });
  const viaProject = await service.list({ workspaceId: workspace.workspaceId as WorkspaceId, path: "src", showHidden: true });
  assert.equal(viaProject.path, listing.path);
  assert.equal(viaProject.entries.find(entry => entry.name === ".hidden")?.hidden, true);
  assert.equal((await service.places()).quick.find(place => place.kind === "downloads")?.path, src);
  await assert.rejects(service.list({ workspaceId: workspace.workspaceId as WorkspaceId, path: ".." }), /escapes/);
});

test("system probes and opens use the same home and Windows drive paths", async t => {
  const { root, registry } = await fixture(t);
  const folder = await realpath(root);
  const path = join(folder, "report.txt");
  await writeFile(path, "example report");
  const service = createSystemFileService({ registry });
  const fromHome = relative(homedir(), path).replaceAll("\\", "/");
  const fileAliases = [path, ...(!isAbsolute(fromHome) ? ["~/" + fromHome] : []),
    ...(process.platform === "win32" ? ["/" + path.replaceAll("\\", "/")] : [])];
  assert.deepEqual(await service.resolveAll!({ paths: [...fileAliases, folder] }), [
    ...fileAliases.map(path => ({ path, kind: "file" })),
    { path: folder, kind: "directory" },
  ]);
  for (const alias of fileAliases) assert.equal((await service.readText({ path: alias })).text, "example report");
  assert.equal((await service.list({ path: folder })).path, folder);
});

test("opening a browser folder registers and activates the same project without a picker", async t => {
  const { root, registry } = await fixture(t);
  const activated: string[] = [];
  const workspaces = createOmpWorkspaceService({ registry, pickDirectory: async () => { throw new Error("picker must not open"); }, onActivated: async workspace => { activated.push(workspace.workspaceId); } });
  const first = await workspaces.openPath!({ path: root });
  const again = await workspaces.openPath!({ path: root });
  assert.equal(first.activeWorkspaceId, again.activeWorkspaceId);
  assert.equal(again.workspaces.length, 1);
  assert.deepEqual(activated, [first.activeWorkspaceId, first.activeWorkspaceId]);
  await assert.rejects(workspaces.openPath!({ path: "relative" }), /绝对/);
});

test("system editor preserves format and refuses to overwrite an external edit", async t => {
  const { root, registry } = await fixture(t);
  const path = join(root, "outside.txt");
  await writeFile(path, Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("hello\r\n")]));
  const service = createSystemFileService({ registry });
  const text = await service.readText({ path });
  assert.equal(text.text, "hello\n");
  assert.equal(text.bom, true);
  assert.equal(text.lineEnding, "crlf");
  const saved = await service.writeText({ path, ...text, text: "updated\n", expectedVersion: text.file.version });
  assert.equal(saved.saved, true);
  assert.deepEqual(await readFile(path), Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("updated\r\n")]));
  const chunk = await service.readChunk({ path, version: saved.file.version, offset: 3, length: 7 });
  assert.equal(Buffer.from(chunk.data, "base64").toString(), "updated");
  await writeFile(path, "external");
  assert.equal((await service.writeText({ path, ...text, text: "stale", expectedVersion: saved.file.version })).saved, false);
  assert.equal(await readFile(path, "utf8"), "external");
});

test("create, rename and recycle keep existing files and reject volume roots", async t => {
  const { root, registry } = await fixture(t);
  const recycled: string[] = [];
  const service = createSystemFileService({ registry, trash: async path => { recycled.push(path); } });
  const created = await service.createDirectory({ parent: root, name: "new folder" });
  const renamed = await service.rename({ path: created.path, name: "renamed" });
  await writeFile(join(root, "existing.txt"), "keep");
  await writeFile(join(root, "source.txt"), "source");
  await assert.rejects(service.rename({ path: join(root, "source.txt"), name: "existing.txt" }), /已存在/);
  assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "keep");
  await assert.rejects(service.createDirectory({ parent: root, name: "../outside" }));
  await assert.rejects(service.trash!({ paths: [renamed.path, parse(root).root] }), /根目录/);
  assert.deepEqual(recycled, []);
  await service.trash!({ paths: [renamed.path] });
  assert.deepEqual(recycled, [renamed.path]);
  assert.equal(createSystemFileService({ registry }).trash, undefined);
});

test("file rename preserves content and treats shell punctuation as a literal name", async t => {
  const { root, registry } = await fixture(t);
  const source = join(root, "before.txt"), name = "中文 'notes' [draft] $(literal).txt";
  await writeFile(source, "keep content");
  const service = createSystemFileService({ registry });
  const renamed = await service.rename({ path: source, name });
  // Windows CI can expose TEMP through an 8.3 alias; the service resolves its parent.
  assert.equal(renamed.path, join(await realpath(root), name));
  assert.equal(await readFile(renamed.path, "utf8"), "keep content");
  await assert.rejects(lstat(source), { code: "ENOENT" });
  if (process.platform === "win32") {
    const recased = await service.rename({ path: renamed.path, name: name.replace("notes", "NOTES") });
    assert.equal(await readFile(recased.path, "utf8"), "keep content");
  }
});

test("system file errors follow live desktop language changes", async t => {
  const { root, registry } = await fixture(t);
  const service = createSystemFileService({ registry });
  await writeFile(join(root, "source.txt"), "source");
  await writeFile(join(root, "existing.txt"), "keep");
  setDesktopLanguage("en");
  await assert.rejects(service.rename({ path: join(root, "source.txt"), name: "existing.txt" }), /Destination already exists/);
  setDesktopLanguage("zh");
  await assert.rejects(service.rename({ path: join(root, "source.txt"), name: "existing.txt" }), /目标名称已存在/);
  assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "keep");
});

test("a separate process creating the rename destination cannot be overwritten", async t => {
  const { root, registry } = await fixture(t);
  const service = createSystemFileService({ registry });
  for (const kind of ["file", "dir"] as const) {
    const source = join(root, `source-${kind}`), destination = join(root, `destination-${kind}`);
    if (kind === "dir") { await mkdir(source); await writeFile(join(source, "original.txt"), "original"); }
    else await writeFile(source, "original");
    const child = spawn(process.execPath, ["-e", `
      const fs = require('node:fs/promises');
      process.once('message', async ({ path, kind }) => {
        try {
          if (kind === 'dir') { await fs.mkdir(path); await fs.writeFile(require('node:path').join(path, 'external.txt'), 'external'); }
          else await fs.writeFile(path, 'external', { flag: 'wx' });
          process.send({ created: true });
        } catch (error) { process.send({ created: false, code: error.code }); }
        process.disconnect();
      });
      process.send('ready');
    `], { stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true });
    t.after(() => { child.kill(); });
    const closed = once(child, "close");
    await once(child, "message");
    const external = once(child, "message");
    const renamed = service.rename({ path: source, name: `destination-${kind}` }).then(() => true, error => { assert.match(error.message, /已存在/); return false; });
    child.send({ path: destination, kind });
    const [didRename, [result]] = await Promise.all([renamed, external]);
    await closed;
    assert.notEqual(didRename, result.created);
    const contentPath = (path: string, owner: string) => kind === "dir" ? join(path, `${owner}.txt`) : path;
    assert.equal(await readFile(contentPath(destination, didRename ? "original" : "external"), "utf8"), didRename ? "original" : "external");
    if (!didRename) assert.equal(await readFile(contentPath(source, "original"), "utf8"), "original");
    else assert.equal(result.code, "EEXIST");
  }
});

test("system browser bounds large directories at 5000 entries", async t => {
  const { root, registry } = await fixture(t);
  for (let start = 0; start < 5001; start += 128) {
    await Promise.all(Array.from({ length: Math.min(128, 5001 - start) }, (_, index) => writeFile(join(root, `item-${start + index}.txt`), "")));
  }
  const listing = await createSystemFileService({ registry }).list({ path: root });
  assert.equal(listing.entries.length, 5000);
  assert.equal(listing.truncated, true);
});

test("system paths reject relative, NUL and Windows device paths", async t => {
  const { registry } = await fixture(t);
  const service = createSystemFileService({ registry });
  await assert.rejects(service.list({ path: "relative" }), /绝对/);
  await assert.rejects(service.inspect({ path: "bad\0path" }), /NUL/);
  if (process.platform === "win32") {
    for (const path of ["\\\\.\\C:", "\\\\?\\C:\\file", "C:\\NUL.txt", "C:\\file:stream"]) assert.throws(() => normalizeSystemPath(path), /设备|数据流/);
    assert.equal(normalizeSystemPath("\\\\server\\share\\folder"), "\\\\server\\share\\folder");
  }
});

test("reading a symlink is allowed, saving never writes through it", async t => {
  const { root, registry } = await fixture(t);
  const target = join(root, "target.txt"), path = join(root, "link.txt");
  await writeFile(target, "keep target");
  try { await symlink(target, path, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EUNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("File symlinks unavailable on this machine"); return; }
    throw error;
  }
  const service = createSystemFileService({ registry });
  const file = await service.readText({ path });
  assert.equal(file.text, "keep target");
  await assert.rejects(service.writeText({ path, ...file, text: "changed", expectedVersion: file.file.version }), /符号链接/);
  assert.equal(await readFile(target, "utf8"), "keep target");
});
