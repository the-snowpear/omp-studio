import { lstat } from "node:fs/promises";

/**
 * Reusable verification evidence.
 *
 * Hashing a 170 MB Runtime executable is the single most expensive thing the
 * Host does per launch, and the same bytes were being hashed three to five
 * times per start: `resolveRuntime` fingerprints before and after the probe,
 * `RuntimeInstaller#currentManifest()` re-checks the entrypoint checksum, and
 * the periodic `usage.get` lookup goes through `currentManifest()` again every
 * 30 s.
 *
 * This cache records "these exact bytes were verified against this exact
 * assertion" and answers later lookups from cheap `lstat` metadata. It is
 * deliberately conservative:
 *
 * - The key is `(absolute path, size, mtimeMs, inode, device, assertion)`. Any
 *   change to the file's content metadata drops the record immediately - not
 *   after the TTL.
 * - `assertion` is what the caller was verifying (signed checksum + version +
 *   verification kind). A different expected digest or a different active
 *   version cannot reuse a record.
 * - A record is only trusted for `maxAgeMs` (default 10 minutes) and the cache
 *   starts empty on every process start, so the first lookup after a restart
 *   always reads the file. `fresh: true` additionally forces a read on
 *   execution boundaries (right before a Runtime process is spawned).
 * - Concurrent lookups for the same path/identity share one in-flight read
 *   (single flight).
 * - A failed verification is never recorded: the next caller reads again.
 * - `invalidate()` drops everything and also stops an in-flight read from
 *   recording evidence that began before the invalidation (install/activate/
 *   rollback/uninstall/prune).
 *
 * Security semantics stay with the caller: this module never decides that a
 * file is trusted, it only remembers that a caller's own verification passed
 * for bytes with this stat identity.
 *
 * ## Why `mtime` + `size` alone must never become permanent trust
 *
 * `lstat` metadata is attacker-writable: anyone who can replace the file can
 * also restore its size, its modification time and (by overwriting in place
 * instead of replacing) its inode. A cache that says "size and mtime match, so
 * the bytes are still the ones we verified" therefore degrades, after the first
 * successful verification, into "we never check the executable again". That is
 * exactly the property the signature chain exists to deny, so the record is
 * bounded by three independent layers - do not collapse them when simplifying
 * this file:
 *
 * 1. **Stat identity** (`size`, `mtimeMs`, `inode`, `device` + the assertion):
 *    cheap and immediate. Touching, rewriting, replacing or re-signing the file
 *    drops the record on the next lookup, before the TTL matters at all.
 * 2. **Bounded age** (`maxAgeMs`, default 10 minutes): the upper bound on the
 *    damage a stat-preserving swap can do. Expiry re-reads the bytes and the
 *    caller's own comparison decides, so the window can never be extended by
 *    accident - only by deliberately raising this constant, which is a security
 *    decision and has to be reviewed as one.
 * 3. **Process lifetime + explicit `invalidate()`**: the cache starts empty, so
 *    the first lookup after a restart always hashes; `fresh: true` forces a read
 *    at execution boundaries (before a Runtime process is spawned) even inside
 *    the window; and every mutation point (install, activate, rollback,
 *    uninstall, prune) clears the record explicitly, including reads that were
 *    already in flight - evidence that started before an installation boundary
 *    proves nothing about the bytes installed after it.
 *
 * Removing layer 1 makes a legitimate reinstall or repair reuse stale evidence;
 * removing layer 2 turns "we verify the Runtime" into "we verified it once, at
 * some point in this process"; removing layer 3 keeps trusting the previous
 * version's bytes after a switch. Each layer is load-bearing.
 */

/** Cheap, non-cryptographic identity of a file's current contents. */
export interface FileStatIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly inode: number;
  readonly device: number;
}

export function fileStatIdentityKey(identity: FileStatIdentity): string {
  return `${identity.size}:${identity.mtimeMs}:${identity.inode}:${identity.device}`;
}

/**
 * `lstat` rather than `stat`: a symlink swapped in place of the executable must
 * never be recorded as verified regular-file content. The installer and resolver
 * both reject links separately; sharing the metadata read keeps one policy.
 */
export async function readFileStatIdentity(path: string): Promise<FileStatIdentity> {
  const metadata = await lstat(path);
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    // Windows reports a file index for `ino` and a volume serial for `dev`;
    // virtual filesystems may report 0, which is still a stable comparison.
    inode: Number.isFinite(metadata.ino) ? metadata.ino : 0,
    device: Number.isFinite(metadata.dev) ? metadata.dev : 0,
  };
}

export interface VerificationCacheStats {
  /** Content reads that actually ran. */
  readonly contentHashes: number;
  /** Lookups answered without reading the file again. */
  readonly cacheHits: number;
  /** Calls that joined a read already in flight instead of starting one. */
  readonly singleFlightJoins: number;
  /** File bytes not read again because a verification was reused. */
  readonly skippedBytes: number;
  /** File bytes that were actually read and hashed. */
  readonly hashedBytes: number;
  /** Recorded verifications dropped by a metadata change or `invalidate()`. */
  readonly invalidations: number;
}

/** Ten minutes is long enough to cover a launch + its periodic lookups and short enough to re-prove itself. */
export const DEFAULT_VERIFICATION_MAX_AGE_MS = 10 * 60_000;

export interface StatKeyedVerificationCacheOptions {
  /** How long a recorded verification stays usable while the stat identity is unchanged. */
  readonly maxAgeMs?: number;
  /** Injectable clock; tests expire records without waiting. */
  readonly now?: () => number;
}

export interface StatKeyedVerificationInput<T> {
  /** Absolute path of the file whose bytes were verified. */
  readonly path: string;
  /** What was verified, e.g. `file-checksums-sha256:v1:1.2.3:<digest>`. */
  readonly assertion: string;
  /** Performs the real verification; must throw when it fails. */
  readonly verify: () => Promise<T>;
  /** Execution boundary: ignore a recorded verification and read the bytes again. */
  readonly fresh?: boolean;
}

export interface StatKeyedVerificationResult<T> {
  readonly value: T;
  /** True when the file bytes were not read again. */
  readonly hit: boolean;
}

interface RecordedVerification<T> {
  readonly identity: string;
  readonly assertion: string;
  readonly verifiedAt: number;
  readonly bytes: number;
  readonly value: T;
}

interface InFlightVerification {
  readonly promise: Promise<void>;
}

export class StatKeyedVerificationCache<T> {
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #recorded = new Map<string, RecordedVerification<T>>();
  readonly #inFlight = new Map<string, InFlightVerification>();
  #generation = 0;
  #stats: {
    contentHashes: number;
    cacheHits: number;
    singleFlightJoins: number;
    skippedBytes: number;
    hashedBytes: number;
    invalidations: number;
  } = {
    contentHashes: 0,
    cacheHits: 0,
    singleFlightJoins: 0,
    skippedBytes: 0,
    hashedBytes: 0,
    invalidations: 0,
  };

  constructor(options: StatKeyedVerificationCacheOptions = {}) {
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_VERIFICATION_MAX_AGE_MS;
    this.#now = options.now ?? Date.now;
  }

  stats(): VerificationCacheStats {
    return { ...this.#stats };
  }

  /**
   * Drop every recorded verification. Installation, activation, rollback,
   * uninstall and pruning call this so a swapped or repaired Runtime can never
   * inherit evidence recorded for its previous bytes.
   */
  invalidate(): void {
    this.#generation += 1;
    this.#stats.invalidations += this.#recorded.size;
    this.#recorded.clear();
  }

  async verify(input: StatKeyedVerificationInput<T>): Promise<StatKeyedVerificationResult<T>> {
    const identity = await readFileStatIdentity(input.path);
    const identityKey = fileStatIdentityKey(identity);
    const recorded = this.#recorded.get(input.path);
    const usable =
      input.fresh !== true &&
      recorded !== undefined &&
      recorded.assertion === input.assertion &&
      recorded.identity === identityKey &&
      this.#now() - recorded.verifiedAt < this.#maxAgeMs;
    // Content metadata or the assertion changed: the evidence is worthless now,
    // so drop it rather than let it linger until the TTL elapses.
    if (recorded !== undefined && !usable) {
      this.#recorded.delete(input.path);
      this.#stats.invalidations += 1;
    }
    if (recorded !== undefined && usable) {
      this.#stats.cacheHits += 1;
      this.#stats.skippedBytes += recorded.bytes;
      return { value: recorded.value, hit: true };
    }

    const flightKey = `${input.path}\u0000${identityKey}\u0000${input.assertion}`;
    const inFlight = this.#inFlight.get(flightKey);
    if (inFlight !== undefined) {
      this.#stats.singleFlightJoins += 1;
      // A shared failure is this caller's failure too: never fall back to a
      // read that would decide "trusted" on its own after a rejection.
      await inFlight.promise;
      const joined = this.#recorded.get(input.path);
      if (joined !== undefined && joined.assertion === input.assertion && joined.identity === identityKey) {
        this.#stats.cacheHits += 1;
        this.#stats.skippedBytes += joined.bytes;
        return { value: joined.value, hit: true };
      }
      // Dropped by an `invalidate()` while the read was running: verify again.
      return await this.verify({ ...input, fresh: true });
    }

    let settleFlight: () => void = () => undefined;
    let rejectFlight: (error: unknown) => void = () => undefined;
    const promise = new Promise<void>((resolveFlight, reject) => {
      settleFlight = resolveFlight;
      rejectFlight = reject;
    });
    // Joined callers handle the rejection; this keeps an unjoined failure from
    // surfacing as an unhandled rejection.
    void promise.catch(() => undefined);
    this.#inFlight.set(flightKey, { promise });
    const generation = this.#generation;
    // A read is a read even when the verification then fails; counting it up
    // front keeps "how often did we hash this file" honest.
    this.#stats.contentHashes += 1;
    this.#stats.hashedBytes += identity.size;
    try {
      const value = await input.verify();
      // Evidence that started before an invalidation proves nothing about the
      // bytes that are installed now.
      if (this.#generation === generation) {
        this.#recorded.set(input.path, {
          identity: identityKey,
          assertion: input.assertion,
          verifiedAt: this.#now(),
          bytes: identity.size,
          value,
        });
      }
      settleFlight();
      return { value, hit: false };
    } catch (error) {
      rejectFlight(error);
      throw error;
    } finally {
      this.#inFlight.delete(flightKey);
    }
  }
}
