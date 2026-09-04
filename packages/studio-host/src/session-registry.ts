import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionResidencyState =
  | "dormant"
  | "waiting_capacity"
  | "starting"
  | "handshaking"
  | "hydrating"
  | "online"
  | "quiescing"
  | "hibernating"
  | "crashed"
  | "recovering"
  | "failed";

export type SessionExecutionState =
  | "idle"
  | "queued"
  | "running"
  | "waiting_interaction"
  | "paused"
  | "aborting"
  | "interrupted";

export interface SessionLeaseRecord {
  readonly ownerId: string;
  readonly leaseEpoch: number;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly runtimeId?: string;
  readonly runtimeEpoch?: number;
}

export interface SessionRegistryRecord {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly profileId: string;
  readonly residency: SessionResidencyState;
  readonly execution: SessionExecutionState;
  readonly brokerRevision: number;
  readonly transcriptRevision?: string;
  readonly runtimeId?: string;
  readonly runtimeEpoch?: number;
  readonly lease?: SessionLeaseRecord | undefined;
}

export interface SessionRegistryPatch {
  readonly residency?: SessionResidencyState;
  readonly execution?: SessionExecutionState;
  readonly transcriptRevision?: string;
  readonly runtimeId?: string;
  readonly runtimeEpoch?: number;
  readonly lease?: SessionLeaseRecord | undefined;
}

export class SessionRegistryError extends Error {
  constructor(readonly code: "NOT_FOUND" | "REVISION_CONFLICT" | "LEASE_HELD" | "LEASE_STALE" | "INVALID", message: string) {
    super(message);
    this.name = "SessionRegistryError";
  }
}

/**
 * Durable metadata registry. Runtime snapshot/event data remains Worker-owned.
 *
 * Not wired into the desktop Host: production leases use `FileSessionLeaseStore`
 * and residency lives in `apps/desktop/src/runtime-session.ts`. Kept as the
 * tested phase-2 registry for a future durable-broker integration.
 */
export class JsonSessionRegistry {
  readonly #records = new Map<string, SessionRegistryRecord>();
  #loaded = false;

  constructor(readonly path: string) {}

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!Array.isArray(value)) throw new SessionRegistryError("INVALID", "Session registry must be an array");
      this.#records.clear();
      for (const item of value) {
        const record = parseRecord(item);
        this.#records.set(record.sessionId, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#loaded = true;
  }

  list(): SessionRegistryRecord[] {
    this.#assertLoaded();
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  get(sessionId: string): SessionRegistryRecord | undefined {
    this.#assertLoaded();
    const record = this.#records.get(sessionId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async ensure(input: { sessionId: string; workspaceId: string; profileId: string }): Promise<SessionRegistryRecord> {
    this.#assertLoaded();
    if (input.sessionId.length === 0 || input.workspaceId.length === 0 || input.profileId.length === 0) {
      throw new SessionRegistryError("INVALID", "Session registry identity is required");
    }
    const existing = this.#records.get(input.sessionId);
    if (existing !== undefined) return structuredClone(existing);
    const record: SessionRegistryRecord = {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      residency: "dormant",
      execution: "idle",
      brokerRevision: 1,
    };
    this.#records.set(record.sessionId, record);
    await this.#flush();
    return structuredClone(record);
  }

  async patch(sessionId: string, expectedRevision: number, patch: SessionRegistryPatch): Promise<SessionRegistryRecord> {
    this.#assertLoaded();
    const current = this.#records.get(sessionId);
    if (current === undefined) throw new SessionRegistryError("NOT_FOUND", "Session is not registered");
    if (current.brokerRevision !== expectedRevision) {
      throw new SessionRegistryError("REVISION_CONFLICT", "Session registry revision is stale");
    }
    const next: SessionRegistryRecord = {
      ...current,
      ...structuredClone(patch),
      brokerRevision: current.brokerRevision + 1,
    };
    validateLeaseTransition(current.lease, next.lease);
    this.#records.set(sessionId, next);
    await this.#flush();
    return structuredClone(next);
  }

  async acquireLease(input: {
    sessionId: string;
    expectedRevision: number;
    ownerId: string;
    runtimeId?: string;
    runtimeEpoch?: number;
    now?: string;
  }): Promise<SessionRegistryRecord> {
    const current = this.#require(input.sessionId);
    if (current.brokerRevision !== input.expectedRevision) {
      throw new SessionRegistryError("REVISION_CONFLICT", "Session registry revision is stale");
    }
    if (current.lease !== undefined && current.lease.ownerId !== input.ownerId) {
      throw new SessionRegistryError("LEASE_HELD", "Session is owned by another Worker");
    }
    const now = input.now ?? new Date().toISOString();
    const lease: SessionLeaseRecord = {
      ownerId: input.ownerId,
      leaseEpoch: (current.lease?.leaseEpoch ?? 0) + 1,
      acquiredAt: current.lease?.ownerId === input.ownerId ? current.lease.acquiredAt : now,
      heartbeatAt: now,
      ...(input.runtimeId === undefined ? {} : { runtimeId: input.runtimeId }),
      ...(input.runtimeEpoch === undefined ? {} : { runtimeEpoch: input.runtimeEpoch }),
    };
    return await this.patch(input.sessionId, input.expectedRevision, { lease, residency: "starting" });
  }

  async releaseLease(input: { sessionId: string; expectedRevision: number; ownerId: string; leaseEpoch: number }): Promise<SessionRegistryRecord> {
    const current = this.#require(input.sessionId);
    if (current.lease?.ownerId !== input.ownerId || current.lease.leaseEpoch !== input.leaseEpoch) {
      throw new SessionRegistryError("LEASE_STALE", "Session lease is stale");
    }
    return await this.patch(input.sessionId, input.expectedRevision, { lease: undefined, residency: "dormant", execution: "idle" });
  }

  #require(sessionId: string): SessionRegistryRecord {
    const record = this.get(sessionId);
    if (record === undefined) throw new SessionRegistryError("NOT_FOUND", "Session is not registered");
    return record;
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error("Session registry must be loaded before use");
  }

  async #flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.list(), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.path);
  }
}

function validateLeaseTransition(previous: SessionLeaseRecord | undefined, next: SessionLeaseRecord | undefined): void {
  if (next === undefined) return;
  if (next.ownerId.length === 0 || !Number.isSafeInteger(next.leaseEpoch) || next.leaseEpoch < 1) {
    throw new SessionRegistryError("INVALID", "Session lease is invalid");
  }
  if (previous !== undefined && next.leaseEpoch < previous.leaseEpoch) {
    throw new SessionRegistryError("INVALID", "Session lease epoch cannot regress");
  }
}

function parseRecord(value: unknown): SessionRegistryRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionRegistryError("INVALID", "Session registry record is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    typeof record.workspaceId !== "string" ||
    typeof record.profileId !== "string" ||
    typeof record.residency !== "string" ||
    typeof record.execution !== "string" ||
    !Number.isSafeInteger(record.brokerRevision) ||
    (record.brokerRevision as number) < 1
  ) {
    throw new SessionRegistryError("INVALID", "Session registry record is invalid");
  }
  const parsed: SessionRegistryRecord = {
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    profileId: record.profileId,
    residency: record.residency as SessionResidencyState,
    execution: record.execution as SessionExecutionState,
    brokerRevision: record.brokerRevision as number,
    ...(typeof record.transcriptRevision === "string" ? { transcriptRevision: record.transcriptRevision } : {}),
    ...(typeof record.runtimeId === "string" ? { runtimeId: record.runtimeId } : {}),
    ...(Number.isSafeInteger(record.runtimeEpoch) ? { runtimeEpoch: record.runtimeEpoch as number } : {}),
    ...(record.lease === undefined ? {} : { lease: parseLease(record.lease) }),
  };
  return parsed;
}

function parseLease(value: unknown): SessionLeaseRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionRegistryError("INVALID", "Session lease is invalid");
  }
  const lease = value as Record<string, unknown>;
  if (
    typeof lease.ownerId !== "string" ||
    !Number.isSafeInteger(lease.leaseEpoch) ||
    (lease.leaseEpoch as number) < 1 ||
    typeof lease.acquiredAt !== "string" ||
    typeof lease.heartbeatAt !== "string"
  ) {
    throw new SessionRegistryError("INVALID", "Session lease is invalid");
  }
  return {
    ownerId: lease.ownerId,
    leaseEpoch: lease.leaseEpoch as number,
    acquiredAt: lease.acquiredAt,
    heartbeatAt: lease.heartbeatAt,
    ...(typeof lease.runtimeId === "string" ? { runtimeId: lease.runtimeId } : {}),
    ...(Number.isSafeInteger(lease.runtimeEpoch) ? { runtimeEpoch: lease.runtimeEpoch as number } : {}),
  };
}
