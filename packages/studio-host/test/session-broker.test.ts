import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemorySessionLeaseStore,
  SessionBrokerError,
  StudioSessionBroker,
  type SessionWorker,
  type SessionWorkerFactory,
  type SessionWorkerSnapshot,
} from "../src/index.js";

function workerFactory(options: { readonly starts?: number; readonly stops?: number } = {}): {
  factory: SessionWorkerFactory;
  workers: Map<string, FakeWorker>;
} {
  const workers = new Map<string, FakeWorker>();
  const factory: SessionWorkerFactory = {
    create(input) {
      const worker = new FakeWorker(input.sessionId, options);
      workers.set(input.sessionId, worker);
      return worker;
    },
  };
  return { factory, workers };
}

class FakeWorker implements SessionWorker {
  readonly #sessionId: string;
  readonly #options: { readonly starts?: number; readonly stops?: number };
  readonly #listeners = new Set<(snapshot: SessionWorkerSnapshot) => void>();
  started = 0;
  stopped = 0;
  private current: SessionWorkerSnapshot | undefined;

  constructor(sessionId: string, options: { readonly starts?: number; readonly stops?: number }) {
    this.#sessionId = sessionId;
    this.#options = options;
  }

  async start(): Promise<void> {
    this.started += 1;
    if (this.#options.starts !== undefined) await new Promise((resolve) => setTimeout(resolve, this.#options.starts));
    this.current = {
      sessionId: this.#sessionId,
      runtimeId: `runtime-${this.#sessionId}`,
      runtimeEpoch: 1 as never,
      stateVersion: 1 as never,
      execution: "idle",
    };
    for (const listener of this.#listeners) listener(this.current);
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    if (this.#options.stops !== undefined) await new Promise((resolve) => setTimeout(resolve, this.#options.stops));
  }

  snapshot(): SessionWorkerSnapshot | undefined {
    return this.current;
  }

  onPublication(listener: (snapshot: SessionWorkerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(snapshot: SessionWorkerSnapshot): void {
    this.current = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

test("Broker keeps multiple Session Workers resident and View selection does not stop siblings", async () => {
  const { factory, workers } = workerFactory();
  const broker = new StudioSessionBroker({ ownerId: "broker-a", workers: factory });
  broker.register({ sessionId: "session-a", workspaceId: "workspace", cwd: "C:/workspace" });
  broker.register({ sessionId: "session-b", workspaceId: "workspace", cwd: "C:/workspace" });

  await broker.ensureResident("session-a");
  await broker.ensureResident("session-b");
  broker.select("session-b");
  assert.equal(broker.activeSessionId(), "session-b");
  assert.equal(workers.get("session-a")?.stopped, 0);
  assert.equal(broker.list().filter((entry) => entry.residency === "online").length, 2);
});

test("concurrent ensureResident calls share one Worker start and lease", async () => {
  const { factory, workers } = workerFactory({ starts: 10 });
  const broker = new StudioSessionBroker({ ownerId: "broker-a", workers: factory, leases: new InMemorySessionLeaseStore() });
  broker.register({ sessionId: "session-a", workspaceId: "workspace", cwd: "C:/workspace" });
  const [left, right] = await Promise.all([broker.ensureResident("session-a"), broker.ensureResident("session-a")]);
  assert.equal(left.runtimeId, right.runtimeId);
  assert.equal(workers.get("session-a")?.started, 1);
});

test("worker identity mismatch fails closed and releases the lease", async () => {
  const workers = new Map<string, FakeWorker>();
  const factory: SessionWorkerFactory = {
    create() {
      const worker = new FakeWorker("other", {});
      workers.set("session-a", worker);
      return worker;
    },
  };
  const broker = new StudioSessionBroker({ ownerId: "broker-a", workers: factory });
  broker.register({ sessionId: "session-a", workspaceId: "workspace", cwd: "C:/workspace" });
  await assert.rejects(
    () => broker.ensureResident("session-a"),
    (error: unknown) => error instanceof SessionBrokerError && error.code === "SESSION_IDENTITY_MISMATCH",
  );
  assert.equal(broker.list()[0]?.residency, "failed");
});

test("capacity exhaustion is explicit and does not evict a running sibling", async () => {
  const { factory } = workerFactory();
  const broker = new StudioSessionBroker({ ownerId: "broker-a", workers: factory, maxResidentWorkers: 1 });
  broker.register({ sessionId: "session-a", workspaceId: "workspace", cwd: "C:/workspace" });
  broker.register({ sessionId: "session-b", workspaceId: "workspace", cwd: "C:/workspace" });
  await broker.ensureResident("session-a");
  await assert.rejects(
    () => broker.ensureResident("session-b"),
    (error: unknown) => error instanceof SessionBrokerError && error.code === "SESSION_BUSY",
  );
  assert.equal(broker.list().find((entry) => entry.sessionId === "session-a")?.residency, "online");
  assert.equal(broker.list().find((entry) => entry.sessionId === "session-b")?.residency, "waiting_capacity");
});

test("hibernate releases the Worker and lease only after the Worker stops", async () => {
  const { factory, workers } = workerFactory();
  const broker = new StudioSessionBroker({ ownerId: "broker-a", workers: factory });
  broker.register({ sessionId: "session-a", workspaceId: "workspace", cwd: "C:/workspace" });
  await broker.ensureResident("session-a");
  const result = await broker.hibernate("session-a");
  assert.equal(result.residency, "dormant");
  assert.equal(workers.get("session-a")?.stopped, 1);
});
