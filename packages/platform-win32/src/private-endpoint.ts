import { privateEndpoint, type PrivateEndpoint } from "@omp-studio/platform";
import { assertNonEmptyString } from "./win32-services.js";

/**
 * Minimum entropy (in bits) required of a generated endpoint authority.
 *
 * 128 bits is the floor for an unpredictable pipe identity: anything weaker
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
 * Shape of a well-formed Windows SID: `S-<revision>-<authority>-<subauth…>`
 * with at least one subauthority (for example `S-1-5-18` or a current-user
 * `S-1-5-21-…-<rid>`). Digits and hyphens only, so the value can never carry
 * separators or formatting that could break downstream consumers.
 */
const WINDOWS_SID_PATTERN = /^S-\d+-\d+(?:-\d+)+$/iu;

/**
 * Injected native Windows endpoint operations backing
 * {@link Win32PrivateEndpoint}.
 *
 * Every operation is provided by the composition root (for example, the
 * desktop host), keeping this package free of `node:child_process`, admin
 * commands, and OS probes: the SID lookup, the cryptographically random
 * authority generator, the exclusive reservation registry, and the
 * owner-only ACL application are all native-side concerns. The authority is
 * an opaque string whose meaning (pipe name, registry key, …) is known only
 * to the injected registry; no literal pipe path, SID, token, or ACL
 * representation ever appears in a client contract or error message here.
 *
 * Service methods may be synchronous or asynchronous.
 */
export interface Win32EndpointProviders {
  /** Resolves the current user's security identifier (for example `S-1-5-21-…-1001`). */
  currentUserSid(): Promise<string> | string;

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
   * Applies an owner-only ACL (granting only `sid`) to the reserved
   * endpoint. Called after a successful reservation and before the endpoint
   * is returned, so the endpoint is never observable while owner-only
   * protection is missing.
   */
  applyOwnerOnlyAcl(authority: string, sid: string): Promise<void> | void;

  /** Releases a reservation so the authority can be reused or cleaned up. */
  releaseEndpoint(authority: string): Promise<void> | void;
}

const ENDPOINT_PROVIDER_METHODS = [
  "currentUserSid",
  "generateEndpointAuthority",
  "reserveEndpoint",
  "applyOwnerOnlyAcl",
  "releaseEndpoint",
] as const;

/** @internal Boundary validation: the providers object must provide every native method. */
export function assertWin32EndpointProviders(providers: Win32EndpointProviders): void {
  for (const method of ENDPOINT_PROVIDER_METHODS) {
    if (typeof providers[method] !== "function") {
      throw new TypeError(`Win32EndpointProviders is missing required method ${method}`);
    }
  }
}

/**
 * Internal lease returned by {@link Win32PrivateEndpoint}.
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
 * P1 Windows private-endpoint seam: current-user-only named-pipe endpoint
 * creation (see FRONTEND_INTEGRATION.md §7.1 and the P1 "private endpoint"
 * gate).
 *
 * The full flow is: resolve the current-user SID, generate an unpredictable
 * authority (≥ 128 bits), reserve it exclusively (retrying on collisions,
 * bounded), apply an owner-only ACL, and only then return the opaque
 * endpoint. Any failure — ACL application included — releases the
 * reservation and fails closed: no endpoint is ever returned without
 * owner-only protection, and nothing client-facing ever sees a pipe path,
 * SID, token, or ACL representation.
 *
 * All native behavior is injected through {@link Win32EndpointProviders} and
 * owned by the composition root, so this class performs pure orchestration
 * plus boundary validation and never touches the OS directly.
 */
export class Win32PrivateEndpoint {
  readonly #providers: Win32EndpointProviders;

  constructor(providers: Win32EndpointProviders) {
    assertWin32EndpointProviders(providers);
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
    const sid = await this.#providers.currentUserSid();
    assertValidSid(sid);

    for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
      const authority = await this.#providers.generateEndpointAuthority();
      assertSufficientEntropy(authority);

      const reserved = await this.#providers.reserveEndpoint(authority, profileDirectory);
      if (!reserved) {
        // Collision with an already-reserved authority: retry with a fresh one.
        continue;
      }

      try {
        await this.#providers.applyOwnerOnlyAcl(authority, sid);
      } catch (error) {
        // The endpoint must never be left reserved but unprotected.
        await releaseBestEffort(this.#providers, authority);
        throw error;
      }

      let released = false;
      return {
        endpoint: privateEndpoint("named-pipe", authority),
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

function assertValidSid(sid: string): void {
  if (typeof sid !== "string" || !WINDOWS_SID_PATTERN.test(sid)) {
    // Deliberately no SID value in the message: it must never reach a log or contract.
    throw new TypeError("Current-user SID must be a well-formed Windows SID");
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
 * Best-effort reservation cleanup after a failed ACL application. The
 * original ACL failure is the error that propagates; a cleanup failure must
 * not mask it (the reservation registry can report the leak separately).
 */
async function releaseBestEffort(providers: Win32EndpointProviders, authority: string): Promise<void> {
  try {
    await providers.releaseEndpoint(authority);
  } catch {
    // Ignored: cleanup is best-effort and must not mask the original failure.
  }
}
