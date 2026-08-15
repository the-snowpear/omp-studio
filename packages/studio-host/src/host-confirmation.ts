import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, type StudioOperation } from "@omp-studio/studio-protocol";
import { StudioHostError } from "./command-arbiter.js";

export const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * Optional token bindings (plan §3.4): the confirmation token is bound to
 * the interaction's lease generation and the Runtime epoch at issue time;
 * consumption with a mismatched binding fails closed.
 */
export interface ConfirmationTokenBinding {
  readonly leaseGeneration?: number;
  readonly runtimeEpoch?: number;
}

interface ConfirmationEntry {
  operationHash: string;
  owner: string;
  expiresAt: number;
  leaseGeneration?: number;
  runtimeEpoch?: number;
}

export interface HostConfirmationRegistryOptions {
  ttlMs?: number;
  capacity?: number;
  now?: () => number;
}

export class HostConfirmationRegistry {
  readonly #entries = new Map<string, ConfirmationEntry>();
  readonly #ttlMs: number;
  readonly #capacity: number;
  readonly #now: () => number;

  constructor(options: HostConfirmationRegistryOptions = {}) {
    const { ttlMs = DEFAULT_CONFIRMATION_TTL_MS, capacity = 64, now = Date.now } = options;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Confirmation registry capacity must be a positive integer");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("Confirmation TTL must be a positive number");
    }
    this.#ttlMs = ttlMs;
    this.#capacity = capacity;
    this.#now = now;
  }

  issue(operation: StudioOperation, owner: string, binding: ConfirmationTokenBinding = {}): string {
    this.#prune();
    const token = randomUUID();
    if (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(token, {
      operationHash: this.#hash(operation),
      owner,
      expiresAt: this.#now() + this.#ttlMs,
      ...(binding.leaseGeneration === undefined ? {} : { leaseGeneration: binding.leaseGeneration }),
      ...(binding.runtimeEpoch === undefined ? {} : { runtimeEpoch: binding.runtimeEpoch }),
    });
    return token;
  }

  consume(token: string, operation: StudioOperation, owner: string, binding: ConfirmationTokenBinding = {}): void {
    const entry = this.#entries.get(token);
    if (entry === undefined) {
      throw new StudioHostError("INTERACTION_STALE", "Confirmation token is unknown or already consumed");
    }
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(token);
      throw new StudioHostError("INTERACTION_STALE", "Confirmation token has expired");
    }
    if (entry.owner !== owner) {
      throw new StudioHostError("NOT_OWNER", "Confirmation token owner does not match");
    }
    if (entry.operationHash !== this.#hash(operation)) {
      throw new StudioHostError("NOT_OWNER", "Confirmation token is bound to a different operation");
    }
    if (
      binding.leaseGeneration !== undefined &&
      entry.leaseGeneration !== undefined &&
      entry.leaseGeneration !== binding.leaseGeneration
    ) {
      throw new StudioHostError("INTERACTION_STALE", "Confirmation token is bound to a different interaction generation");
    }
    if (binding.runtimeEpoch !== undefined && entry.runtimeEpoch !== undefined && entry.runtimeEpoch !== binding.runtimeEpoch) {
      throw new StudioHostError("INTERACTION_STALE", "Confirmation token is bound to a different runtime epoch");
    }
    this.#entries.delete(token);
  }

  #prune(): void {
    const now = this.#now();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token);
    }
  }

  #hash(operation: StudioOperation): string {
    return createHash("sha256").update(canonicalJson(operation)).digest("hex");
  }
}