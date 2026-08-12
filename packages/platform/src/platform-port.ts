import { assertNonEmpty, type ResourceHandle, type Brand } from "./handles.js";
import type { RuntimeContainmentPort } from "./containment.js";

/** Host platform identifier. Only platforms implementing {@link PlatformPort} are listed. */
export type Platform = "win32" | "darwin";

/**
 * Transport family of a {@link PrivateEndpoint}.
 *
 * `"named-pipe"` and `"unix-socket"` are the production families. `"in-memory"`
 * is reserved for in-process semantic adapters and never crosses a process
 * boundary.
 */
export type EndpointKind = "named-pipe" | "unix-socket" | "in-memory";

/**
 * Opaque, platform-encoded endpoint address.
 *
 * The encoding is implementation-defined (pipe identity, socket path, or
 * in-memory registry key). No Windows pipe name or filesystem path may
 * appear in any client-visible contract.
 */
export type EndpointAuthority = Brand<string, "EndpointAuthority">;

/**
 * A private endpoint for Host/platform composition.
 *
 * Safe to hold and pass between Host and platform code: it carries only the
 * transport kind and an opaque authority, never a literal pipe name, path,
 * token, or secret.
 */
export interface PrivateEndpoint {
  /** Transport family of the endpoint. */
  readonly kind: EndpointKind;
  /** Opaque platform-encoded address. */
  readonly authority: EndpointAuthority;
}

const ENDPOINT_KINDS: readonly EndpointKind[] = ["named-pipe", "unix-socket", "in-memory"];

/**
 * Constructs a {@link PrivateEndpoint} at the package boundary.
 * Rejects unknown kinds and empty authorities.
 */
export function privateEndpoint(kind: EndpointKind, authority: string): PrivateEndpoint {
  if (!ENDPOINT_KINDS.includes(kind)) {
    throw new RangeError(`Unknown endpoint kind: ${String(kind)}`);
  }
  assertNonEmpty(authority, "PrivateEndpoint authority");
  return { kind, authority: authority as EndpointAuthority };
}

/**
 * The single abstraction over OS differences (see FRONTEND_INTEGRATION.md §7.1).
 *
 * All filesystem, process, and endpoint behavior that differs between
 * platforms is owned by implementations of this interface. Renderer, Client
 * API, and Host domain code depend only on this type and never on a concrete
 * platform.
 */
export interface PlatformPort {
  /** The platform this port implements. */
  readonly platform: Platform;

  /** Resolves the platform-specific directory for application data. */
  appDataDirectory(): Promise<string>;

  /** Returns the runtime executable's file name for this platform. */
  runtimeExecutableName(): string;

  /**
   * Creates a private endpoint scoped to the given profile directory, used
   * by Host-side composition. The returned endpoint is opaque: its address
   * is meaningful only to the creating platform implementation.
   */
  createPrivateEndpoint(profileDirectory: string): Promise<PrivateEndpoint>;

  /** Returns the containment port for controlling runtime processes. */
  createProcessContainment(): RuntimeContainmentPort;

  /** Reveals the resource behind `handle` to the user (for example, in the platform's file manager). */
  revealPath(handle: ResourceHandle): Promise<void>;

  /** Opens `url` in the platform's default external handler. */
  openExternal(url: string): Promise<void>;
}
