import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { WorkspaceRegistry } from "@omp-studio/studio-host";
import type { WorkspaceId } from "@omp-studio/client-contract";
import { createWorkspaceFileService } from "../src/workspace-files.js";

async function tryLink(target: string, path: string, type?: "file" | "dir" | "junction"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EUNKNOWN") return false;
    throw error;
  }
}

test("workspace file service returns a relative tree and supports safe mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-explorer-"));
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  try {
    await mkdir(join(root, "project", "src"), { recursive: true });
    await mkdir(join(root, "project", ".codex-backups", "deep"), { recursive: true });
    await mkdir(join(root, "project", "node_modules"));
    await writeFile(join(root, "project", "src", "main.ts"), "export {};");
    await writeFile(join(root, "project", "README.md"), "# demo");
    const workspace = await registry.upsertByPath(join(root, "project"));
    const service = createWorkspaceFileService({ registry });
    const workspaceId = workspace.workspaceId as WorkspaceId;
    const tree = await service.get({ workspaceId });
    assert.deepEqual(tree.nodes.map((node) => node.path), [".codex-backups", "src", "README.md"]);
    assert.equal(tree.nodes[0]?.children, undefined, "root query must not recursively scan large directories");
    const src = await service.get({ workspaceId, path: "src" });
    assert.deepEqual(src.nodes.map((node) => node.path), ["src/main.ts"]);
    await service.createDirectory({ workspaceId, path: "docs" });
    await service.createFile({ workspaceId, path: "docs/guide.md" });
    assert.equal(await readFile(join(root, "project", "docs", "guide.md"), "utf8"), "");
    await assert.rejects(async () => await Promise.resolve(service.createFile({ workspaceId, path: "../escape.txt" })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file mutations reject a last-component symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-explorer-link-"));
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  try {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "outside.txt"), "secret");
    const linked = await tryLink(join(root, "outside.txt"), join(root, "project", "escape.txt"), "file");
    if (!linked) return;
    const workspace = await registry.upsertByPath(join(root, "project"));
    const service = createWorkspaceFileService({ registry });
    await assert.rejects(
      async () => await Promise.resolve(service.createFile({ workspaceId: workspace.workspaceId as WorkspaceId, path: "escape.txt" })),
      /escapes the workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file mutations reject a junction whose parent resolves outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-explorer-junc-"));
  const registry = new WorkspaceRegistry(join(root, "registry.json"));
  try {
    await mkdir(join(root, "project"), { recursive: true });
    await mkdir(join(root, "outside"), { recursive: true });
    const linked = await tryLink(join(root, "outside"), join(root, "project", "trap"), "junction");
    if (!linked) return;
    const workspace = await registry.upsertByPath(join(root, "project"));
    const service = createWorkspaceFileService({ registry });
    await assert.rejects(
      async () => await Promise.resolve(service.createFile({ workspaceId: workspace.workspaceId as WorkspaceId, path: "trap/escape.txt" })),
      /escapes the workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("viewer resolves links to one identity, preserves text format, and detects an Agent edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-file-viewer-"));
  try {
    const project = join(root, "project"); await mkdir(project);
    const path = join(project, "说明 文件.md");
    await writeFile(path, Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("# 中文\r\nfirst\r\n")]));
    const registry = new WorkspaceRegistry(join(root, "registry.json"));
    const workspace = await registry.upsertByPath(project), workspaceId = workspace.workspaceId as WorkspaceId;
    const service = createWorkspaceFileService({ registry });
    const relative = await service.inspect!({ workspaceId, path: "说明 文件.md" });
    const absolute = await service.inspect!({ workspaceId, path });
    assert.equal(relative.id, absolute.id);
    const read = await service.readText!(relative);
    assert.equal(read.text, "# 中文\nfirst\n"); assert.equal(read.bom, true); assert.equal(read.lineEnding, "crlf");
    const saved = await service.writeText!({ ...relative, ...read, text: "# 修改\nsecond\n", expectedVersion: read.file.version });
    assert.equal(saved.saved, true);
    assert.deepEqual(await readFile(path), Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("# 修改\r\nsecond\r\n")]));
    await writeFile(path, "Agent changed this file");
    const conflict = await service.writeText!({ ...relative, ...read, text: "stale draft", expectedVersion: read.file.version });
    assert.equal(conflict.saved, false); assert.equal(await readFile(path, "utf8"), "Agent changed this file");
    await writeFile(join(root, "outside.txt"), "outside");
    await assert.rejects(service.inspect!({ workspaceId, path: join(root, "outside.txt") }), /工作区/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("viewer saves UTF-16 and bounds media reads without loading the whole file", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-file-bytes-"));
  try {
    const registry = new WorkspaceRegistry(join(root, "registry.json"));
    const workspace = await registry.upsertByPath(root), workspaceId = workspace.workspaceId as WorkspaceId;
    const service = createWorkspaceFileService({ registry });
    for (const encoding of ["utf16le", "utf16be"] as const) {
      const text = Buffer.from("中文\r\n", "utf16le"); if (encoding === "utf16be") text.swap16();
      const path = `${encoding}.txt`; await writeFile(join(root, path), Buffer.concat([Buffer.from(encoding === "utf16le" ? [255, 254] : [254, 255]), text]));
      const value = await service.readText!({ workspaceId, path });
      assert.equal(value.encoding, encoding); assert.equal(value.text, "中文\n");
      assert.equal((await service.writeText!({ workspaceId, path, ...value, text: "更新\n", expectedVersion: value.file.version })).saved, true);
      assert.equal((await service.readText!({ workspaceId, path })).text, "更新\n");
    }
    const media = Buffer.alloc(2 * 1024 * 1024, 42); await writeFile(join(root, "movie.mp4"), media);
    const file = await service.inspect!({ workspaceId, path: "movie.mp4" });
    const chunk = await service.readChunk!({ ...file, offset: media.length - 20, length: 100 });
    assert.equal(chunk.bytes, 20); assert.deepEqual(Buffer.from(chunk.data, "base64"), media.subarray(-20));
  } finally { await rm(root, { recursive: true, force: true }); }
});
