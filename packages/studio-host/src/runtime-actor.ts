import type { RuntimeEpoch, RuntimeId, SessionBinding } from "@omp-studio/studio-protocol";
import { CommandLedger } from "./command-ledger.js";

export type RuntimeActorState = "idle" | "starting" | "running" | "stopping" | "stopped" | "crashed";

export interface RuntimeProcessPort {
  start(binding: SessionBinding): Promise<void>;
  stop(): Promise<void>;
  onExit?(listener: () => void): () => void;
}

export class StudioHostRuntimeActor {
  #state: RuntimeActorState = "idle";
  #binding: SessionBinding | undefined;
  #lastBinding: SessionBinding | undefined;
  readonly #unsubscribeExit: (() => void) | undefined;

  constructor(
    private readonly processPort: RuntimeProcessPort,
    private readonly ledger: CommandLedger,
  ) {
    this.#unsubscribeExit = processPort.onExit?.(() => this.#processExited());
  }

  get state(): RuntimeActorState {
    return this.#state;
  }

  get binding(): SessionBinding | undefined {
    return this.#binding === undefined ? undefined : structuredClone(this.#binding);
  }

  async start(binding: SessionBinding): Promise<void> {
    if (this.#state === "starting" || this.#state === "running" || this.#state === "stopping") {
      throw new Error("A runtime owner is already active");
    }
    this.#state = "starting";
    try {
      await this.processPort.start(binding);
      this.#binding = structuredClone(binding);
      this.#lastBinding = structuredClone(binding);
      this.#state = "running";
    } catch (error) {
      this.#state = "crashed";
      throw error;
    }
  }

  /** Relaunches only after the old owner has stopped/exited, preserving version and advancing the epoch. */
  async relaunch(): Promise<SessionBinding> {
    if (this.#state !== "crashed" && this.#state !== "stopped") {
      throw new Error("Runtime relaunch requires a stopped or crashed owner");
    }
    const previous = this.#lastBinding;
    if (previous === undefined) throw new Error("No previous Runtime binding is available for relaunch");
    const nextEpoch = Number(previous.runtimeEpoch) + 1;
    if (!Number.isSafeInteger(nextEpoch)) throw new Error("Runtime epoch cannot be advanced safely");
    const next = { ...structuredClone(previous), runtimeEpoch: nextEpoch as RuntimeEpoch };
    await this.start(next);
    return structuredClone(next);
  }

  async stop(): Promise<void> {
    if (this.#state !== "running") return;
    this.#state = "stopping";
    try {
      await this.processPort.stop();
      this.#state = "stopped";
      this.#binding = undefined;
    } catch (error) {
      if (this.#state === "stopping") this.#state = "running";
      throw error;
    }
  }

  runtimeLost(runtimeId: RuntimeId, runtimeEpoch: RuntimeEpoch): void {
    const active = this.#binding;
    if (active === undefined || active.runtimeId !== runtimeId || active.runtimeEpoch !== runtimeEpoch) return;
    this.ledger.markRuntimeLost(runtimeId, runtimeEpoch);
    this.#state = "crashed";
    this.#binding = undefined;
  }

  dispose(): void {
    this.#unsubscribeExit?.();
  }

  #processExited(): void {
    const active = this.#binding;
    if (active === undefined || this.#state === "stopped" || this.#state === "crashed") return;
    if (this.#state === "stopping") {
      this.#state = "stopped";
      this.#binding = undefined;
      return;
    }
    this.runtimeLost(active.runtimeId, active.runtimeEpoch);
  }
}
