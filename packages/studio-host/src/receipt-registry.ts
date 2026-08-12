import { canonicalJson, type IdempotencyKey, type StudioOperation, type StudioReceipt } from "@omp-studio/studio-protocol";

interface RegistryEntry {
  operation: string;
  receipt: StudioReceipt;
}

export type ReceiptLookup =
  | { kind: "miss" }
  | { kind: "replay"; receipt: StudioReceipt }
  | { kind: "conflict" };

export class ReceiptRegistry {
  readonly #entries = new Map<IdempotencyKey, RegistryEntry>();

  constructor(private readonly capacity = 512) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Receipt registry capacity must be a positive integer");
    }
  }

  lookup(key: IdempotencyKey, operation: StudioOperation): ReceiptLookup {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return { kind: "miss" };
    }
    return entry.operation === canonicalJson(operation)
      ? { kind: "replay", receipt: structuredClone(entry.receipt) }
      : { kind: "conflict" };
  }

  remember(key: IdempotencyKey, operation: StudioOperation, receipt: StudioReceipt): void {
    this.#entries.delete(key);
    this.#entries.set(key, { operation: canonicalJson(operation), receipt: structuredClone(receipt) });
    while (this.#entries.size > this.capacity) {
      const oldest = this.#entries.keys().next().value as IdempotencyKey | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
