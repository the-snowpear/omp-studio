import { join, resolve } from "node:path";
import { SessionArchiveWorkerPool, SessionTelemetryStore, type SessionArchiveReaderPort } from "@omp-studio/studio-host";
import { SharedArchiveTelemetry, SharedProjectReads } from "@omp-studio/host-client-api";
import type { QueryResult } from "@omp-studio/client-contract";
import { registerHostReadDiagnostics } from "./desktop-performance.js";

/** Authority lifetime; workspace paths are captured, never read from a mutable selection. */
export class ProjectReadServices {
  readonly archiveBudget = new SessionArchiveWorkerPool();
  readonly metadata = new SharedProjectReads();
  readonly telemetry = new SharedArchiveTelemetry<QueryResult<"session.telemetry.read"> | undefined>();
  readonly #stores = new Map<string, SessionTelemetryStore>();
  readonly #services = new Map<string, object>();
  readonly #unregister = registerHostReadDiagnostics(() => {
    const counters: Record<string, number> = {};
    for (const [name, source] of [["archiveCache", this.archiveBudget], ["projectReads", this.metadata], ["telemetryReads", this.telemetry]] as const)
      for (const [key, value] of Object.entries(source.diagnostics())) counters[`${name}.${key}`] = value;
    return counters;
  });
  archive(cwd: string): SessionArchiveReaderPort {
    return this.archiveBudget.reader(cwd);
  }
  /** Bind once per method call; an awaited read cannot follow a later cwd change. */
  scoped<T extends object>(kind: string, current: () => string | undefined, create: (cwd: string | undefined) => T): T {
    return new Proxy({} as T, { get: (_target, property) => {
      const cwd = current(), key = `${kind}\0${cwd ?? ""}`;
      let service = this.#services.get(key) as T | undefined;
      if (!service) service = create(cwd);
      this.#services.delete(key); this.#services.set(key, service);
      while (this.#services.size > 32) this.#services.delete(this.#services.keys().next().value!);
      const value = Reflect.get(service, property);
      return typeof value === "function" ? value.bind(service) : value;
    } });
  }
  store(cwd: string, profile: string): SessionTelemetryStore {
    const key = resolve(cwd);
    let store = this.#stores.get(key);
    if (!store) {
      store = new SessionTelemetryStore({ rootDirectory: join(profile, "session-telemetry", "v1"),
        resolveRevision: async id => (await this.archive(key).readRevision(id)).transcriptRevision });
      this.#stores.set(key, store);
      while (this.#stores.size > 8) {
        const [oldest, entry] = this.#stores.entries().next().value!;
        this.#stores.delete(oldest); void entry.flush().finally(() => entry.dispose());
      }
    }
    return store;
  }
  async dispose(): Promise<void> {
    this.#unregister();
    await this.telemetry.dispose(); this.metadata.invalidate();
    this.#services.clear();
    await Promise.all([...this.#stores.values()].map(async store => { await store.flush(); store.dispose(); }));
    this.#stores.clear();
    await this.archiveBudget.dispose();
  }
}
