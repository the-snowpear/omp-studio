import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { RemoteConnectionManager } from "../src/remote/manager.js";

test("saved SSH profiles survive restart without storing credentials or a live selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-remote-profiles-"));
  try {
    const path = join(root, "connections.json");
    const manager = new RemoteConnectionManager(path, root);
    const profile = await manager.save({ name: "Windows build", host: "build", platform: "win32", port: 2222 });
    const next = new RemoteConnectionManager(path, root);
    const inventory = await next.list();
    assert.equal(inventory.profiles[0]?.host, "build");
    assert.equal(inventory.profiles[0]?.port, 2222);
    assert.equal(next.activeId, null);
    assert.throws(() => next.get(profile.id), /SSH 已断开/);
    assert.equal((await readFile(path, "utf8")).includes("password"), false);
    await next.remove(profile.id);
    assert.equal((await new RemoteConnectionManager(path, root).list()).profiles.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
