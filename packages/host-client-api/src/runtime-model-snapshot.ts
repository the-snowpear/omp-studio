import type { ModelConfigReadModel } from "@omp-studio/client-contract";
import type { ModelAvailableOperation, ModelAvailablePage } from "@omp-studio/studio-protocol";
import { withRuntimeModels } from "./omp-models-adapter.js";

export interface RuntimeModelReadTarget {
  readonly owner: object;
  /** Runtime id/epoch, session, workspace, locale and Host model-write generation. */
  readonly key: string;
  readonly sessionId: string;
  readonly isCurrent: () => boolean;
  readonly read: (operation: ModelAvailableOperation) => Promise<ModelAvailablePage | { released: boolean }>;
}

function assertTarget(target: RuntimeModelReadTarget, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (!target.isCurrent()) throw Object.assign(new Error("Runtime model target changed"), { code: "STALE_EPOCH" });
}

/** Only ongoing reads share work. Each caller first obtains a live native generation; nothing is cached by cwd. */
export class RuntimeModelSnapshotReads {
  readonly #pending = new WeakMap<object, Map<string, Promise<ModelConfigReadModel>>>();

  async read(target: RuntimeModelReadTarget, loadConfig: () => ModelConfigReadModel | Promise<ModelConfigReadModel>, signal: AbortSignal): Promise<ModelConfigReadModel> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#attempt(target, loadConfig, signal);
      } catch (error) {
        // A mid-page auth/config refresh expires the entire lease. Never stitch old and new pages.
        const failure = error as { code?: string; retryable?: boolean };
        if (attempt >= 1 || failure.code !== "COMMAND_BLOCKED" || failure.retryable !== true || !target.isCurrent() || signal.aborted) throw error;
      }
    }
  }

  async #attempt(target: RuntimeModelReadTarget, loadConfig: () => ModelConfigReadModel | Promise<ModelConfigReadModel>, signal: AbortSignal): Promise<ModelConfigReadModel> {
    assertTarget(target, signal);
    const first = await target.read({ kind: "models.available.read", sessionId: target.sessionId, limit: 200 }) as ModelAvailablePage;
    const release = () => target.read({ kind: "models.available.release", sessionId: target.sessionId, snapshotId: first.snapshotId }).catch(() => {});
    const onAbort = () => { void release(); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      assertTarget(target, signal);
      let pending = this.#pending.get(target.owner);
      if (!pending) { pending = new Map(); this.#pending.set(target.owner, pending); }
      const key = JSON.stringify([target.key, first.version]);
      let task = pending.get(key);
      if (!task) {
        task = this.#consume(target, first, loadConfig, signal);
        pending.set(key, task);
        const created = task;
        void task.finally(() => { if (pending.get(key) === created) pending.delete(key); }).catch(() => {});
      }
      const result = await task;
      assertTarget(target, signal);
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
      await release();
    }
  }

  async #consume(target: RuntimeModelReadTarget, first: ModelAvailablePage, loadConfig: () => ModelConfigReadModel | Promise<ModelConfigReadModel>, signal: AbortSignal): Promise<ModelConfigReadModel> {
    const config = await loadConfig();
    assertTarget(target, signal);
    const models = [...first.models];
    let cursor = first.nextCursor;
    // Native snapshots have at most 10k rows and bounded pages; this also bounds bridge work on a lost peer.
    for (let page = 0; cursor && page < 128; page++) {
      const next = await target.read({ kind: "models.available.read", sessionId: target.sessionId, cursor }) as ModelAvailablePage;
      assertTarget(target, signal);
      models.push(...next.models);
      cursor = next.nextCursor;
    }
    if (cursor) throw Object.assign(new Error("Runtime model snapshot exceeds the read budget"), { code: "CAPABILITY_UNAVAILABLE" });
    // The config read may have crossed a credential change even for a single-page catalog.
    await target.read({ kind: "models.available.read", sessionId: target.sessionId, cursor: first.cursor });
    assertTarget(target, signal);
    return withRuntimeModels(config, { ...first, models });
  }
}
