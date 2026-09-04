import type {
  CommandId,
  CommandLedgerEntry,
  RuntimeEpoch,
  RuntimeId,
  StateVersion,
  StudioRequest,
  StudioReceipt,
} from "@omp-studio/studio-protocol";
import type { CommandLedgerStore } from "./command-ledger-store.js";

type LedgerStatus = CommandLedgerEntry["status"];

const TERMINAL = new Set<LedgerStatus>(["completed", "failed", "rejected", "outcome_unknown"]);
const TRANSITIONS: Readonly<Record<LedgerStatus, ReadonlySet<LedgerStatus>>> = {
  requested: new Set(["accepted", "rejected", "failed", "outcome_unknown"]),
  accepted: new Set(["interaction_required", "completed", "failed", "outcome_unknown"]),
  interaction_required: new Set(["accepted", "completed", "failed", "rejected", "outcome_unknown"]),
  completed: new Set(),
  failed: new Set(),
  rejected: new Set(),
  outcome_unknown: new Set(),
};

/**
 * Longest Runtime failure text the ledger keeps. The ledger is fsynced per
 * append, so an unbounded message would be paid for on every write; the
 * failures worth reading ("Model is not available: provider/id") are short.
 */
const MAX_LEDGER_ERROR_MESSAGE_CHARS = 512;

/** Trim and cap a Runtime failure message; undefined when it carries nothing. */
function ledgerErrorMessage(message: string | undefined): string | undefined {
  if (typeof message !== "string") return undefined;
  const trimmed = message.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_LEDGER_ERROR_MESSAGE_CHARS
    ? trimmed.slice(0, MAX_LEDGER_ERROR_MESSAGE_CHARS)
    : trimmed;
}

/**
 * Terminal ledger rows retained in memory.
 *
 * The ledger used to be an unbounded `Map`: one permanent row per prompt,
 * steer, approval, `agent.*` and `job.*` for the whole Worker lifetime. Bytes
 * per row are small, but `snapshot()` deep-clones the whole map and used to run
 * on every published projection — i.e. once per streamed token — so the cost of
 * a token grew with how long the session had been chatting.
 *
 * Chosen above the Renderer's own `COMMAND_STATE_TERMINAL_CAP`
 * (packages/client/src/reducer.ts, 100) so the Host never forgets an outcome the
 * Renderer would still be showing, and below `ReceiptRegistry`'s capacity
 * (receipt-registry.ts, 512), which must outlive the ledger row it de-duplicates.
 */
export const COMMAND_LEDGER_TERMINAL_CAP = 256;

export class CommandLedger {
  readonly #entries = new Map<CommandId, CommandLedgerEntry>();
  /**
   * Request ids whose terminal row the capacity policy dropped. A receipt for
   * one of these must not throw: its outcome was published when the row went
   * terminal, so re-applying it is a no-op. An id that was *never* seen still
   * throws — see `reconcileReceipt`.
   */
  readonly #evictedRequestIds = new Set<string>();
  #terminalRevision = 0;

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly store?: CommandLedgerStore,
    private readonly terminalCapacity = COMMAND_LEDGER_TERMINAL_CAP,
  ) {
    if (!Number.isSafeInteger(terminalCapacity) || terminalCapacity < 1) {
      throw new RangeError("Command ledger terminal capacity must be a positive integer");
    }
    for (const entry of store?.load() ?? []) {
      if (this.#entries.has(entry.commandId)) throw new Error(`Duplicate restored command id ${entry.commandId}`);
      this.#entries.set(entry.commandId, structuredClone(entry));
    }
    this.#evictTerminal();
  }

  request(
    commandId: CommandId,
    request: StudioRequest,
    runtimeId: RuntimeId,
    stateVersionBefore?: StateVersion,
  ): CommandLedgerEntry {
    if (this.#entries.has(commandId)) {
      throw new Error(`Duplicate command id ${commandId}`);
    }
    const entry: CommandLedgerEntry = {
      commandId,
      requestId: request.requestId,
      runtimeId,
      runtimeEpoch: request.runtimeEpoch,
      operationKind: request.operation.kind,
      requestedAt: this.now(),
      status: "requested",
      ...(stateVersionBefore === undefined ? {} : { stateVersionBefore }),
    };
    this.#entries.set(commandId, entry);
    this.store?.append(entry);
    this.#evictTerminal();
    return structuredClone(entry);
  }

  transition(
    commandId: CommandId,
    status: LedgerStatus,
    options: { stateVersionAfter?: StateVersion; errorCode?: string; errorMessage?: string } = {},
  ): CommandLedgerEntry {
    const current = this.#entries.get(commandId);
    if (current === undefined) {
      throw new Error(`Unknown command id ${commandId}`);
    }
    if (!TRANSITIONS[current.status]!.has(status)) {
      throw new Error(`Invalid ledger transition ${current.status} -> ${status}`);
    }
    const next: CommandLedgerEntry = {
      ...current,
      status,
      ...(options.stateVersionAfter === undefined ? {} : { stateVersionAfter: options.stateVersionAfter }),
      ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
      ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
      ...(TERMINAL.has(status) ? { terminalAt: this.now() } : {}),
    };
    // Terminal rows move to the end of insertion order so that, among terminal
    // rows, iteration order *is* terminalization order. `#evictTerminal` drops
    // from the front, which therefore drops the longest-settled row and never
    // the one this call just settled — an outcome must survive long enough to
    // be published.
    if (TERMINAL.has(status)) this.#entries.delete(commandId);
    this.#entries.set(commandId, next);
    if (TERMINAL.has(status)) this.#terminalRevision += 1;
    this.store?.append(next);
    this.#evictTerminal();
    return structuredClone(next);
  }

  /**
   * Drop the oldest-settled terminal rows above capacity. In-flight rows are
   * never candidates: a non-terminal row is the only record a receipt can still
   * be reconciled against, so exceeding the cap is preferable to losing one.
   */
  #evictTerminal(): void {
    let terminal = 0;
    for (const entry of this.#entries.values()) if (TERMINAL.has(entry.status)) terminal += 1;
    let extra = terminal - this.terminalCapacity;
    if (extra <= 0) return;
    for (const [commandId, entry] of [...this.#entries]) {
      if (extra <= 0) break;
      if (!TERMINAL.has(entry.status)) continue;
      this.#entries.delete(commandId);
      this.#evictedRequestIds.add(entry.requestId);
      extra -= 1;
    }
    // Remembered well past the terminal cap: this set exists so a late receipt
    // cannot throw (the caller runs inside the Bridge socket handler, where an
    // unexpected throw destroys the socket), and the row it refers to was
    // evicted precisely because it is old. Beyond this window a receipt is
    // indistinguishable from a protocol fault and still fails closed.
    const rememberedIds = this.terminalCapacity * 4;
    while (this.#evictedRequestIds.size > rememberedIds) {
      const oldest = this.#evictedRequestIds.values().next().value;
      if (oldest === undefined) break;
      this.#evictedRequestIds.delete(oldest);
    }
  }

  /**
   * Returns `undefined` when the receipt names a request whose terminal row the
   * capacity policy already dropped: that outcome was published when the row
   * went terminal, so re-applying it is a no-op. A request id that was never
   * seen still throws — a receipt the Host cannot correlate is a protocol fault,
   * and the caller runs inside the Bridge socket handler, where an unexpected
   * throw destroys the socket.
   */
  reconcileReceipt(receipt: StudioReceipt): CommandLedgerEntry | undefined {
    let current = this.getByRequestId(receipt.requestId);
    if (current === undefined) {
      if (this.#evictedRequestIds.has(receipt.requestId)) return undefined;
      throw new Error(`Unknown request id ${receipt.requestId}`);
    }
    if (receipt.commandId !== undefined && receipt.commandId !== current.commandId) {
      current = this.#rebindCommandId(current, receipt.commandId);
    }
    if (TERMINAL.has(current.status)) {
      if (current.status !== receipt.status) {
        throw new Error(`Conflicting terminal receipt ${current.status} -> ${receipt.status}`);
      }
      return current;
    }
    if (receipt.status === "accepted" && current.status === "accepted") return current;
    if (receipt.status === "completed" && current.status === "requested") {
      current = this.transition(current.commandId, "accepted", { stateVersionAfter: receipt.stateVersion });
    }
    const errorMessage = receipt.error === undefined ? undefined : ledgerErrorMessage(receipt.error.message);
    return this.transition(current.commandId, receipt.status, {
      stateVersionAfter: receipt.stateVersion,
      ...(receipt.error === undefined ? {} : { errorCode: receipt.error.code }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
  }

  markRuntimeLost(runtimeId: RuntimeId, runtimeEpoch: RuntimeEpoch): CommandLedgerEntry[] {
    // Collect first: `transition` now mutates the map (terminal rows move to the
    // end, and eviction may delete rows), so transitioning while iterating would
    // read a map that is changing underneath the iterator.
    const targets: CommandId[] = [];
    for (const [commandId, entry] of this.#entries) {
      if (entry.runtimeId === runtimeId && entry.runtimeEpoch === runtimeEpoch && !TERMINAL.has(entry.status)) {
        targets.push(commandId);
      }
    }
    return targets.map((commandId) => this.transition(commandId, "outcome_unknown", { errorCode: "OUTCOME_UNKNOWN" }));
  }

  get(commandId: CommandId): CommandLedgerEntry | undefined {
    const entry = this.#entries.get(commandId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  getByRequestId(requestId: string): CommandLedgerEntry | undefined {
    for (const entry of this.#entries.values()) {
      if (entry.requestId === requestId) return structuredClone(entry);
    }
    return undefined;
  }

  snapshot(): CommandLedgerEntry[] {
    return [...this.#entries.values()].map((entry) => structuredClone(entry));
  }

  /**
   * Terminal rows only, cloned. Filters *before* cloning: the publication read
   * model carries nothing else, so cloning in-flight rows on the publish path is
   * pure waste. Prefer this over `snapshot()` for anything on a hot path.
   */
  terminalSnapshot(): CommandLedgerEntry[] {
    const rows: CommandLedgerEntry[] = [];
    for (const entry of this.#entries.values()) {
      if (TERMINAL.has(entry.status)) rows.push(structuredClone(entry));
    }
    return rows;
  }

  /** Monotonic revision for the terminal portion of the ledger. */
  get terminalRevision(): number {
    return this.#terminalRevision;
  }

  #rebindCommandId(current: CommandLedgerEntry, commandId: CommandId): CommandLedgerEntry {
    if (this.#entries.has(commandId)) throw new Error(`Duplicate command id ${commandId}`);
    this.#entries.delete(current.commandId);
    const rebound = { ...current, commandId };
    this.#entries.set(commandId, rebound);
    this.store?.append(rebound);
    return structuredClone(rebound);
  }
}
