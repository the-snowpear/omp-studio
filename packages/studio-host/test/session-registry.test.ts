import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { JsonSessionRegistry, SessionRegistryError } from "../src/index.js";

test("JsonSessionRegistry persists records and rejects stale revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-session-registry-"));
  const path = join(directory, "sessions.json");
  try {
    const registry = new JsonSessionRegistry(path);
    await registry.load();
    const created = await registry.ensure({ sessionId: "session-a", workspaceId: "workspace-a", profileId: "profile-a" });
    const online = await registry.patch("session-a", created.brokerRevision, {
      residency: "online",
      runtimeId: "runtime-a",
      runtimeEpoch: 3,
    });
    await assert.rejects(
      () => registry.patch("session-a", created.brokerRevision, { execution: "running" }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "REVISION_CONFLICT",
    );

    const reloaded = new JsonSessionRegistry(path);
    await reloaded.load();
    assert.deepEqual(reloaded.get("session-a"), online);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JsonSessionRegistry lease ownership is exclusive and release fences stale owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-session-registry-"));
  const path = join(directory, "sessions.json");
  try {
    const registry = new JsonSessionRegistry(path);
    await registry.load();
    const created = await registry.ensure({ sessionId: "session-a", workspaceId: "workspace-a", profileId: "profile-a" });
    const leased = await registry.acquireLease({
      sessionId: "session-a",
      expectedRevision: created.brokerRevision,
      ownerId: "broker-a",
      runtimeId: "runtime-a",
      runtimeEpoch: 1,
      now: "2026-08-15T20:00:00.000Z",
    });
    await assert.rejects(
      () => registry.acquireLease({ sessionId: "session-a", expectedRevision: leased.brokerRevision, ownerId: "broker-b" }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "LEASE_HELD",
    );
    await assert.rejects(
      () => registry.releaseLease({ sessionId: "session-a", expectedRevision: leased.brokerRevision, ownerId: "broker-b", leaseEpoch: leased.lease!.leaseEpoch }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "LEASE_STALE",
    );
    const released = await registry.releaseLease({
      sessionId: "session-a",
      expectedRevision: leased.brokerRevision,
      ownerId: "broker-a",
      leaseEpoch: leased.lease!.leaseEpoch,
    });
    assert.equal(released.lease, undefined);
    assert.equal(released.residency, "dormant");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
