import {
  privateEndpoint,
  type PlatformPort,
  type PrivateEndpoint,
  type ResourceHandle,
} from "@omp-studio/platform";
import { Win32RuntimeContainment } from "./win32-runtime-containment.js";
import {
  assertNonEmptyString,
  assertWin32PlatformServices,
  type Win32PlatformServices,
} from "./win32-services.js";

/**
 * The managed Runtime CLI on Windows (see the runtime-installer artifact
 * layout). Concrete Windows literals are allowed here and nowhere else in
 * the shared tree.
 */
const RUNTIME_EXECUTABLE_NAME = "omp.exe";

/** Absolute Windows paths: drive-letter (`C:\…`, `C:/…`) or UNC (`\\server\share`). */
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

/** URL scheme prefix per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) followed by ":". */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

/**
 * Schemes the external handler may receive. `mailto:` is allowed because the
 * product UI links support/feedback through the OS mail handler. Anything
 * else — notably `file:`, `javascript:`, `data:`, and `vbscript:` — is
 * rejected before delegation.
 */
const ALLOWED_EXTERNAL_SCHEMES: readonly string[] = ["http:", "https:", "mailto:"];

/**
 * P0 Windows implementation of {@link PlatformPort}.
 *
 * All native behavior is injected through {@link Win32PlatformServices} and
 * owned by the composition root, so this class performs pure delegation plus
 * boundary validation and never touches the OS directly.
 */
export class Win32PlatformPort implements PlatformPort {
  readonly platform = "win32" as const;

  readonly #services: Win32PlatformServices;

  constructor(services: Win32PlatformServices) {
    assertWin32PlatformServices(services);
    this.#services = services;
  }

  async appDataDirectory(): Promise<string> {
    const directory = await this.#services.appDataDirectory();
    assertAppDataDirectory(directory);
    return directory;
  }

  runtimeExecutableName(): string {
    return RUNTIME_EXECUTABLE_NAME;
  }

  async createPrivateEndpoint(profileDirectory: string): Promise<PrivateEndpoint> {
    assertNonEmptyString(profileDirectory, "profileDirectory");
    const authority = await this.#services.createCurrentUserOnlyEndpoint(profileDirectory);
    return privateEndpoint("named-pipe", authority);
  }

  createProcessContainment(): Win32RuntimeContainment {
    return new Win32RuntimeContainment(this.#services);
  }

  async revealPath(handle: ResourceHandle): Promise<void> {
    assertNonEmptyString(handle, "ResourceHandle");
    await this.#services.revealInExplorer(handle);
  }

  async openExternal(url: string): Promise<void> {
    const scheme = externalSchemeOf(url);
    if (scheme === null || !ALLOWED_EXTERNAL_SCHEMES.includes(scheme)) {
      throw new TypeError(
        `Refusing to open external URL: ${scheme === null ? "missing scheme" : `disallowed scheme "${scheme}"`}`,
      );
    }
    await this.#services.openExternal(url);
  }
}

function assertAppDataDirectory(directory: string): void {
  assertNonEmptyString(directory, "App data directory");
  if (!WINDOWS_ABSOLUTE_PATH.test(directory)) {
    throw new TypeError("App data directory must be an absolute Windows path");
  }
}

function externalSchemeOf(url: string): string | null {
  const match = URL_SCHEME.exec(url);
  if (match === null) {
    return null;
  }
  return match[0]!.toLowerCase();
}
