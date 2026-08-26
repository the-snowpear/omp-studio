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
export const COMMAND_LEDGER_TERMINAL_ENTRY_LIMIT = 512;
export const COMMAND_LEDGER_TERMINAL_BYTE_LIMIT = 512 * 1024;

/** Trim and cap a Runtime failure message; undefined when it carries nothing. */
function ledgerErrorMessage(message: string | undefined): string | undefined {
  if (typeof message !== "string") return undefined;
  const trimmed = message.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_LEDGER_ERROR_MESSAGE_CHARS
    ? trimmed.slice(0, MAX_LEDGER_ERROR_MESSAGE_CHARS)
    : trimmed;
}

export class CommandLedger {
  readonly #entries = new Map<CommandId, CommandLedgerEntry>();
  readonly #commandIdByRequestId = new Map<string, CommandId>();
  readonly #terminalEntryBytes = new Map<CommandId, number>();
  #terminalBytes = 0;

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly store?: CommandLedgerStore,
  ) {
    for (const entry of store?.load() ?? []) {
      if (this.#entries.has(entry.commandId)) throw new Error(`Duplicate restored command id ${entry.commandId}`);
      if (this.#commandIdByRequestId.has(entry.requestId)) {
        throw new Error(`Duplicate restored request id ${entry.requestId}`);
      }
      const restored = structuredClone(entry);
      this.#entries.set(entry.commandId, restored);
      this.#commandIdByRequestId.set(entry.requestId, entry.commandId);
      if (TERMINAL.has(entry.status)) this.#trackTerminal(entry.commandId, restored);
    }
    this.#enforceTerminalBounds();
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
    if (this.#commandIdByRequestId.has(request.requestId)) {
      throw new Error(`Duplicate request id ${request.requestId}`);
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
    this.#commandIdByRequestId.set(entry.requestId, commandId);
    this.store?.append(entry);
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
    this.#entries.set(commandId, next);
    this.store?.append(next);
    if (TERMINAL.has(status)) {
      this.#trackTerminal(commandId, next);
      this.#enforceTerminalBounds();
    }
    return structuredClone(next);
  }

  reconcileReceipt(receipt: StudioReceipt): CommandLedgerEntry {
    let current = this.getByRequestId(receipt.requestId);
    if (current === undefined) throw new Error(`Unknown request id ${receipt.requestId}`);
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
    const changed: CommandLedgerEntry[] = [];
    for (const [commandId, entry] of this.#entries) {
      if (entry.runtimeId === runtimeId && entry.runtimeEpoch === runtimeEpoch && !TERMINAL.has(entry.status)) {
        changed.push(this.transition(commandId, "outcome_unknown", { errorCode: "OUTCOME_UNKNOWN" }));
      }
    }
    return changed;
  }

  get(commandId: CommandId): CommandLedgerEntry | undefined {
    const entry = this.#entries.get(commandId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  getByRequestId(requestId: string): CommandLedgerEntry | undefined {
    const commandId = this.#commandIdByRequestId.get(requestId);
    return commandId === undefined ? undefined : this.get(commandId);
  }

  snapshot(): CommandLedgerEntry[] {
    return [...this.#entries.values()].map((entry) => structuredClone(entry));
  }

  #rebindCommandId(current: CommandLedgerEntry, commandId: CommandId): CommandLedgerEntry {
    if (this.#entries.has(commandId)) throw new Error(`Duplicate command id ${commandId}`);
    this.#entries.delete(current.commandId);
    const terminalBytes = this.#terminalEntryBytes.get(current.commandId);
    if (terminalBytes !== undefined) this.#terminalEntryBytes.delete(current.commandId);
    const rebound = { ...current, commandId };
    this.#entries.set(commandId, rebound);
    this.#commandIdByRequestId.set(current.requestId, commandId);
    if (terminalBytes !== undefined) this.#terminalEntryBytes.set(commandId, terminalBytes);
    this.store?.append(rebound);
    return structuredClone(rebound);
  }

  #trackTerminal(commandId: CommandId, entry: CommandLedgerEntry): void {
    const previous = this.#terminalEntryBytes.get(commandId) ?? 0;
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    this.#terminalEntryBytes.set(commandId, bytes);
    this.#terminalBytes += bytes - previous;
  }

  #enforceTerminalBounds(): void {
    let evicted = false;
    while (
      this.#terminalEntryBytes.size > COMMAND_LEDGER_TERMINAL_ENTRY_LIMIT ||
      this.#terminalBytes > COMMAND_LEDGER_TERMINAL_BYTE_LIMIT
    ) {
      const oldest = this.#terminalEntryBytes.entries().next().value as [CommandId, number] | undefined;
      if (oldest === undefined) return;
      const [commandId, bytes] = oldest;
      evicted = true;
      this.#terminalEntryBytes.delete(commandId);
      this.#terminalBytes -= bytes;
      const entry = this.#entries.get(commandId);
      if (entry !== undefined) {
        this.#entries.delete(commandId);
        if (this.#commandIdByRequestId.get(entry.requestId) === commandId) {
          this.#commandIdByRequestId.delete(entry.requestId);
        }
      }
    }
    if (evicted) this.store?.compact?.([...this.#entries.values()]);
  }
}
