/**
 * WorkspaceRegistry contract tests.
 *
 * Uses a throwaway temp profile so no real user state is touched. The
 * registry is a Host-internal module, so tests may assert `canonicalPath`
 * directly here; the client-facing list must never carry paths (that is the
 * adapter's job, covered by the facade tests).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkspaceRegistry } from "../src/index.js";

const T0 = "2026-08-14T00:00:00.000Z";

async function withRegistry(run: (registry: WorkspaceRegistry, profile: string) => Promise<void>): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), "omp-workspace-registry-"));
  try {
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    await registry.load();
    await run(registry, profile);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

test("upserting the same path twice yields the same workspace id", async () => {
  await withRegistry(async (registry, profile) => {
    const dir = join(profile, "alpha");
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
    const first = await registry.upsertByPath(dir, T0);
    const second = await registry.upsertByPath(dir, "2026-08-14T01:00:00.000Z");
    assert.equal(second.workspaceId, first.workspaceId);
    assert.equal(second.name, "alpha");
    assert.equal(second.lastOpenedAt, "2026-08-14T01:00:00.000Z");
    assert.equal(registry.list().length, 1);
  });
});

test("a missing directory throws and registers nothing", async () => {
  await withRegistry(async (registry, profile) => {
    const missing = join(profile, "does-not-exist");
    await assert.rejects(() => registry.upsertByPath(missing, T0), /does not exist/u);
    assert.deepEqual(registry.list(), []);
  });
});

test("a regular file is rejected as a workspace directory", async () => {
  await withRegistry(async (registry, profile) => {
    const file = join(profile, "file.txt");
    await writeFile(file, "not a directory");
    await assert.rejects(() => registry.upsertByPath(file, T0), /not a directory/u);
  });
});

test("list() returns records including the Host-only canonicalPath", async () => {
  await withRegistry(async (registry, profile) => {
    const dirA = join(profile, "aaa");
    const dirB = join(profile, "bbb");
    const fs = await import("node:fs/promises");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await registry.upsertByPath(dirA, "2026-08-14T02:00:00.000Z");
    await registry.upsertByPath(dirB, "2026-08-14T03:00:00.000Z");
    const list = registry.list();
    // Newest first.
    assert.equal(list[0]!.name, "bbb");
    assert.equal(list[1]!.name, "aaa");
    for (const entry of list) {
      assert.equal(typeof entry.canonicalPath, "string");
      assert.ok(entry.canonicalPath.length > 0, "Host list must carry the canonical path");
      assert.equal(entry.workspaceId.length > 0, true);
    }
  });
});

test("touch updates lastOpenedAt and makes the workspace active", async () => {
  await withRegistry(async (registry, profile) => {
    const dir = join(profile, "alpha");
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    const stored = await registry.upsertByPath(dir, T0);
    assert.equal(registry.activeWorkspaceId, stored.workspaceId);
    const touched = await registry.touch(stored.workspaceId, "2026-08-14T04:00:00.000Z");
    assert.equal(touched.lastOpenedAt, "2026-08-14T04:00:00.000Z");
    assert.equal(registry.activeWorkspaceId, stored.workspaceId);
  });
});

test("touch throws for an unknown id and for a vanished directory", async () => {
  await withRegistry(async (registry, profile) => {
    await assert.rejects(() => registry.touch("nope", T0), /unknown workspace id/u);
    const dir = join(profile, "alpha");
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    const stored = await registry.upsertByPath(dir, T0);
    await fs.rm(dir, { recursive: true, force: true });
    await assert.rejects(() => registry.touch(stored.workspaceId, T0), /no longer exists/u);
  });
});

test("a fresh registry reloads the persisted file", async () => {
  await withRegistry(async (registry, profile) => {
    const dir = join(profile, "alpha");
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    await registry.upsertByPath(dir, T0);
    const reloaded = new WorkspaceRegistry(registry.path);
    await reloaded.load();
    const list = reloaded.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "alpha");
    assert.equal(list[0]!.canonicalPath.length > 0, true);
    assert.equal(reloaded.activeWorkspaceId, registry.activeWorkspaceId);
  });
});
