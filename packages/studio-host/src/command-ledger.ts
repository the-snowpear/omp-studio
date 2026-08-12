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

export class CommandLedger {
  readonly #entries = new Map<CommandId, CommandLedgerEntry>();

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly store?: CommandLedgerStore,
  ) {
    for (const entry of store?.load() ?? []) {
      if (this.#entries.has(entry.commandId)) throw new Error(`Duplicate restored command id ${entry.commandId}`);
      this.#entries.set(entry.commandId, structuredClone(entry));
    }
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
    return structuredClone(entry);
  }

  transition(
    commandId: CommandId,
    status: LedgerStatus,
    options: { stateVersionAfter?: StateVersion; errorCode?: string } = {},
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
      ...(TERMINAL.has(status) ? { terminalAt: this.now() } : {}),
    };
    this.#entries.set(commandId, next);
    this.store?.append(next);
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
    return this.transition(current.commandId, receipt.status, {
      stateVersionAfter: receipt.stateVersion,
      ...(receipt.error === undefined ? {} : { errorCode: receipt.error.code }),
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
    for (const entry of this.#entries.values()) {
      if (entry.requestId === requestId) return structuredClone(entry);
    }
    return undefined;
  }

  snapshot(): CommandLedgerEntry[] {
    return [...this.#entries.values()].map((entry) => structuredClone(entry));
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
