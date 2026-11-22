/**
 * Desktop workspace service tests: registry-backed pick/open wired the way
 * `createProductionHostFactory` wires them (real adapter, injected picker,
 * runtime port observing rebind calls). No Electron and no process is ever
 * spawned: the directory picker and the runtime port are fakes.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { WorkspaceRegistry, canonicalWorkspacePath } from "@omp-studio/studio-host";
import type { WorkspaceId } from "@omp-studio/client-contract";

import { createOmpWorkspaceService, WorkspacePickCancelledError } from "@omp-studio/host-client-api/workspaces";
import type { StoredWorkspace } from "@omp-studio/studio-host";
import { createDesktopRuntimeSessionPort } from "../src/runtime-session.js";
import type { DesktopRuntimeSession, DesktopRuntimeSessionPort } from "../src/host-composition.js";
import { InMemorySessionLeaseStore } from "@omp-studio/studio-host";

function fakePicker(dirs: string[]): () => Promise<string | undefined> {
  let index = 0;
  return async () => {
    const next = dirs[index];
    index += 1;
    return next;
  };
}

test("pick registers the folder and returns its canonical root for display", async () => {
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
    assert.equal(model.workspaces[0]!.root, await canonicalWorkspacePath(picked));
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
    // realpath on Windows; on macOS also without the /private prefix of /var.
    assert.equal(rebindCalls[0]!.cwd, await canonicalWorkspacePath(picked));
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

test("remove drops one record and re-activates the surviving workspace", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-ws-service-"));
  const dirA = join(profile, "aaa"), dirB = join(profile, "bbb");
  try {
    await Promise.all([dirA, dirB].map(dir => mkdir(dir)));
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    await registry.load();
    const a = await registry.upsertByPath(dirA, "2026-08-14T00:00:00.000Z");
    const b = await registry.upsertByPath(dirB, "2026-08-14T01:00:00.000Z");
    const activated: StoredWorkspace[] = [];
    const service = createOmpWorkspaceService({
      registry,
      pickDirectory: async () => undefined,
      onActivated: async (stored) => { activated.push(stored); },
    });

    const model = await service.remove!({ workspaceId: b.workspaceId as WorkspaceId });
    assert.equal(model.workspaces.length, 1);
    assert.equal(model.workspaces[0]!.workspaceId, a.workspaceId);
    assert.equal(model.workspaces[0]!.active, true);
    assert.equal(model.activeWorkspaceId, a.workspaceId);
    // The runtime rebinds to the surviving workspace's canonical cwd.
    assert.equal(activated.length, 1);
    assert.equal(activated[0]!.canonicalPath, await canonicalWorkspacePath(dirA));
    // The directory itself is untouched.
    assert.ok(existsSync(dirB));
    await assert.rejects(() => service.remove!({ workspaceId: "nope" as WorkspaceId }), /unknown workspace id/u);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("remove with deleteSessions sweeps the stored project's sessions before dropping the record", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-ws-service-"));
  const dirA = join(profile, "aaa"), dirB = join(profile, "bbb");
  try {
    await Promise.all([dirA, dirB].map(dir => mkdir(dir)));
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    await registry.load();
    const a = await registry.upsertByPath(dirA, "2026-08-14T00:00:00.000Z");
    const b = await registry.upsertByPath(dirB, "2026-08-14T01:00:00.000Z");
    const swept: string[] = [];
    const service = createOmpWorkspaceService({
      registry,
      pickDirectory: async () => undefined,
      onActivated: async () => undefined,
      deleteWorkspaceSessions: async (cwd) => { swept.push(cwd); return { deleted: 3, warnings: 0 }; },
    });

    // Sweeping runs against the removed project's canonical cwd, then the
    // record drops and the survivor activates.
    const model = await service.remove!({ workspaceId: b.workspaceId as WorkspaceId, deleteSessions: true });
    assert.deepEqual(swept, [await canonicalWorkspacePath(dirB)]);
    assert.equal(model.workspaces.length, 1);
    assert.equal(model.workspaces[0]!.workspaceId, a.workspaceId);
    assert.equal(model.activeWorkspaceId, a.workspaceId);
    assert.ok(existsSync(dirB));

    // Without the flag the sweep is not requested.
    swept.length = 0;
    await service.remove!({ workspaceId: a.workspaceId as WorkspaceId });
    assert.equal(swept.length, 0);
    assert.equal(registry.list().length, 0);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("remove keeps the record when the session sweep fails (no half-removed project)", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-ws-service-"));
  const dirA = join(profile, "aaa"), dirB = join(profile, "bbb");
  try {
    await Promise.all([dirA, dirB].map(dir => mkdir(dir)));
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    await registry.load();
    await registry.upsertByPath(dirA, "2026-08-14T00:00:00.000Z");
    const b = await registry.upsertByPath(dirB, "2026-08-14T01:00:00.000Z");
    const service = createOmpWorkspaceService({
      registry,
      pickDirectory: async () => undefined,
      onActivated: async () => undefined,
      deleteWorkspaceSessions: async () => { throw new Error("Session cleanup is not available on this Host"); },
    });

    // The sweep throws before the record is removed, so the command fails and
    // the project stays in the list (retryable).
    await assert.rejects(
      () => service.remove!({ workspaceId: b.workspaceId as WorkspaceId, deleteSessions: true }),
      /Session cleanup is not available/u,
    );
    assert.equal(registry.list().length, 2);
    assert.ok(registry.get(b.workspaceId) !== undefined);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("a stale workspace and failed saved session restore do not block a fresh Runtime in the available project", async () => {
  const profile = await mkdtemp(join(tmpdir(), "omp-workspace-recovery-"));
  let port: DesktopRuntimeSessionPort | undefined;
  try {
    const valid = join(profile, "project"), old = join(profile, "old-install", "runtime");
    await mkdir(valid); await mkdir(old, { recursive: true });
    const registry = new WorkspaceRegistry(join(profile, "workspaces.json"));
    const project = await registry.upsertByPath(valid);
    const stale = await registry.upsertByPath(old);
    await rm(join(profile, "old-install"), { recursive: true });
    await writeFile(join(profile, "update-session-restore.json"), JSON.stringify({ activeSessionId: "missing", residents: [
      { sessionId: "old", workspace: { workspaceId: stale.workspaceId, cwd: stale.canonicalPath } },
      { sessionId: "missing", workspace: { workspaceId: project.workspaceId, cwd: project.canonicalPath } },
    ] }));
    const reloaded = new WorkspaceRegistry(registry.path);
    await reloaded.load();
    const selected = reloaded.get(reloaded.activeWorkspaceId!)!;
    const launched: string[] = [];
    port = createDesktopRuntimeSessionPort({ ownerId: "recovery-test", sessionLeaseStore: new InMemorySessionLeaseStore(),
      workerPortFactory: ({ resumeSessionId, nextRuntimeEpoch }) => ({
        async start(context) {
          if (context.workspace?.cwd !== project.canonicalPath) return undefined;
          if (resumeSessionId) throw new Error("Saved session is unavailable");
          launched.push(context.workspace.cwd);
          const snapshot = { sessionId: "fresh", runtimeId: "runtime", runtimeEpoch: nextRuntimeEpoch(), stateVersion: 1, activeMode: "normal", approvalMode: "yolo", isStreaming: false, isCompacting: false, jobs: [], agents: [] };
          return { controller: { publication: () => ({ snapshot }) }, hello: () => ({ runtimeId: "runtime", runtimeEpoch: snapshot.runtimeEpoch }), onPublication: () => () => {} } as unknown as DesktopRuntimeSession;
        },
        stop: async () => {},
      }),
    });
    const session = await port.start({ profileDirectory: profile, resolution: { classification: "managed" } as never, endpoint: {} as never, runtimeInstallDirectory: join(profile, "runtimes"), workspace: { workspaceId: selected.workspaceId, cwd: selected.canonicalPath } });
    assert.equal(session?.controller.publication()?.snapshot.sessionId, "fresh");
    assert.deepEqual(launched, [project.canonicalPath]);
    assert.equal(port.lastUnavailable?.(), undefined);
    await assert.rejects(readFile(join(profile, "update-session-restore.json")), /ENOENT/);
    assert.equal(reloaded.get(stale.workspaceId)?.unavailable, true);
  } finally { await port?.stop(); await rm(profile, { recursive: true, force: true }); }
});
