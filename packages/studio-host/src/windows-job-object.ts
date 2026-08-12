import type { ChildProcess } from "node:child_process";
import type { RuntimeContainmentPort } from "./runtime-process-port.js";

export interface WindowsJobObjectApi<THandle = unknown> {
  createKillOnClose(): Promise<THandle> | THandle;
  assign(handle: THandle, processId: number): Promise<void> | void;
  terminate(handle: THandle): Promise<void> | void;
  close(handle: THandle): Promise<void> | void;
}

/** Testable Win32 Job Object lifecycle adapter; the native provider stays composition-owned. */
export class WindowsJobObjectContainment<THandle = unknown> implements RuntimeContainmentPort {
  readonly #handles = new WeakMap<ChildProcess, THandle>();

  constructor(private readonly api: WindowsJobObjectApi<THandle>) {}

  async attach(process: ChildProcess): Promise<void> {
    if (process.pid === undefined) throw new Error("Cannot assign an unspawned Runtime process to a Job Object");
    const handle = await this.api.createKillOnClose();
    try {
      await this.api.assign(handle, process.pid);
      this.#handles.set(process, handle);
    } catch (error) {
      await this.api.close(handle);
      throw error;
    }
  }

  requestStop(process: ChildProcess): void {
    process.kill();
  }

  async forceStop(process: ChildProcess): Promise<void> {
    const handle = this.#handles.get(process);
    if (handle === undefined) {
      process.kill("SIGKILL");
      return;
    }
    await this.api.terminate(handle);
  }

  async release(process: ChildProcess): Promise<void> {
    const handle = this.#handles.get(process);
    if (handle === undefined) return;
    this.#handles.delete(process);
    await this.api.close(handle);
  }
}
