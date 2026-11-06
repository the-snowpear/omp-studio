import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "@omp-studio/runtime-installer";
import type { ManagedRuntimeAcceptance, ManagedRuntimeAcceptanceValue } from "./runtime-resolver.js";

interface AcceptanceRecord {
  key: string;
  value: ManagedRuntimeAcceptanceValue;
}

/** One successful managed-runtime acceptance per Host profile; never stores live state. */
export class FileManagedRuntimeAcceptance implements ManagedRuntimeAcceptance {
  #record: Promise<AcceptanceRecord | undefined>;

  constructor(readonly file: string) {
    // Start the small read alongside Host initialization, before the executable scan.
    this.#record = readFile(file, "utf8")
      .then(text => JSON.parse(text) as AcceptanceRecord)
      .catch(() => undefined);
  }

  async get(key: string): Promise<ManagedRuntimeAcceptanceValue | undefined> {
    const record = await this.#record;
    const value = record?.value;
    if (record?.key !== key || !value || !Number.isInteger(value.protocol) ||
      (value.runtimeProfile !== "full-parity-v1" && value.runtimeProfile !== "limited") ||
      !Array.isArray(value.missingCapabilities) || !value.missingCapabilities.every(id => typeof id === "string")) return undefined;
    return value;
  }

  async set(key: string, value: ManagedRuntimeAcceptanceValue): Promise<void> {
    const record = { key, value };
    this.#record = Promise.resolve(record);
    // A read-only profile loses the cross-launch optimization, not a verified Runtime.
    await writeJsonAtomic(this.file, record).catch(() => undefined);
  }
}
