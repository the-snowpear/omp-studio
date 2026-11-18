import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TimeTravelService } from "../src/time-travel-service.js";

test("Time Travel is opt-in, persists its switch, and retains snapshots when disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-time-travel-"));
  const workspace = join(root, "workspace");
  const profile = join(root, "profile");
  await mkdir(workspace);
  await writeFile(join(workspace, "file"), "content");
  const service = new TimeTravelService(profile);
  const capture = {
    workspace,
    sessionId: "session",
    leafId: null,
    phase: "before" as const,
  };
  assert.equal((await service.settings()).enabled, false);
  assert.equal(await service.capture(capture), undefined);
  assert.equal((await service.storage()).snapshots, 0);
  await service.updateSettings({ enabled: true });
  assert.equal((await new TimeTravelService(profile).settings()).enabled, true);
  await service.capture(capture);
  await service.updateSettings({ enabled: false });
  assert.equal(await service.capture(capture), undefined);
  assert.equal((await service.storage()).snapshots, 1);
  await assert.rejects(
    service.withRestore(async () => true),
    /disabled/u,
  );
  await service.cleanup("all");
  assert.equal((await service.storage()).snapshots, 0);
});

test("a switch change waits for the entire in-progress restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-time-travel-"));
  const service = new TimeTravelService(root);
  await service.updateSettings({ enabled: true });
  let finish!: () => void;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const restore = service.withRestore(async () => {
    markReady();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    assert.equal((await service.settings()).enabled, true);
    return "restored";
  });
  await ready;
  const disabling = service.updateSettings({ enabled: false });
  finish();
  assert.equal(await restore, "restored");
  assert.equal((await disabling).enabled, false);
});

test("session removal waits for an in-progress restore and preserves another session's snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-time-travel-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const file = join(workspace, "file");
  await writeFile(file, "deleted session content");
  const service = new TimeTravelService(join(root, "profile"));
  await service.updateSettings({ enabled: true });
  const capture = { workspace, leafId: null, phase: "before" as const };
  await service.capture({ ...capture, sessionId: "deleted" });

  let markReady!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const restoring = service.withRestore(async (store) => {
    markReady();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    assert.equal((await store.list(workspace, "deleted")).length, 1);
    await writeFile(file, "retained session content");
    return store.capture({ ...capture, sessionId: "retained" });
  });
  await ready;
  const removal = service.removeSession("deleted");
  finish();
  const retained = await restoring;
  assert.deepEqual(await removal, { removed: 1 });
  assert.equal((await service.list(workspace, "deleted")).length, 0);

  await writeFile(file, "modified");
  const preview = await service.preview(workspace, "retained", retained.id);
  const result = await service.restore({
    workspace, sessionId: "retained", snapshotId: retained.id, expectedRevision: preview.revision, leafId: null,
  });
  assert.equal(result.restored, true);
});
