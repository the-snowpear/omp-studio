import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SessionBrokerError, type SessionLease, type SessionLeaseStore } from "./session-broker.js";

export interface FileSessionLeaseStoreOptions {
  readonly directory: string;
  readonly staleAfterMs?: number;
  readonly now?: () => number;
}

interface StoredLease {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly leaseEpoch: number;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
}

/**
 * Cross-process Session single-writer lease. Acquisition is an exclusive file
 * create; the file contains only opaque identity and timing metadata.
 */
export class FileSessionLeaseStore implements SessionLeaseStore {
  readonly #directory: string;
  readonly #staleAfterMs: number;
  readonly #now: () => number;

  constructor(options: FileSessionLeaseStoreOptions) {
    if (options.directory.length === 0) throw new TypeError("Lease directory is required");
    if (options.staleAfterMs !== undefined && (!Number.isSafeInteger(options.staleAfterMs) || options.staleAfterMs <= 0)) {
      throw new TypeError("staleAfterMs must be a positive integer");
    }
    this.#directory = options.directory;
    this.#staleAfterMs = options.staleAfterMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  async acquire(input: { readonly sessionId: string; readonly ownerId: string }): Promise<SessionLease> {
    if (input.sessionId.length === 0 || input.ownerId.length === 0) throw new TypeError("Lease identity is required");
    await mkdir(this.#directory, { recursive: true });
    const path = this.#pathFor(input.sessionId);
    let previousEpoch = await this.#readEpoch(path);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = this.#now();
      const current = await this.#read(path);
      if (current !== undefined) {
        previousEpoch = Math.max(previousEpoch, current.leaseEpoch);
        if (current.ownerId === input.ownerId) {
          throw new SessionBrokerError("SESSION_LEASE_BUSY", "Session lease is already held by this Broker");
        }
        if (now - current.heartbeatAt <= this.#staleAfterMs) {
          throw new SessionBrokerError("SESSION_LEASE_BUSY", "Session is already owned by another Worker");
        }
        try {
          await rename(path, `${path}.stale-${process.pid}-${now}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        continue;
      }
      const record: StoredLease = {
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        leaseEpoch: previousEpoch + 1,
        acquiredAt: now,
        heartbeatAt: now,
      };
      try {
        await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      await this.#writeEpoch(path, record.leaseEpoch);
      let released = false;
      return {
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        leaseEpoch: record.leaseEpoch,
        heartbeat: async () => {
          if (released) return;
          const active = await this.#read(path);
          if (active?.ownerId !== input.ownerId || active.leaseEpoch !== record.leaseEpoch) {
            throw new SessionBrokerError("SESSION_LEASE_BUSY", "Session lease is no longer owned by this Broker");
          }
          await this.#replace(path, { ...active, heartbeatAt: this.#now() });
        },
        release: async () => {
          if (released) return;
          released = true;
          const active = await this.#read(path);
          if (active?.ownerId === input.ownerId && active.leaseEpoch === record.leaseEpoch) await rm(path, { force: true });
        },
      };
    }
    throw new SessionBrokerError("SESSION_LEASE_BUSY", "Session lease acquisition raced with another Broker");
  }

  #pathFor(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(this.#directory, `${digest}.lease`);
  }

  async #readEpoch(path: string): Promise<number> {
    try {
      const value = Number.parseInt(await readFile(`${path}.epoch`, "utf8"), 10);
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  async #writeEpoch(path: string, epoch: number): Promise<void> {
    const epochPath = `${path}.epoch`;
    const temporary = `${epochPath}.${process.pid}.${this.#now()}.tmp`;
    await writeFile(temporary, `${epoch}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, epochPath);
  }

  async #read(path: string): Promise<StoredLease | undefined> {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<StoredLease>;
      if (
        typeof value.sessionId !== "string" ||
        typeof value.ownerId !== "string" ||
        !Number.isSafeInteger(value.leaseEpoch) ||
        !Number.isSafeInteger(value.acquiredAt) ||
        !Number.isSafeInteger(value.heartbeatAt)
      ) {
        throw new SessionBrokerError("SESSION_LEASE_BUSY", "Session lease metadata is invalid");
      }
      return value as StoredLease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #replace(path: string, record: StoredLease): Promise<void> {
    const temporary = `${path}.${process.pid}.${this.#now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  }
}
