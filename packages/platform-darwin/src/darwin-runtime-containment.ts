import type { RuntimeContainmentPort, RuntimeProcessHandle } from "@omp-studio/platform";
import {
  assertNonEmptyString,
  assertDarwinProcessController,
  type DarwinProcessController,
} from "./darwin-services.js";

/**
 * macOS containment port for runtime processes (P0).
 *
 * Maps opaque {@link RuntimeProcessHandle} values to the injected native
 * controller calls. Tracking state lives here so that controlling an unknown
 * or already-released handle is rejected before it reaches the native side.
 */
export class DarwinRuntimeContainment implements RuntimeContainmentPort {
  readonly #controller: DarwinProcessController;
  readonly #tracked = new Set<RuntimeProcessHandle>();

  constructor(controller: DarwinProcessController) {
    assertDarwinProcessController(controller);
    this.#controller = controller;
  }

  async attach(handle: RuntimeProcessHandle): Promise<void> {
    assertNonEmptyString(handle, "RuntimeProcessHandle");
    await this.#controller.attachProcess(handle);
    this.#tracked.add(handle);
  }

  async requestStop(handle: RuntimeProcessHandle): Promise<void> {
    this.#requireTracked(handle);
    await this.#controller.requestProcessStop(handle);
  }

  async forceStop(handle: RuntimeProcessHandle): Promise<void> {
    this.#requireTracked(handle);
    await this.#controller.forceProcessStop(handle);
  }

  async release(handle: RuntimeProcessHandle): Promise<void> {
    this.#requireTracked(handle);
    await this.#controller.releaseProcess(handle);
    this.#tracked.delete(handle);
  }

  #requireTracked(handle: RuntimeProcessHandle): void {
    assertNonEmptyString(handle, "RuntimeProcessHandle");
    if (!this.#tracked.has(handle)) {
      throw new TypeError("Runtime process handle is not under containment");
    }
  }
}
