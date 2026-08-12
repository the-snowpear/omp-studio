import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionBinding, ThreadId } from "@omp-studio/studio-protocol";

export interface StoredThreadBinding {
  binding: SessionBinding;
  executableIdentity: string;
}

/** Durable Host-owned Thread -> Runtime binding registry used by relaunch and retention. */
export class ThreadBindingStore {
  readonly #bindings = new Map<ThreadId, StoredThreadBinding>();

  constructor(readonly path: string) {}

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!Array.isArray(value)) throw new TypeError("Thread binding store must be an array");
      this.#bindings.clear();
      for (const entry of value) {
        assertStoredBinding(entry);
        this.#bindings.set(entry.binding.threadId, structuredClone(entry));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async bind(binding: SessionBinding, executableIdentity: string): Promise<void> {
    if (executableIdentity.length === 0) throw new TypeError("Executable identity is required");
    this.#bindings.set(binding.threadId, { binding: structuredClone(binding), executableIdentity });
    await this.#flush();
  }

  async unbind(threadId: ThreadId): Promise<void> {
    if (!this.#bindings.delete(threadId)) return;
    await this.#flush();
  }

  get(threadId: ThreadId): StoredThreadBinding | undefined {
    const entry = this.#bindings.get(threadId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  list(): StoredThreadBinding[] {
    return [...this.#bindings.values()].map(entry => structuredClone(entry));
  }

  referencingThreads(runtimeVersion: string): ThreadId[] {
    return this.list()
      .filter(entry => entry.binding.runtimeVersion === runtimeVersion)
      .map(entry => entry.binding.threadId);
  }

  isRuntimeReferenced(runtimeVersion: string): boolean {
    return this.referencingThreads(runtimeVersion).length > 0;
  }

  async #flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.list(), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.path);
  }
}

function assertStoredBinding(value: unknown): asserts value is StoredThreadBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Thread binding entry must be an object");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.executableIdentity !== "string" || entry.executableIdentity.length === 0) {
    throw new TypeError("Thread binding executable identity is invalid");
  }
  if (entry.binding === null || typeof entry.binding !== "object" || Array.isArray(entry.binding)) {
    throw new TypeError("Thread binding is invalid");
  }
  const binding = entry.binding as Record<string, unknown>;
  for (const key of ["threadId", "runtimeId", "runtimeVersion"]) {
    if (typeof binding[key] !== "string" || binding[key].length === 0) throw new TypeError(`Thread binding ${key} is invalid`);
  }
  if (!Number.isSafeInteger(binding.runtimeEpoch) || (binding.runtimeEpoch as number) < 1) {
    throw new TypeError("Thread binding runtimeEpoch is invalid");
  }
}
