import {
  privateEndpoint,
  type PlatformPort,
  type PrivateEndpoint,
  type ResourceHandle,
} from "@omp-studio/platform";
import { DarwinRuntimeContainment } from "./darwin-runtime-containment.js";
import {
  assertNonEmptyString,
  assertDarwinPlatformServices,
  type DarwinPlatformServices,
} from "./darwin-services.js";

/**
 * The managed Runtime CLI on macOS (see the runtime-installer artifact
 * layout). Concrete macOS literals are allowed here and nowhere else in
 * the shared tree.
 */
const RUNTIME_EXECUTABLE_NAME = "omp";

/** Absolute POSIX paths: start with `/`. */
const POSIX_ABSOLUTE_PATH = /^\/[^\0]*$/u;

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
 * P0 macOS implementation of {@link PlatformPort}.
 *
 * All native behavior is injected through {@link DarwinPlatformServices} and
 * owned by the composition root, so this class performs pure delegation plus
 * boundary validation and never touches the OS directly.
 */
export class DarwinPlatformPort implements PlatformPort {
  readonly platform = "darwin" as const;

  readonly #services: DarwinPlatformServices;

  constructor(services: DarwinPlatformServices) {
    assertDarwinPlatformServices(services);
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
    return privateEndpoint("unix-socket", authority);
  }

  createProcessContainment(): DarwinRuntimeContainment {
    return new DarwinRuntimeContainment(this.#services);
  }

  async revealPath(handle: ResourceHandle): Promise<void> {
    assertNonEmptyString(handle, "ResourceHandle");
    await this.#services.revealInFinder(handle);
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
  if (!POSIX_ABSOLUTE_PATH.test(directory)) {
    throw new TypeError("App data directory must be an absolute POSIX path");
  }
}

function externalSchemeOf(url: string): string | null {
  const match = URL_SCHEME.exec(url);
  if (match === null) {
    return null;
  }
  return match[0]!.toLowerCase();
}
