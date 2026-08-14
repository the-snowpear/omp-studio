import { privateEndpoint, type PrivateEndpoint } from "@omp-studio/platform";
import { assertNonEmptyString } from "./darwin-services.js";

/**
 * Minimum entropy (in bits) required of a generated endpoint authority.
 *
 * 128 bits is the floor for an unpredictable socket identity: anything weaker
 * could be guessed or brute-forced by another local process. The entropy of
 * an opaque string is estimated from the characters actually observed
 * (`length × log₂(alphabet size)`), which is a lower bound on the entropy
 * the generator produced.
 */
const MIN_AUTHORITY_ENTROPY_BITS = 128;

/**
 * Bounded collision-retry budget for exclusive reservation. If the registry
 * reports a collision this many times in a row, creation fails closed
 * instead of looping forever.
 */
const MAX_RESERVATION_ATTEMPTS = 5;

/**
 * Injected native macOS endpoint operations backing
 * {@link DarwinPrivateEndpoint}.
 *
 * Every operation is provided by the composition root (for example, the
 * desktop host), keeping this package free of `node:child_process`, admin
 * commands, and OS probes: the cryptographically random authority generator,
 * the exclusive reservation registry, and the owner-only permission
 * application are all native-side concerns. The authority is an opaque string
 * whose meaning (socket path, registry key, …) is known only to the injected
 * registry; no literal socket path, uid, token, or permission representation
 * ever appears in a client contract or error message here.
 *
 * Service methods may be synchronous or asynchronous.
 */
export interface DarwinEndpointProviders {
  /**
   * Generates an unpredictable opaque endpoint authority with at least 128
   * bits of entropy. Must be backed by a cryptographically secure random
   * source; callers of the seam re-check the entropy floor defensively.
   */
  generateEndpointAuthority(): Promise<string> | string;

  /**
   * Reserves the endpoint identified by `authority` for `profileDirectory`
   * exclusively.
   *
   * Returns `true` when the reservation was taken by this call. Returns
   * `false` when the authority is already reserved (a collision); the seam
   * then retries with a fresh authority, bounded by
   * {@link MAX_RESERVATION_ATTEMPTS}. Any other failure throws and aborts
   * creation.
   */
  reserveEndpoint(authority: string, profileDirectory: string): Promise<boolean> | boolean;

  /**
   * Applies owner-only permissions (0700) to the reserved endpoint. Called
   * after a successful reservation and before the endpoint is returned, so
   * the endpoint is never observable while owner-only protection is missing.
   */
  applyOwnerOnlyPermissions(authority: string): Promise<void> | void;

  /** Releases a reservation so the authority can be reused or cleaned up. */
  releaseEndpoint(authority: string): Promise<void> | void;
}

const ENDPOINT_PROVIDER_METHODS = [
  "generateEndpointAuthority",
  "reserveEndpoint",
  "applyOwnerOnlyPermissions",
  "releaseEndpoint",
] as const;

/** @internal Boundary validation: the providers object must provide every native method. */
export function assertDarwinEndpointProviders(providers: DarwinEndpointProviders): void {
  for (const method of ENDPOINT_PROVIDER_METHODS) {
    if (typeof providers[method] !== "function") {
      throw new TypeError(`DarwinEndpointProviders is missing required method ${method}`);
    }
  }
}

/**
 * Internal lease returned by {@link DarwinPrivateEndpoint}.
 *
 * Carries the opaque {@link PrivateEndpoint} plus a `release()` so that
 * composition can clean the reservation up. The lease is internal to
 * Host/platform composition: it never crosses {@link PlatformPort} or any
 * client-facing contract.
 */
export interface PrivateEndpointLease {
  /** The opaque, owner-only endpoint, ready for Host composition. */
  readonly endpoint: PrivateEndpoint;
  /**
   * Releases the underlying reservation. Idempotent: a second call is a
   * no-op. Provider failures propagate to the caller.
   */
  release(): Promise<void>;
}

/**
 * P1 macOS private-endpoint seam: current-user-only unix-socket endpoint
 * creation (see FRONTEND_INTEGRATION.md §7.1 and the P1 "private endpoint"
 * gate).
 *
 * The full flow is: generate an unpredictable authority (≥ 128 bits), reserve
 * it exclusively (retrying on collisions, bounded), apply owner-only
 * permissions (0700), and only then return the opaque endpoint. Any failure —
 * permission application included — releases the reservation and fails closed:
 * no endpoint is ever returned without owner-only protection, and nothing
 * client-facing ever sees a socket path, uid, token, or permission
 * representation.
 *
 * All native behavior is injected through {@link DarwinEndpointProviders} and
 * owned by the composition root, so this class performs pure orchestration
 * plus boundary validation and never touches the OS directly.
 */
export class DarwinPrivateEndpoint {
  readonly #providers: DarwinEndpointProviders;

  constructor(providers: DarwinEndpointProviders) {
    assertDarwinEndpointProviders(providers);
    this.#providers = providers;
  }

  /**
   * Creates a current-user-only endpoint scoped to `profileDirectory`.
   *
   * The returned endpoint is opaque: its authority is meaningful only to the
   * injected registry, and the caller must not parse or persist it.
   */
  async createCurrentUserOnly(profileDirectory: string): Promise<PrivateEndpointLease> {
    assertNonEmptyString(profileDirectory, "profileDirectory");

    for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
      const authority = await this.#providers.generateEndpointAuthority();
      assertSufficientEntropy(authority);

      const reserved = await this.#providers.reserveEndpoint(authority, profileDirectory);
      if (!reserved) {
        // Collision with an already-reserved authority: retry with a fresh one.
        continue;
      }

      try {
        await this.#providers.applyOwnerOnlyPermissions(authority);
      } catch (error) {
        // The endpoint must never be left reserved but unprotected.
        await releaseBestEffort(this.#providers, authority);
        throw error;
      }

      let released = false;
      return {
        endpoint: privateEndpoint("unix-socket", authority),
        release: async (): Promise<void> => {
          if (released) {
            return;
          }
          released = true;
          await this.#providers.releaseEndpoint(authority);
        },
      };
    }

    throw new Error("Failed to reserve a private endpoint after repeated collisions");
  }
}

function assertSufficientEntropy(authority: string): void {
  if (typeof authority !== "string" || authority.length === 0) {
    throw new TypeError("Endpoint authority must be a non-empty string");
  }
  const alphabetSize = new Set(authority).size;
  const entropyBits = authority.length * Math.log2(alphabetSize);
  if (entropyBits < MIN_AUTHORITY_ENTROPY_BITS) {
    // Deliberately no authority value in the message: it must never reach a log or contract.
    throw new TypeError(`Endpoint authority entropy must be at least ${MIN_AUTHORITY_ENTROPY_BITS} bits`);
  }
}

/**
 * Best-effort reservation cleanup after a failed permission application. The
 * original permission failure is the error that propagates; a cleanup failure
 * must not mask it (the reservation registry can report the leak separately).
 */
async function releaseBestEffort(providers: DarwinEndpointProviders, authority: string): Promise<void> {
  try {
    await providers.releaseEndpoint(authority);
  } catch {
    // Ignored: cleanup is best-effort and must not mask the original failure.
  }
}
