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
