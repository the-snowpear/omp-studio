import type { RuntimeProcessHandle } from "@omp-studio/platform";

/**
 * Native Windows process-control surface injected into
 * {@link Win32RuntimeContainment}.
 *
 * The native provider (Job Object, process handle table, …) is
 * composition-owned: this package only forwards opaque
 * {@link RuntimeProcessHandle} values and never touches the OS directly, so
 * tests substitute fakes without any privileges.
 */
export interface Win32ProcessController {
  /** Take the process identified by the opaque handle under containment. */
  attachProcess(handle: RuntimeProcessHandle): Promise<void> | void;

  /** Ask the contained process to stop gracefully (request issued, not awaited exit). */
  requestProcessStop(handle: RuntimeProcessHandle): Promise<void> | void;

  /** Terminate the contained process unconditionally. */
  forceProcessStop(handle: RuntimeProcessHandle): Promise<void> | void;

  /** Stop managing the process; the process may keep running. */
  releaseProcess(handle: RuntimeProcessHandle): Promise<void> | void;
}

/**
 * Injected native Windows operations backing {@link Win32PlatformPort}.
 *
 * Every method is provided by the composition root (for example, the desktop
 * host), keeping this package free of `node:child_process`, admin commands,
 * and OS probes. Service methods may be synchronous or asynchronous.
 */
export interface Win32PlatformServices extends Win32ProcessController {
  /** Resolves the current user's application data directory (an absolute Windows path). */
  appDataDirectory(): Promise<string> | string;

  /**
   * Creates a private endpoint scoped to `profileDirectory` whose access is
   * restricted to the current user (owner-only). The returned value is an
   * opaque authority: callers must not parse or persist it, and it must
   * never be exposed to clients. The exact access-control mechanism (ACL,
   * SDDL, …) is an implementation detail and is deliberately absent from
   * this contract.
   */
  createCurrentUserOnlyEndpoint(profileDirectory: string): Promise<string> | string;

  /** Reveals the filesystem resource at `path` in the platform's file manager. */
  revealInExplorer(path: string): Promise<void> | void;

  /** Opens `url` in the platform's default external handler (scheme-validated by the port). */
  openExternal(url: string): Promise<void> | void;
}

const PROCESS_CONTROLLER_METHODS = [
  "attachProcess",
  "requestProcessStop",
  "forceProcessStop",
  "releaseProcess",
] as const;

const PLATFORM_SERVICE_METHODS = [
  "appDataDirectory",
  "createCurrentUserOnlyEndpoint",
  "revealInExplorer",
  "openExternal",
  ...PROCESS_CONTROLLER_METHODS,
] as const;

/** @internal Boundary validation: a controller must provide every native method. */
export function assertWin32ProcessController(controller: Win32ProcessController): void {
  for (const method of PROCESS_CONTROLLER_METHODS) {
    if (typeof controller[method] !== "function") {
      throw new TypeError(`Win32ProcessController is missing required method ${method}`);
    }
  }
}

/** @internal Boundary validation: the services object must provide every native method. */
export function assertWin32PlatformServices(services: Win32PlatformServices): void {
  for (const method of PLATFORM_SERVICE_METHODS) {
    if (typeof services[method] !== "function") {
      throw new TypeError(`Win32PlatformServices is missing required method ${method}`);
    }
  }
}

/** @internal Shared boundary validation for opaque string arguments. */
export function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}
