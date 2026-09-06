/**
 * Desktop workspace service tests: registry-backed pick/open wired the way
 * `createProductionHostFactory` wires them (real adapter, injected picker,
 * runtime port observing rebind calls). No Electron and no process is ever
 * spawned: the directory picker and the runtime port are fakes.
 */

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { WorkspaceRegistry } from "@omp-studio/studio-host";

import { createOmpWorkspaceService, WorkspacePickCancelledError } from "@omp-studio/host-client-api/workspaces";
import type { StoredWorkspace } from "@omp-studio/studio-host";

function fakePicker(dirs: string[]): () => Promise<string | undefined> {
  let index = 0;
  return async () => {
    const next = dirs[index];
    index += 1;
    return next;
  };
}

test("pick registers the folder; the public list JSON never contains the absolute path", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-ws-service-"));
  const picked = await mkdtemp(join(tmpdir(), "omp-ws-picked-"));
  try {
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    await registry.load();
    const pick = fakePicker([picked]);
    const service = createOmpWorkspaceService({
      registry,
      pickDirectory: pick,
      now: () => "2026-08-14T00:00:00.000Z",
    });

    const model = await service.pick();
    assert.equal(model.workspaces.length, 1);
    assert.equal(model.workspaces[0]!.name, basename(picked));
    assert.equal(model.workspaces[0]!.active, true);
    assert.equal(model.activeWorkspaceId, model.workspaces[0]!.workspaceId);
    const json = JSON.stringify(model);
    assert.ok(!json.includes(picked), "public workspace list must not contain the absolute path");
    assert.ok(!json.includes("C:\\"), "public workspace list must not leak a drive path");
    assert.ok(!json.includes("/Users"), "public workspace list must not leak a home path");
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(picked, { recursive: true, force: true });
  }
});

test("picking the same directory twice yields a single workspace id", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-ws-service-"));
  const picked = await mkdtemp(join(tmpdir(), "omp-ws-picked-"));
  try {
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    await registry.load();
    const pick = fakePicker([picked, picked]);
    const service = createOmpWorkspaceService({
      registry,
      pickDirectory: pick,
    });
    const first = await service.pick();
    const second = await service.pick();
    assert.equal(second.workspaces.length, 1);
    assert.equal(second.workspaces[0]!.workspaceId, first.workspaces[0]!.workspaceId);
    assert.equal(registry.list().length, 1);
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(picked, { recursive: true, force: true });
  }
});

test("a cancelled pickDirectory rejects instead of fabricating a workspace", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-ws-service-"));
  try {
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    await registry.load();
    const service = createOmpWorkspaceService({
      registry,
      pickDirectory: async () => undefined,
    });
    await assert.rejects(() => service.pick(), WorkspacePickCancelledError);
    assert.deepEqual(registry.list(), []);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("onActivated fires with the stored workspace; the runtime port rebind receives its canonical cwd", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-ws-service-"));
  const picked = await mkdtemp(join(tmpdir(), "omp-ws-picked-"));
  try {
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    await registry.load();
    // Fake runtime session port: records rebind calls like the production
    // DesktopRuntimeSessionPort would.
    const rebindCalls: Array<{ workspaceId: string; cwd: string }> = [];
    const port = {
      async rebind(workspace: { workspaceId: string; cwd: string }) {
        rebindCalls.push({ ...workspace });
        return undefined;
      },
    };
    const activated: StoredWorkspace[] = [];
    const service = createOmpWorkspaceService({
      registry,
      pickDirectory: async () => picked,
      onActivated: async (stored) => {
        activated.push(stored);
        await port.rebind({ workspaceId: stored.workspaceId, cwd: stored.canonicalPath });
      },
    });

    const model = await service.pick();
    assert.equal(activated.length, 1);
    assert.equal(rebindCalls.length, 1);
    assert.equal(rebindCalls[0]!.cwd, await realpath(picked));
    assert.equal(rebindCalls[0]!.workspaceId, model.workspaces[0]!.workspaceId);

    // Re-opening the already-active workspace must not restart the Runtime.
    await service.open({ workspaceId: model.workspaces[0]!.workspaceId });
    assert.equal(activated.length, 1, "re-opening the active workspace must not re-activate");
    assert.equal(rebindCalls.length, 1, "re-opening the active workspace must not rebind");
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(picked, { recursive: true, force: true });
  }
});
