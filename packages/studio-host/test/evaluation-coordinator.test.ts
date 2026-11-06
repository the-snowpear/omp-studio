import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvaluationCoordinator, type EvaluationWorker } from "../src/evaluation-coordinator.js";
import { ArtifactLibrary } from "../src/artifact-library.js";
import type {
  EvaluationNativeSnapshot,
  EvaluationWorkspaceOperation,
  EvaluationPlan,
} from "@omp-studio/studio-protocol";

const benchmarkInput = {
  workspaceId: "workspace",
  title: "Lifecycle",
  spec: { kind: "benchmark" as const, profile: "chat" as const, models: ["test/model"], runs: 1 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function completedWorker(overrides: Partial<EvaluationWorker> = {}): EvaluationWorker {
  return {
    sessionId: "evaluation-worker",
    runtimeVersion: "18.13.2",
    context: async () => ({ available: true, models: [] }),
    pending: () => undefined,
    respond: async () => {},
    subscribe: () => () => {},
    release: async () => {},
    invoke: async operation => {
      if (operation.kind === "evaluation.runtime.plan")
        return { spec: operation.spec, requests: 1, upperBound: false, phases: [], notes: [] };
      if (operation.kind === "evaluation.runtime.rows") return { rows: [], offset: 0, nextOffset: 0, total: 0 };
      if (operation.kind === "evaluation.runtime.report") return { text: "{}", nextOffset: 2, total: 2 };
      return { state: "completed", completed: 1, total: 1, failed: 0, cost: null, metrics: [], detail: {}, revision: 1 };
    },
    ...overrides,
  };
}

test("concurrent evaluation surfaces reuse one prepared Worker and release it when the run ends", async t => {
  const directory = await mkdtemp(join(tmpdir(), "studio-evaluation-shared-"));
  const opening = deferred<EvaluationWorker>();
  const requested = deferred<void>();
  let opened = 0, released = 0;
  const coordinator = new EvaluationCoordinator(join(directory, "evaluations"), {
    open: async () => { opened++; requested.resolve(); return opening.promise; },
  }, new ArtifactLibrary({ profileDirectory: directory }));
  t.after(async () => { await coordinator.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const contexts = Promise.all([coordinator.context("workspace"), coordinator.context("workspace")]);
  await requested.promise;
  opening.resolve(completedWorker({ release: async () => { released++; } }));
  await contexts;
  await coordinator.prepare(benchmarkInput);
  const result = await coordinator.start(benchmarkInput);
  assert.equal(result.state, "completed");
  assert.equal(opened, 1);
  assert.equal(released, 1);
});

test("a rejected evaluation plan releases its Worker and a corrected start can succeed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "studio-evaluation-plan-error-"));
  let opened = 0, released = 0;
  const coordinator = new EvaluationCoordinator(join(directory, "evaluations"), {
    open: async () => ++opened === 1
      ? completedWorker({ invoke: async () => { throw new Error("Model unavailable"); }, release: async () => { released++; } })
      : completedWorker({ release: async () => { released++; } }),
  }, new ArtifactLibrary({ profileDirectory: directory }));
  t.after(async () => { await coordinator.shutdown(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(coordinator.start(benchmarkInput), /Model unavailable/);
  assert.equal(released, 1);
  assert.equal((await coordinator.start(benchmarkInput)).state, "completed");
  assert.equal(released, 2);
});

test("shutdown waits for planning and releases the Worker without starting paid work", async t => {
  const directory = await mkdtemp(join(tmpdir(), "studio-evaluation-shutdown-"));
  const planning = deferred<void>(), finish = deferred<void>();
  let released = 0, started = 0;
  const base = completedWorker();
  const worker = completedWorker({
    invoke: async operation => {
      if (operation.kind === "evaluation.runtime.plan") { planning.resolve(); await finish.promise; }
      if (operation.kind === "evaluation.runtime.start") started++;
      return base.invoke(operation);
    },
    release: async () => { released++; },
  });
  const coordinator = new EvaluationCoordinator(join(directory, "evaluations"), { open: async () => worker }, new ArtifactLibrary({ profileDirectory: directory }));
  t.after(async () => { await coordinator.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const starting = coordinator.start(benchmarkInput);
  await planning.promise;
  let stopped = false;
  const shutdown = coordinator.shutdown().then(() => { stopped = true; });
  const rejected = assert.rejects(starting, /shutting down/);
  await Promise.resolve();
  assert.equal(stopped, false);
  finish.resolve();
  await rejected;
  await shutdown;
  assert.equal(released, 1);
  assert.equal(started, 0);
  assert.equal((await coordinator.list()).records.length, 0);
});

test("background results survive coordinator recreation without replaying paid work, and exports contain every page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-evaluation-"));
  const library = new ArtifactLibrary({ profileDirectory: directory });
  const rows = Array.from({ length: 245 }, (_, key) => ({
    key: String(key),
    data: { answer: key },
  }));
  let started = 0,
    released = 0;
  const snapshot: EvaluationNativeSnapshot = {
    state: "completed",
    completed: 245,
    total: 245,
    failed: 0,
    cost: 0.02,
    metrics: [],
    detail: {},
    revision: 2,
  };
  const worker: EvaluationWorker = {
    sessionId: "background-evaluation",
    runtimeVersion: "18.13.2",
    context: async () => ({ available: true, models: [] }),
    pending: () => undefined,
    respond: async () => {},
    subscribe: () => () => {},
    release: async () => {
      released++;
    },
    invoke: async (op: EvaluationWorkspaceOperation) => {
      if (op.kind === "evaluation.runtime.plan")
        return {
          spec: op.spec,
          requests: null,
          upperBound: false,
          phases: [],
          notes: [],
        } satisfies EvaluationPlan;
      if (op.kind === "evaluation.runtime.start") {
        started++;
        return snapshot;
      }
      if (op.kind === "evaluation.runtime.read") return snapshot;
      if (op.kind === "evaluation.runtime.rows") {
        const offset = op.offset ?? 0,
          page = rows.slice(offset, offset + 100);
        return { rows: page, offset, nextOffset: offset + page.length, total: rows.length };
      }
      if (op.kind === "evaluation.runtime.report") {
        const text = JSON.stringify(rows);
        return { text, nextOffset: text.length, total: text.length };
      }
      return snapshot;
    },
  };
  const factory = { open: async () => worker };
  let coordinator = new EvaluationCoordinator(join(directory, "evaluations"), factory, library);
  try {
    const record = await coordinator.start({
      workspaceId: "workspace-a",
      title: "Results",
      spec: {
        kind: "judgment",
        items: [{ key: "first", state: "input" }],
        questions: { correct: { type: "bool", instructions: "Correct?" } },
      },
    });
    assert.equal(record.state, "completed");
    assert.equal(released, 1);
    assert.equal((await coordinator.rows({ id: record.id, offset: 200 })).rows.length, 45);
    await coordinator.shutdown();
    coordinator = new EvaluationCoordinator(join(directory, "evaluations"), factory, library);
    assert.equal((await coordinator.read(record.id)).completed, 245);
    assert.equal(started, 1, "Reading saved history must never start another native request");
    const exported = await coordinator.export({ id: record.id, format: "csv" });
    const file = await library.resolve(exported.artifactId);
    const csv = await readFile(file.path, "utf8");
    assert.equal(csv.split("\r\n").length, 246);
    assert.match(csv, /244/);
    const chunk = await coordinator.exportChunk({ artifactId: exported.artifactId, offset: 5 });
    assert.equal(Buffer.from(chunk.data, "base64").toString("utf8"), csv.slice(5));
    assert.equal(chunk.nextOffset, chunk.total);
  } finally {
    await coordinator.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("saved partial results merge revisions by item identity and shutdown does not cancel a completed run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-evaluation-revisions-"));
  const library = new ArtifactLibrary({ profileDirectory: directory });
  let revision = 1,
    changed: () => void = () => {},
    cancels = 0;
  const worker: EvaluationWorker = {
    sessionId: "eval-revisions",
    runtimeVersion: "18.13.2",
    context: async () => ({ available: true, models: [] }),
    pending: () => undefined,
    respond: async () => {},
    subscribe: (listener) => {
      changed = listener;
      return () => {};
    },
    release: async () => {},
    invoke: async (operation) => {
      const view: EvaluationNativeSnapshot = {
        state: revision === 1 ? "running" : "completed",
        completed: revision,
        total: 2,
        failed: 0,
        cost: null,
        metrics: [],
        detail: {},
        revision,
      };
      if (operation.kind === "evaluation.runtime.plan")
        return { spec: operation.spec, requests: 2, upperBound: false, phases: [], notes: [] };
      if (operation.kind === "evaluation.runtime.control") {
        cancels++;
        return view;
      }
      if (operation.kind === "evaluation.runtime.rows")
        return {
          rows:
            revision === 1
              ? [{ key: "b", data: { value: "partial" } }]
              : [
                  { key: "a", data: { value: "done" } },
                  { key: "b", data: { value: "updated" } },
                ],
          offset: 0,
          nextOffset: revision,
          total: revision,
        };
      if (operation.kind === "evaluation.runtime.report")
        return { text: "{}", nextOffset: 2, total: 2 };
      return view;
    },
  };
  const coordinator = new EvaluationCoordinator(
    join(directory, "evaluations"),
    { open: async () => worker },
    library,
  );
  try {
    const record = await coordinator.start({
      workspaceId: "w",
      title: "Progress",
      spec: { kind: "benchmark", profile: "chat", models: ["test/model"], runs: 2 },
    });
    revision = 2;
    changed();
    for (let i = 0; i < 50; i++) {
      const page = await coordinator.rows({ id: record.id });
      if (page.total === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const page = await coordinator.rows({ id: record.id });
    assert.equal(page.total, 2);
    assert.deepEqual(page.rows.find((row) => row.key === "b")?.data, { value: "updated" });
    await coordinator.shutdown();
    assert.equal(cancels, 0);
  } finally {
    await coordinator.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
