import type { RuntimeEpoch, SessionId, StateVersion } from "@omp-studio/studio-protocol";

export type SessionResidency =
  | "dormant"
  | "waiting_capacity"
  | "starting"
  | "online"
  | "hibernating"
  | "crashed"
  | "failed";

export type SessionExecution = "idle" | "queued" | "running" | "waiting_interaction" | "paused" | "aborting" | "interrupted";

export interface SessionBrokerRecord {
  readonly sessionId: SessionId;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly residency: SessionResidency;
  readonly execution: SessionExecution;
  readonly brokerRevision: number;
  readonly runtimeId?: string;
  readonly runtimeEpoch?: RuntimeEpoch;
  readonly runtimeStateVersion?: StateVersion;
  readonly leaseEpoch?: number;
  readonly lastError?: string;
}

export interface SessionWorkerSnapshot {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly runtimeEpoch: RuntimeEpoch;
  readonly stateVersion: StateVersion;
  readonly execution: SessionExecution;
}

export interface SessionWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): SessionWorkerSnapshot | undefined;
  onPublication?(listener: (snapshot: SessionWorkerSnapshot) => void): () => void;
  onExit?(listener: (reason?: string) => void): () => void;
}

export interface SessionWorkerFactory {
  create(input: { readonly sessionId: string; readonly workspaceId: string; readonly cwd: string }): SessionWorker;
}

export interface SessionLease {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly leaseEpoch: number;
  readonly heartbeat?: () => Promise<void> | void;
  release(): Promise<void> | void;
}

export interface SessionLeaseStore {
  acquire(input: { readonly sessionId: string; readonly ownerId: string }): Promise<SessionLease> | SessionLease;
}

/** Testable phase-2 lease implementation; production replaces it with an OS/durable lease. */
export class InMemorySessionLeaseStore implements SessionLeaseStore {
  readonly #leases = new Map<string, { ownerId: string; epoch: number }>();

  acquire(input: { readonly sessionId: string; readonly ownerId: string }): SessionLease {
    const current = this.#leases.get(input.sessionId);
    if (current !== undefined && current.ownerId !== input.ownerId) {
      throw new SessionBrokerError("SESSION_LEASE_BUSY", "Session is already owned by another Worker");
    }
    const next = { ownerId: input.ownerId, epoch: (current?.epoch ?? 0) + 1 };
    this.#leases.set(input.sessionId, next);
    let released = false;
    return {
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      leaseEpoch: next.epoch,
      release: () => {
        if (released) return;
        released = true;
        const active = this.#leases.get(input.sessionId);
        if (active?.ownerId === input.ownerId && active.epoch === next.epoch) this.#leases.delete(input.sessionId);
      },
    };
  }
}

export class SessionBrokerError extends Error {
  constructor(readonly code: "SESSION_NOT_FOUND" | "SESSION_LEASE_BUSY" | "SESSION_IDENTITY_MISMATCH" | "SESSION_BUSY", message: string) {
    super(message);
    this.name = "SessionBrokerError";
  }
}

export interface SessionBrokerOptions {
  readonly ownerId: string;
  readonly workers: SessionWorkerFactory;
  readonly leases?: SessionLeaseStore;
  readonly maxResidentWorkers?: number;
}

type MutableRecord = {
  sessionId: SessionId;
  workspaceId: string;
  cwd: string;
  residency: SessionResidency;
  execution: SessionExecution;
  brokerRevision: number;
  runtimeId?: string;
  runtimeEpoch?: RuntimeEpoch;
  runtimeStateVersion?: StateVersion;
  leaseEpoch: number | undefined;
  lastError: string | undefined;
  worker: SessionWorker | undefined;
  lease: SessionLease | undefined;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  startPromise: Promise<SessionBrokerRecord> | undefined;
  queue: Promise<unknown>;
  unsubscribePublication: (() => void) | undefined;
  unsubscribeExit: (() => void) | undefined;
};

/**
 * In-process Broker core. It owns per-session queues and Worker bindings while
 * keeping the single-Worker Bridge contract below the factory boundary.
 */
export class StudioSessionBroker {
  readonly #ownerId: string;
  readonly #workers: SessionWorkerFactory;
  readonly #leases: SessionLeaseStore;
  readonly #maxResidentWorkers: number;
  readonly #records = new Map<string, MutableRecord>();
  #activeSessionId: string | undefined;
  #residentCount = 0;

  constructor(options: SessionBrokerOptions) {
    if (options.ownerId.length === 0) throw new TypeError("Broker ownerId is required");
    this.#ownerId = options.ownerId;
    this.#workers = options.workers;
    this.#leases = options.leases ?? new InMemorySessionLeaseStore();
    this.#maxResidentWorkers = options.maxResidentWorkers ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(this.#maxResidentWorkers) || this.#maxResidentWorkers < 1) {
      throw new TypeError("maxResidentWorkers must be a positive integer");
    }
  }

  register(input: { readonly sessionId: string; readonly workspaceId: string; readonly cwd: string }): SessionBrokerRecord {
    if (input.sessionId.length === 0 || input.workspaceId.length === 0 || input.cwd.length === 0) {
      throw new TypeError("Session identity and workspace are required");
    }
    const existing = this.#records.get(input.sessionId);
    if (existing !== undefined) {
      if (existing.workspaceId !== input.workspaceId || existing.cwd !== input.cwd) {
        throw new SessionBrokerError("SESSION_IDENTITY_MISMATCH", "Session workspace identity changed");
      }
      return this.#view(existing);
    }
    const record: MutableRecord = {
      sessionId: input.sessionId as SessionId,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      residency: "dormant",
      execution: "idle",
      brokerRevision: 1,
      lastError: undefined,
      leaseEpoch: undefined,
      worker: undefined,
      lease: undefined,
      heartbeatTimer: undefined,
      startPromise: undefined,
      queue: Promise.resolve(),
      unsubscribePublication: undefined,
      unsubscribeExit: undefined,
    };
    this.#records.set(input.sessionId, record);
    return this.#view(record);
  }

  list(): SessionBrokerRecord[] {
    return [...this.#records.values()].map((record) => this.#view(record));
  }

  activeSessionId(): SessionId | undefined {
    return this.#activeSessionId as SessionId | undefined;
  }

  select(sessionId: string): SessionBrokerRecord {
    const record = this.#get(sessionId);
    this.#activeSessionId = sessionId;
    return this.#view(record);
  }

  ensureResident(sessionId: string): Promise<SessionBrokerRecord> {
    const record = this.#get(sessionId);
    if (record.worker !== undefined && record.residency === "online") return Promise.resolve(this.#view(record));
    if (record.startPromise !== undefined) return record.startPromise;
    record.startPromise = this.#enqueue(record, async () => {
      if (record.worker !== undefined && record.residency === "online") return this.#view(record);
      if (this.#residentCount >= this.#maxResidentWorkers) {
        record.residency = "waiting_capacity";
        record.brokerRevision += 1;
        throw new SessionBrokerError("SESSION_BUSY", "Runtime worker capacity is exhausted");
      }
      record.residency = "starting";
      record.execution = "queued";
      record.lastError = undefined;
      record.brokerRevision += 1;
      const lease = await this.#leases.acquire({ sessionId, ownerId: this.#ownerId });
      let worker: SessionWorker | undefined;
      try {
        worker = this.#workers.create({ sessionId, workspaceId: record.workspaceId, cwd: record.cwd });
        record.lease = lease;
        record.leaseEpoch = lease.leaseEpoch;
        if (lease.heartbeat !== undefined) {
          const heartbeat = () => {
            void Promise.resolve(lease.heartbeat!()).catch(() => {
              this.#workerExited(record, "Session lease heartbeat failed");
            });
          };
          record.heartbeatTimer = setInterval(heartbeat, 10_000);
          record.heartbeatTimer.unref?.();
        }
        record.worker = worker;
        this.#residentCount += 1;
        record.residency = "starting";
        const unsubscribePublication = worker.onPublication?.((snapshot) => this.#acceptSnapshot(record, snapshot));
        const unsubscribeExit = worker.onExit?.((reason) => this.#workerExited(record, reason));
        record.unsubscribePublication = unsubscribePublication;
        record.unsubscribeExit = unsubscribeExit;
        await worker.start();
        const snapshot = worker.snapshot();
        if (snapshot === undefined || snapshot.sessionId !== sessionId) {
          throw new SessionBrokerError("SESSION_IDENTITY_MISMATCH", "Worker did not authenticate the requested Session");
        }
        this.#acceptSnapshot(record, snapshot);
        record.residency = "online";
        record.execution = snapshot.execution;
        record.brokerRevision += 1;
        return this.#view(record);
      } catch (error) {
        await this.#disposeWorker(record, worker);
        record.residency = "failed";
        record.execution = "interrupted";
        record.lastError = error instanceof Error ? error.message : String(error);
        record.brokerRevision += 1;
        throw error;
      }
    });
    void record.startPromise.then(
      () => {
        record.startPromise = undefined;
      },
      () => {
        record.startPromise = undefined;
      },
    );
    return record.startPromise;
  }

  async hibernate(sessionId: string): Promise<SessionBrokerRecord> {
    const record = this.#get(sessionId);
    return this.#enqueue(record, async () => {
      if (record.worker === undefined) return this.#view(record);
      if (record.execution !== "idle") throw new SessionBrokerError("SESSION_BUSY", "Session is not idle");
      record.residency = "hibernating";
      record.brokerRevision += 1;
      const worker = record.worker;
      try {
        await worker.stop();
        await this.#disposeWorker(record, worker);
        record.residency = "dormant";
        record.execution = "idle";
        record.brokerRevision += 1;
        return this.#view(record);
      } catch (error) {
        record.residency = "online";
        record.lastError = error instanceof Error ? error.message : String(error);
        record.brokerRevision += 1;
        throw error;
      }
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#records.keys()].map((sessionId) => this.hibernate(sessionId).catch(() => undefined)));
  }

  #get(sessionId: string): MutableRecord {
    const record = this.#records.get(sessionId);
    if (record === undefined) throw new SessionBrokerError("SESSION_NOT_FOUND", "Session is not registered");
    return record;
  }

  #enqueue<T>(record: MutableRecord, operation: () => Promise<T>): Promise<T> {
    const run = record.queue.then(operation, operation);
    record.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  #acceptSnapshot(record: MutableRecord, snapshot: SessionWorkerSnapshot): void {
    if (snapshot.sessionId !== record.sessionId) return;
    record.runtimeId = snapshot.runtimeId;
    record.runtimeEpoch = snapshot.runtimeEpoch;
    record.runtimeStateVersion = snapshot.stateVersion;
    record.execution = snapshot.execution;
    record.brokerRevision += 1;
  }

  #workerExited(record: MutableRecord, reason?: string): void {
    if (record.residency === "hibernating" || record.residency === "dormant") return;
    if (record.heartbeatTimer !== undefined) {
      clearInterval(record.heartbeatTimer);
      record.heartbeatTimer = undefined;
    }
    record.residency = "crashed";
    record.execution = "interrupted";
    record.lastError = reason ?? "Runtime Worker exited unexpectedly";
    record.brokerRevision += 1;
  }

  async #disposeWorker(record: MutableRecord, worker: SessionWorker | undefined): Promise<void> {
    record.unsubscribePublication?.();
    record.unsubscribeExit?.();
    record.unsubscribePublication = undefined;
    record.unsubscribeExit = undefined;
    record.worker = undefined;
    if (record.heartbeatTimer !== undefined) clearInterval(record.heartbeatTimer);
    record.heartbeatTimer = undefined;
    if (worker !== undefined && this.#residentCount > 0) this.#residentCount -= 1;
    const lease = record.lease;
    record.lease = undefined;
    record.leaseEpoch = undefined;
    if (lease !== undefined) await lease.release();
  }

  #view(record: MutableRecord): SessionBrokerRecord {
    return {
      sessionId: record.sessionId,
      workspaceId: record.workspaceId,
      cwd: record.cwd,
      residency: record.residency,
      execution: record.execution,
      brokerRevision: record.brokerRevision,
      ...(record.runtimeId === undefined ? {} : { runtimeId: record.runtimeId }),
      ...(record.runtimeEpoch === undefined ? {} : { runtimeEpoch: record.runtimeEpoch }),
      ...(record.runtimeStateVersion === undefined ? {} : { runtimeStateVersion: record.runtimeStateVersion }),
      ...(record.leaseEpoch === undefined ? {} : { leaseEpoch: record.leaseEpoch }),
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    };
  }
}
