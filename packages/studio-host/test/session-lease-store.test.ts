import assert from "node:assert/strict";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileSessionLeaseStore, SessionBrokerError } from "../src/index.js";

test("FileSessionLeaseStore serializes owners across store instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-session-lease-"));
  try {
    const left = new FileSessionLeaseStore({ directory });
    const right = new FileSessionLeaseStore({ directory });
    const lease = await left.acquire({ sessionId: "session-a", ownerId: "broker-a" });
    await assert.rejects(
      () => right.acquire({ sessionId: "session-a", ownerId: "broker-b" }),
      (error: unknown) => error instanceof SessionBrokerError && error.code === "SESSION_LEASE_BUSY",
    );
    await lease.release();
    const replacement = await right.acquire({ sessionId: "session-a", ownerId: "broker-b" });
    assert.equal(replacement.leaseEpoch, lease.leaseEpoch + 1);
    await replacement.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FileSessionLeaseStore heartbeats and recovers an expired owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-session-lease-"));
  try {
    let clock = 1_000;
    const store = new FileSessionLeaseStore({ directory, staleAfterMs: 100, now: () => clock });
    const lease = await store.acquire({ sessionId: "session-a", ownerId: "broker-a" });
    clock += 80;
    await lease.heartbeat?.();
    clock += 80;
    await assert.rejects(() => store.acquire({ sessionId: "session-a", ownerId: "broker-b" }));
    clock += 101;
    const replacement = await store.acquire({ sessionId: "session-a", ownerId: "broker-b" });
    assert.equal(replacement.leaseEpoch, 2);
    await lease.release();
    await replacement.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FileSessionLeaseStore retries transient Windows rename contention during heartbeat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-session-lease-"));
  try {
    let transientFailures = 0;
    const store = new FileSessionLeaseStore({
      directory,
      renameFile: async (oldPath, newPath) => {
        if (String(newPath).endsWith(".lease") && transientFailures < 2) {
          transientFailures += 1;
          const error = new Error("destination is temporarily locked") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        await rename(oldPath, newPath);
      },
    });
    const lease = await store.acquire({ sessionId: "session-a", ownerId: "broker-a" });
    await lease.heartbeat?.();
    assert.equal(transientFailures, 2);
    await assert.rejects(
      () => store.acquire({ sessionId: "session-a", ownerId: "broker-b" }),
      (error: unknown) => error instanceof SessionBrokerError && error.code === "SESSION_LEASE_BUSY",
    );
    await lease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FileSessionLeaseStore does not allow a stale owner to release a replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-session-lease-"));
  try {
    let clock = 1_000;
    const store = new FileSessionLeaseStore({ directory, staleAfterMs: 10, now: () => clock });
    const oldLease = await store.acquire({ sessionId: "session-a", ownerId: "broker-a" });
    clock += 11;
    const newLease = await store.acquire({ sessionId: "session-a", ownerId: "broker-b" });
    await oldLease.release();
    await assert.rejects(() => store.acquire({ sessionId: "session-a", ownerId: "broker-c" }));
    await newLease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FileSessionLeaseStore.removeForSession drops the lease and epoch files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-session-lease-"));
  try {
    const store = new FileSessionLeaseStore({ directory });
    const lease = await store.acquire({ sessionId: "session-a", ownerId: "broker-a" });
    await lease.release();
    await store.removeForSession("session-a");
    // 文件已删：重新 acquire 直接从 epoch 0 起算。
    const replacement = await store.acquire({ sessionId: "session-a", ownerId: "broker-b" });
    assert.equal(replacement.leaseEpoch, 1);
    await replacement.release();
    await store.removeForSession("session-missing"); // 容错：不存在的会话无操作
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
