import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { WorkspaceRegistry } from "@omp-studio/studio-host";
import type { WorkspaceId } from "@omp-studio/client-contract";
import { createWorkspaceFileService } from "../src/workspace-files.js";

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
