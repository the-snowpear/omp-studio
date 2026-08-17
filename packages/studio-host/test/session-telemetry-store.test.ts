import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionTelemetryStore } from "../src/index.js";
import type { SessionId, SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";

function snapshot(sessionId: string, total: number): SessionTelemetrySnapshot {
  return {
    sessionId: sessionId as SessionId,
    capturedAt: "2026-08-16T00:00:00.000Z",
    tokens: { input: total, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: total + 1, cost: 0.1 },
    context: {
      contextWindow: 128_000,
      usedTokens: 1_000,
      percent: 0.78,
      anchored: false,
      systemPromptTokens: 100,
      systemContextTokens: 100,
      systemToolsTokens: 100,
      skillsTokens: 10,
      messagesTokens: 690,
    },
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("telemetry store debounces per session, keeps the latest telemetry, and reads by revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-telemetry-store-"));
  try {
    let revision = "rev-1";
    const store = new SessionTelemetryStore({
      rootDirectory: root,
      writeDebounceMs: 20,
      resolveRevision: async () => revision,
    });
    store.record("session-a", snapshot("session-a", 10));
    store.record("session-a", snapshot("session-a", 20));
    store.record("session-a", snapshot("session-a", 30));
    await wait(60);
    const files = await readdir(root);
    assert.equal(files.length, 1);
    const record = await store.read("session-a", "rev-1");
    assert.ok(record);
    assert.equal(record.telemetry.tokens.input, 30);
    assert.equal(record.transcriptRevision, "rev-1");
    assert.equal(record.schemaVersion, 1);

    // A different revision is a cache miss by construction.
    assert.equal(await store.read("session-a", "rev-2"), undefined);
    assert.equal(await store.read("session-b", "rev-1"), undefined);

    // A mutated transcript invalidates the old record: the store writes the new revision.
    revision = "rev-2";
    store.record("session-a", snapshot("session-a", 40));
    await wait(60);
    assert.equal(await store.read("session-a", "rev-1"), undefined);
    const updated = await store.read("session-a", "rev-2");
    assert.ok(updated);
    assert.equal(updated.telemetry.tokens.input, 40);
    await store.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telemetry store treats corrupt, oversized, and mismatched records as cache misses", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-telemetry-store-"));
  try {
    const store = new SessionTelemetryStore({ rootDirectory: root, writeDebounceMs: 20 });
    const { createHash } = await import("node:crypto");
    const path = join(root, `${createHash("sha256").update("session-x").digest("hex")}.json`);
    const base = {
      schemaVersion: 1,
      sessionId: "session-x",
      transcriptRevision: "rev-1",
      recordedAt: "2026-08-16T00:00:00.000Z",
      telemetry: snapshot("session-x", 5),
    };
    const cases: Array<unknown> = [
      "{not json",
      JSON.stringify({ ...base, sessionId: "session-y" }),
      JSON.stringify({ ...base, schemaVersion: 2 }),
      JSON.stringify({ ...base, extra: true }),
      JSON.stringify({ ...base, telemetry: { ...base.telemetry, tokens: { ...base.telemetry.tokens, input: -1 } } }),
      JSON.stringify({ ...base, telemetry: { ...base.telemetry, tokens: { ...base.telemetry.tokens, input: "many" } } }),
      JSON.stringify({ ...base, telemetry: null }),
    ];
    for (const value of cases) {
      await writeFile(path, String(value), "utf8");
      assert.equal(await store.read("session-x", "rev-1"), undefined, `expected miss for ${String(value).slice(0, 40)}`);
    }
    // Oversized file
    await writeFile(path, `${JSON.stringify({ ...base, filler: "x".repeat(70_000) })}`, "utf8");
    assert.equal(await store.read("session-x", "rev-1"), undefined);
    await store.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telemetry store flush persists pending records and skips writes without a revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-telemetry-store-"));
  try {
    let revision: string | undefined = "rev-9";
    const store = new SessionTelemetryStore({
      rootDirectory: root,
      writeDebounceMs: 60_000,
      resolveRevision: async () => revision,
    });
    store.record("session-flush", snapshot("session-flush", 7));
    await store.flush();
    const record = await store.read("session-flush", "rev-9");
    assert.ok(record);
    assert.equal(record.telemetry.tokens.input, 7);

    revision = undefined;
    store.record("session-flush", snapshot("session-flush", 99));
    const before = await readdir(root);
    await store.flush();
    const after = await readdir(root);
    assert.deepEqual(after, before);
    const stale = await store.read("session-flush", "rev-9");
    assert.ok(stale);
    assert.equal(stale.telemetry.tokens.input, 7);
    await store.dispose();
    store.record("session-flush", snapshot("session-flush", 100));
    await store.flush();
    const files = await readdir(root);
    assert.equal(files.filter((name) => name.endsWith(".tmp")).length, 0);
    const persisted = JSON.parse(await readFile(join(root, files[0]!), "utf8")) as { telemetry: { tokens: { input: number } } };
    assert.equal(persisted.telemetry.tokens.input, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
