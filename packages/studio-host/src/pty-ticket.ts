import { randomBytes } from "node:crypto";
import { StudioHostError } from "./command-arbiter.js";

export type PtyControlAction = "resize" | "write" | "signal" | "terminate";

export interface PtyRuntimeBinding {
  runtimeId: string;
  runtimeEpoch: number;
}

export interface PtyAttachTicket {
  token: string;
  expiresAt: number;
  actions: PtyControlAction[];
}

interface TicketEntry extends PtyRuntimeBinding {
  expiresAt: number;
  actions: ReadonlySet<PtyControlAction>;
}

export interface PtyAttachTicketRegistryOptions {
  ttlMs?: number;
  capacity?: number;
  now?: () => number;
  randomToken?: () => string;
}

export const DEFAULT_PTY_TICKET_TTL_MS = 30_000;

const VALID_ACTIONS = new Set<PtyControlAction>(["resize", "write", "signal", "terminate"]);

/** Host-owned, one-time authorization for a manual PTY compatibility attachment. */
export class PtyAttachTicketRegistry {
  readonly #entries = new Map<string, TicketEntry>();
  readonly #ttlMs: number;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #randomToken: () => string;

  constructor(options: PtyAttachTicketRegistryOptions = {}) {
    const {
      ttlMs = DEFAULT_PTY_TICKET_TTL_MS,
      capacity = 64,
      now = Date.now,
      randomToken = () => randomBytes(32).toString("base64url"),
    } = options;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("PTY ticket TTL must be positive");
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("PTY ticket capacity must be a positive integer");
    }
    this.#ttlMs = ttlMs;
    this.#capacity = capacity;
    this.#now = now;
    this.#randomToken = randomToken;
  }

  issue(binding: PtyRuntimeBinding, actions: readonly PtyControlAction[]): PtyAttachTicket {
    assertBinding(binding);
    const normalized = normalizeActions(actions);
    this.#prune();
    if (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    const token = this.#randomToken();
    if (token.length < 32 || this.#entries.has(token)) {
      throw new Error("PTY ticket generator returned an unsafe or duplicate token");
    }
    const expiresAt = this.#now() + this.#ttlMs;
    this.#entries.set(token, {
      ...binding,
      expiresAt,
      actions: new Set(normalized),
    });
    return { token, expiresAt, actions: normalized };
  }

  consume(token: string, binding: PtyRuntimeBinding, action: PtyControlAction): void {
    assertBinding(binding);
    if (!VALID_ACTIONS.has(action)) throw new StudioHostError("UNAUTHENTICATED", "PTY action is invalid");
    const entry = this.#entries.get(token);
    if (entry === undefined) {
      throw new StudioHostError("UNAUTHENTICATED", "PTY attach ticket is unknown or already consumed");
    }
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(token);
      throw new StudioHostError("UNAUTHENTICATED", "PTY attach ticket has expired");
    }
    if (entry.runtimeId !== binding.runtimeId || entry.runtimeEpoch !== binding.runtimeEpoch) {
      throw new StudioHostError("NOT_OWNER", "PTY attach ticket belongs to a different Runtime epoch");
    }
    if (!entry.actions.has(action)) {
      throw new StudioHostError("NOT_OWNER", "PTY attach ticket does not grant this action");
    }
    this.#entries.delete(token);
  }

  revokeRuntime(binding: PtyRuntimeBinding): number {
    assertBinding(binding);
    let removed = 0;
    for (const [token, entry] of this.#entries) {
      if (entry.runtimeId === binding.runtimeId && entry.runtimeEpoch === binding.runtimeEpoch) {
        this.#entries.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    this.#prune();
    return this.#entries.size;
  }

  #prune(): void {
    const now = this.#now();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token);
    }
  }
}

function assertBinding(binding: PtyRuntimeBinding): void {
  if (binding.runtimeId.length === 0 || !Number.isSafeInteger(binding.runtimeEpoch) || binding.runtimeEpoch <= 0) {
    throw new TypeError("PTY ticket requires a Runtime identity and positive epoch");
  }
}

function normalizeActions(actions: readonly PtyControlAction[]): PtyControlAction[] {
  if (actions.length === 0) throw new TypeError("PTY ticket must grant at least one action");
  const normalized = [...new Set(actions)];
  if (normalized.some((action) => !VALID_ACTIONS.has(action))) throw new TypeError("PTY ticket action is invalid");
  return normalized;
}
