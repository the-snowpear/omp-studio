import type { CommandLedgerEntry, OperatorStateSnapshot } from "@omp-studio/studio-protocol";

const TERMINAL = new Set<CommandLedgerEntry["status"]>(["completed", "failed", "rejected", "outcome_unknown"]);

export interface RuntimePublication {
  commitSeq: number;
  publishedAt: string;
  snapshot: OperatorStateSnapshot;
  terminalOutcomes: CommandLedgerEntry[];
}

export class RuntimePublicationStore {
  #commitSeq = 0;
  #current: RuntimePublication | undefined;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  publish(snapshot: OperatorStateSnapshot, ledger: readonly CommandLedgerEntry[]): RuntimePublication {
    this.#commitSeq += 1;
    this.#current = {
      commitSeq: this.#commitSeq,
      publishedAt: this.now(),
      snapshot: structuredClone(snapshot),
      terminalOutcomes: ledger.filter((entry) => TERMINAL.has(entry.status)).map((entry) => structuredClone(entry)),
    };
    return structuredClone(this.#current);
  }

  current(): RuntimePublication | undefined {
    return this.#current === undefined ? undefined : structuredClone(this.#current);
  }
}
