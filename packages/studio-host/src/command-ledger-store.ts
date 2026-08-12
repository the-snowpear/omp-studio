import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandLedgerEntry } from "@omp-studio/studio-protocol";

export interface CommandLedgerStore {
  load(): CommandLedgerEntry[];
  append(entry: CommandLedgerEntry): void;
}

export class JsonlCommandLedgerStore implements CommandLedgerStore {
  constructor(private readonly path: string) {}

  load(): CommandLedgerEntry[] {
    if (!existsSync(this.path)) return [];
    const latest = new Map<string, CommandLedgerEntry>();
    const content = readFileSync(this.path, "utf8");
    const lines = content.split(/\r?\n/u);
    let lastNonEmptyIndex = lines.length - 1;
    while (lastNonEmptyIndex >= 0 && lines[lastNonEmptyIndex]?.length === 0) lastNonEmptyIndex -= 1;
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        const isTruncatedTail = index === lastNonEmptyIndex && !/\r?\n$/u.test(content);
        if (isTruncatedTail) break;
        throw new TypeError(`Invalid command ledger JSON at line ${index + 1}`, { cause: error });
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`Invalid command ledger entry at line ${index + 1}`);
      }
      const entry = parseLedgerEntry(value, index + 1);
      latest.set(entry.requestId, entry);
    }
    return [...latest.values()];
  }

  append(entry: CommandLedgerEntry): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const descriptor = openSync(this.path, "a", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(entry)}\n`, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

const LEDGER_STATUSES = new Set([
  "requested",
  "accepted",
  "interaction_required",
  "completed",
  "failed",
  "rejected",
  "outcome_unknown",
]);

function parseLedgerEntry(value: object, line: number): CommandLedgerEntry {
  const input = value as Record<string, unknown>;
  const requiredStrings = ["commandId", "requestId", "runtimeId", "operationKind", "requestedAt"] as const;
  if (
    requiredStrings.some((field) => typeof input[field] !== "string" || input[field].length === 0) ||
    !Number.isSafeInteger(input.runtimeEpoch) ||
    (input.runtimeEpoch as number) <= 0 ||
    typeof input.status !== "string" ||
    !LEDGER_STATUSES.has(input.status)
  ) {
    throw new TypeError(`Invalid command ledger entry at line ${line}`);
  }
  for (const field of ["stateVersionBefore", "stateVersionAfter"] as const) {
    if (input[field] !== undefined && (!Number.isSafeInteger(input[field]) || (input[field] as number) < 0)) {
      throw new TypeError(`Invalid command ledger entry at line ${line}`);
    }
  }
  for (const field of ["terminalAt", "errorCode"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      throw new TypeError(`Invalid command ledger entry at line ${line}`);
    }
  }
  return structuredClone(input) as unknown as CommandLedgerEntry;
}
