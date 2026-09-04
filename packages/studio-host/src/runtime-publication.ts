import type { CommandLedgerEntry, OperatorStateSnapshot } from "@omp-studio/studio-protocol";

const TERMINAL = new Set<CommandLedgerEntry["status"]>(["completed", "failed", "rejected", "outcome_unknown"]);

/**
 * Committed Host read model.
 *
 * Every field is owned by the store from the moment `publish` returns: `publish`
 * and `current` hand out the *same* object and never copy it. Consumers must
 * treat it — and its `snapshot` / `terminalOutcomes` — as frozen; mutating one
 * corrupts the committed view for every other subscriber, including later
 * `current()` callers. The `readonly` markers are the enforcement, not decoration.
 *
 * This used to deep-clone three times per publish plus once per `current()`, and
 * `current()` has ~38 call sites. Combined with a projection that republished on
 * every streamed token, that was the single largest allocation source in Main.
 */
export interface RuntimePublication {
  readonly commitSeq: number;
  readonly publishedAt: string;
  readonly snapshot: OperatorStateSnapshot;
  readonly terminalOutcomes: readonly CommandLedgerEntry[];
}

export class RuntimePublicationStore {
  #commitSeq = 0;
  #current: RuntimePublication | undefined;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  /**
   * Takes ownership of `snapshot` and `ledger`: callers must pass values nobody
   * else retains. `CommandLedger.terminalSnapshot()` and
   * `StudioBridgeClient.projectionSnapshot()` both already return fresh copies;
   * a caller holding onto its argument (e.g. a parsed snapshot response it also
   * returns) must clone before calling.
   */
  publish(snapshot: OperatorStateSnapshot, ledger: readonly CommandLedgerEntry[]): RuntimePublication {
    this.#commitSeq += 1;
    // `terminalSnapshot()` already filtered; re-filter only when a caller passed
    // a full ledger so the terminal-only invariant holds at the boundary.
    const terminalOutcomes = ledger.every((entry) => TERMINAL.has(entry.status))
      ? ledger
      : ledger.filter((entry) => TERMINAL.has(entry.status));
    this.#current = {
      commitSeq: this.#commitSeq,
      publishedAt: this.now(),
      snapshot,
      terminalOutcomes,
    };
    return this.#current;
  }

  current(): RuntimePublication | undefined {
    return this.#current;
  }
}
