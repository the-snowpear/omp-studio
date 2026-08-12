import type { RuntimeProcessHandle } from "./handles.js";

/**
 * Platform-owned runtime process containment boundary.
 *
 * The conceptual containment contract lives here, transport- and OS-neutral:
 * a platform implementation maps an opaque {@link RuntimeProcessHandle} to its
 * native process reference. The Renderer never receives a
 * {@link RuntimeProcessHandle} or any of its contents.
 */
export interface RuntimeContainmentPort {
  /**
   * Take the process identified by `handle` under containment so that
   * subsequent control calls apply to it. Resolves once tracking is
   * established.
   */
  attach(handle: RuntimeProcessHandle): Promise<void>;

  /**
   * Ask the process to stop gracefully. Resolves when the request has been
   * issued, not when the process has actually exited.
   */
  requestStop(handle: RuntimeProcessHandle): Promise<void>;

  /** Terminate the process unconditionally. */
  forceStop(handle: RuntimeProcessHandle): Promise<void>;

  /**
   * Stop managing the process. The process may keep running; control calls
   * on a released handle are rejected by the implementation.
   */
  release(handle: RuntimeProcessHandle): Promise<void>;
}
