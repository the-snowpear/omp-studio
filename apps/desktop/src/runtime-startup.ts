import type { DesktopHostComposition } from "./types.js";

/** Owns Runtime startup and mutations until shutdown; no process escapes its tail. */
export class DesktopRuntimeStartup {
  #tail: Promise<unknown> = Promise.resolve();
  #bootstrap: Promise<void> | undefined;
  #ensure: { generation: number; force: boolean; promise: Promise<unknown> } | undefined;
  #pending = 0;
  #generation = 0;
  #runningGeneration: number | undefined;
  #closing = false;

  constructor(readonly changed: () => void) {}

  get pending(): boolean { return this.#pending > 0; }
  get closing(): boolean { return this.#closing; }
  get generation(): number { return this.#generation; }
  get canPublish(): boolean {
    return !this.#closing && (this.#runningGeneration === undefined || this.#runningGeneration === this.#generation);
  }

  changeWorkspace(): number {
    this.assertOpen();
    return ++this.#generation;
  }

  assertOpen(): void {
    if (this.#closing) throw new Error("desktop host composition is closed");
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.#pending++;
    this.changed();
    const result = this.#tail.then(async () => {
      this.assertOpen();
      this.#runningGeneration = this.#generation;
      try { return await work(); } finally { this.#runningGeneration = undefined; }
    }).finally(() => {
      this.#pending--;
      if (!this.#closing) this.changed();
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }

  start(work: () => Promise<void>): void {
    this.#bootstrap = this.run(work);
    // Default synchronous callers await this too; deferred callers leave ownership here.
    void this.#bootstrap.catch(() => undefined);
  }

  ready(): Promise<void> { return this.#bootstrap ?? Promise.resolve(); }

  ensure<T>(work: () => Promise<T>, current: () => T | undefined, force = false): Promise<T> {
    this.assertOpen();
    const generation = this.#generation;
    if (this.#ensure?.generation === generation && this.#ensure.force === force) return this.#ensure.promise as Promise<T>;
    const wasPending = this.pending;
    const result = this.run(async () => {
      const existing = current();
      if (generation !== this.#generation) throw new Error("Workspace changed before Runtime ensure");
      // An ensure issued during bootstrap joins its result instead of relaunching it.
      if (wasPending && !force && existing !== undefined) return existing;
      const result = await work();
      if (generation !== this.#generation) throw new Error("Workspace changed during Runtime ensure");
      return result;
    });
    this.#ensure = { generation, force, promise: result };
    void result.finally(() => { if (this.#ensure?.promise === result) this.#ensure = undefined; }).catch(() => undefined);
    return result;
  }

  close(): Promise<unknown> {
    this.#closing = true;
    return this.#tail;
  }
}

/** Runtime update trials must observe the terminal startup result, never connecting. */
export async function completeDesktopRuntimeTrial(
  composition: DesktopHostComposition,
  completeStartup: (ready: boolean, workspaceSelected: boolean) => Promise<unknown>,
  workspaceSelected: boolean,
): Promise<boolean> {
  if (!workspaceSelected) return false;
  await composition.whenRuntimeReady?.();
  const ready = composition.status === "ready";
  if (!ready) await composition.shutdown();
  await completeStartup(ready, workspaceSelected);
  return !ready;
}
