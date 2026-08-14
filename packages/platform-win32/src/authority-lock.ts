import { assertNonEmptyString } from "./win32-services.js";

/**
 * P1 single-instance/Host authority lock for Windows
 * (see FRONTEND_INTEGRATION.md §9.2 startup order).
 *
 * The lock is a per-profile, exclusive-create metadata file. Acquisition is
 * profile/environment scoped: only one live owner may hold the lock for a
 * profile, and a second owner fails with {@link AuthorityAlreadyOwnedError}
 * unless the recorded owner is provably dead (explicit liveness proof via the
 * injected seam) and the stale lock was atomically removed.
 *
 * All native behavior (exclusive create, read, atomic compare-and-remove,
 * owner liveness, clock, randomness) is injected through
 * {@link Win32AuthorityLockServices}; this class never shells out, never
 * requires elevation, and never exposes a process PID, an executable path, a
 * Named Pipe name, or a Renderer-facing type. Metadata is strict and bounded:
 * corrupt or oversized content fails closed and is never blindly deleted.
 */

/** Bounded number of create attempts per {@link Win32AuthorityLock.acquire} call. */
export const AUTHORITY_LOCK_MAX_ACQUIRE_RETRIES = 3;

/**
 * Upper bound (UTF-8 bytes) for the lock metadata file. The legitimate payload
 * is a few hundred bytes; anything larger fails closed as corrupt.
 */
export const AUTHORITY_LOCK_METADATA_MAX_BYTES = 4096;

/** Lock file name placed inside the profile directory. Internal; never exposed. */
const LOCK_FILE_NAME = "omp-studio-authority.lock.json";

/** Exact fields of a valid lock metadata record. */
const METADATA_FIELDS = ["environmentKey", "ownerNonce", "createdAt"] as const;

/**
 * Metadata persisted in the authority lock file.
 *
 * Contains no PID, no executable path, no endpoint identity, and no token.
 * The owner nonce is an opaque release proof; the environment key records
 * which environment claimed the profile lock.
 */
export interface AuthorityLockMetadata {
  /** Profile/environment scope the owner acquired the lock for. */
  readonly environmentKey: string;
  /** Opaque nonce proving release ownership; never a PID or a token. */
  readonly ownerNonce: string;
  /** ISO-8601 creation timestamp produced by the injected clock. */
  readonly createdAt: string;
}

/**
 * The lease returned by {@link Win32AuthorityLock.acquire}.
 *
 * Safe to hold and pass inside Host/platform composition only: it carries
 * opaque authority identity, generation epoch, and release nonce. These
 * values must never reach a client-visible contract, and the nonce must
 * never be persisted outside the lock metadata.
 */
export interface AuthorityLease {
  /** Opaque identity of this authority generation (fresh on every acquire). */
  readonly authorityId: string;
  /** Opaque generation marker; a re-acquired lock always gets a fresh epoch. */
  readonly epoch: string;
  /** Opaque release proof; matches the lock metadata's ownerNonce. */
  readonly nonce: string;
  /**
   * Releases the lock. Idempotent: calling release again (or releasing an
   * already-superseded lease) is a no-op. Only ever removes the lock through
   * an atomic compare-and-remove of this lease's exact metadata; foreign or
   * corrupted content is never deleted.
   */
  release(): Promise<void>;
}

/**
 * Injected filesystem seam backing the authority lock.
 *
 * `createExclusive` and `compareAndRemove` MUST be atomic: they are the
 * contract that makes concurrent acquisitions mutually exclusive. No real
 * path is ever exposed by this package — paths are only passed back to these
 * methods.
 */
export interface Win32AuthorityLockFilesystem {
  /**
   * Atomically create `lockFilePath` with `content` only if it does not
   * exist. Resolves `true` only when this call created the file and its
   * content is exactly `content`; resolves `false` when the file already
   * exists (content untouched). Real errors must reject, never resolve false.
   */
  createExclusive(lockFilePath: string, content: string): Promise<boolean> | boolean;

  /**
   * Reads the full content of `lockFilePath`. Resolves `null` when the file
   * does not exist. Real errors (permissions, IO) must reject.
   */
  read(lockFilePath: string): Promise<string | null> | string | null;

  /**
   * Atomically removes `lockFilePath` ONLY if its current content equals
   * `expectedContent`. Resolves `true` when the file was removed, `false`
   * when the content differs (or the file is gone). Real errors must reject,
   * never resolve false.
   */
  compareAndRemove(lockFilePath: string, expectedContent: string): Promise<boolean> | boolean;
}

/** Injected owner-liveness seam. */
export interface Win32AuthorityLockLiveness {
  /**
   * Resolves `true` only when the owner recorded in `metadata` is verifiably
   * alive. This is the exclusive dead-proof required before any stale
   * takeover: a lock is never removed unless this resolves `false`. Real
   * errors must reject (fail closed — no proof means no takeover).
   */
  isOwnerAlive(metadata: AuthorityLockMetadata): Promise<boolean> | boolean;
}

/** Injected monotonic wall clock for lock metadata timestamps. */
export interface Win32AuthorityLockClock {
  /** Returns the current time as an ISO-8601 timestamp (parseable by `Date.parse`). */
  nowIso(): string;
}

/** Injected source of opaque random identifiers. */
export interface Win32AuthorityLockRandom {
  /** Returns a fresh opaque identifier (non-empty). */
  randomId(): string;
}

/**
 * Everything the authority lock needs from the native/composition side.
 * Provided by the composition root, keeping this package free of
 * `node:child_process`, admin commands, and OS probes — tests substitute
 * fakes with no privileges.
 */
export interface Win32AuthorityLockServices
  extends Win32AuthorityLockFilesystem,
    Win32AuthorityLockLiveness,
    Win32AuthorityLockClock,
    Win32AuthorityLockRandom {}

/** Constructor options for {@link Win32AuthorityLock}. */
export interface Win32AuthorityLockOptions {
  /** Current user's profile/state directory that owns this lock. */
  readonly profileDirectory: string;
  /** Environment scope recorded in the lock metadata (for example, "desktop"). */
  readonly environmentKey: string;
  /** Injected native services. */
  readonly services: Win32AuthorityLockServices;
}

/** Base error for every authority lock failure. */
export class AuthorityLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthorityLockError";
  }
}

/**
 * The profile lock is held by a live owner. No second owner may start
 * (FRONTEND_INTEGRATION.md §9.2: "已有 Host authority：连接现有 authority 或
 * 明确失败，不能启动第二个 owner").
 */
export class AuthorityAlreadyOwnedError extends AuthorityLockError {
  /** Environment scope recorded by the live owner. */
  readonly environmentKey: string;
  /** Creation timestamp recorded by the live owner. */
  readonly createdAt: string;

  constructor(environmentKey: string, createdAt: string) {
    super(
      `authority lock is already held by a live owner (environmentKey: ${environmentKey}, createdAt: ${createdAt})`,
    );
    this.name = "AuthorityAlreadyOwnedError";
    this.environmentKey = environmentKey;
    this.createdAt = createdAt;
  }
}

/**
 * The lock metadata failed strict validation or exceeded the size bound.
 * Fails closed: the file is never blindly deleted.
 */
export class AuthorityLockCorruptError extends AuthorityLockError {
  constructor(detail: string) {
    super(`authority lock metadata is corrupt (${detail}); failing closed without deleting it`);
    this.name = "AuthorityLockCorruptError";
  }
}

/** Acquisition raced or took over a stale lock more times than the bounded retries allow. */
export class AuthorityLockContentionError extends AuthorityLockError {
  constructor(attempts: number) {
    super(`authority lock could not be acquired after ${attempts} attempts`);
    this.name = "AuthorityLockContentionError";
  }
}

const AUTHORITY_LOCK_SERVICE_METHODS = [
  "createExclusive",
  "read",
  "compareAndRemove",
  "isOwnerAlive",
  "nowIso",
  "randomId",
] as const;

/** @internal Boundary validation: the services object must provide every injected method. */
export function assertWin32AuthorityLockServices(services: Win32AuthorityLockServices): void {
  for (const method of AUTHORITY_LOCK_SERVICE_METHODS) {
    if (typeof services[method] !== "function") {
      throw new TypeError(`Win32AuthorityLockServices is missing required method ${method}`);
    }
  }
}

/** In-memory record of the lease this instance currently holds. */
interface ActiveLease {
  readonly lease: AuthorityLease;
  readonly metadata: AuthorityLockMetadata;
  /** Exact serialized metadata written to the lock file (release proof). */
  readonly payload: string;
}

/**
 * P1 Windows implementation of the single-instance/Host authority lock.
 *
 * One instance manages one profile lock. Concurrency safety is by contract:
 * only the injected atomic `createExclusive` can create the lock, so two
 * concurrent acquisitions can never both succeed — the loser observes the
 * winner's metadata and either fails as already-owned or (with explicit dead
 * proof) takes the stale lock over through atomic compare-and-remove.
 */
export class Win32AuthorityLock {
  readonly #services: Win32AuthorityLockServices;
  readonly #lockPath: string;
  readonly #environmentKey: string;
  #active: ActiveLease | null = null;

  constructor(options: Win32AuthorityLockOptions) {
    assertNonEmptyString(options.profileDirectory, "profileDirectory");
    assertNonEmptyString(options.environmentKey, "environmentKey");
    assertWin32AuthorityLockServices(options.services);
    this.#services = options.services;
    this.#environmentKey = options.environmentKey;
    this.#lockPath = `${options.profileDirectory.replace(/[\\/]+$/u, "")}\\${LOCK_FILE_NAME}`;
  }

  /**
   * Acquires the profile authority lock and returns an {@link AuthorityLease}.
   *
   * Fails with {@link AuthorityAlreadyOwnedError} when a live owner holds the
   * lock, {@link AuthorityLockCorruptError} when the existing metadata is
   * invalid or oversized (never deleted), and
   * {@link AuthorityLockContentionError} when bounded retries are exhausted.
   */
  async acquire(): Promise<AuthorityLease> {
    const active = this.#active;
    if (active !== null) {
      throw new AuthorityAlreadyOwnedError(active.metadata.environmentKey, active.metadata.createdAt);
    }

    const environmentKey = this.#environmentKey;
    const ownerNonce = this.#randomId("owner nonce");
    const authorityId = this.#randomId("authority id");
    const epoch = this.#randomId("authority epoch");
    const createdAt = this.#clockNow();
    const metadata: AuthorityLockMetadata = { environmentKey, ownerNonce, createdAt };
    const payload = JSON.stringify(metadata);

    for (let attempt = 1; attempt <= AUTHORITY_LOCK_MAX_ACQUIRE_RETRIES; attempt += 1) {
      if (await this.#createExclusive(payload)) {
        let lease: AuthorityLease;
        lease = Object.freeze({
          authorityId,
          epoch,
          nonce: ownerNonce,
          release: () => this.#release(lease),
        });
        this.#active = { lease, metadata, payload };
        return lease;
      }

      // The lock exists. Inspect it strictly; corrupt or oversized metadata
      // fails closed here and is never deleted.
      const existing = await this.#readExisting();
      if (existing === null || existing === "") {
        // Vanished (or a concurrent create is mid-write): retry the create.
        continue;
      }
      if (Buffer.byteLength(existing, "utf8") > AUTHORITY_LOCK_METADATA_MAX_BYTES) {
        throw new AuthorityLockCorruptError(
          `metadata exceeds the ${AUTHORITY_LOCK_METADATA_MAX_BYTES}-byte bound`,
        );
      }
      const existingMetadata = parseLockMetadata(existing);

      if (await this.#isOwnerAlive(existingMetadata)) {
        throw new AuthorityAlreadyOwnedError(existingMetadata.environmentKey, existingMetadata.createdAt);
      }

      // Explicit dead proof received: remove ONLY the exact content we read
      // (atomic compare-and-remove). Losing the race just retries.
      if (!(await this.#compareAndRemove(existing))) {
        continue;
      }
    }

    throw new AuthorityLockContentionError(AUTHORITY_LOCK_MAX_ACQUIRE_RETRIES);
  }

  /**
   * Releases the lock behind `lease`. Idempotent: repeating the call, or
   * releasing a lease that was superseded by a newer acquire, is a no-op.
   * Removal only ever happens through an atomic compare-and-remove of this
   * lease's exact metadata; when the content no longer matches (the lock was
   * taken over or corrupted), nothing is deleted and the lease is considered
   * released.
   */
  async #release(lease: AuthorityLease): Promise<void> {
    const active = this.#active;
    if (active === null || active.lease !== lease) {
      return;
    }
    try {
      await this.#services.compareAndRemove(this.#lockPath, active.payload);
    } catch (cause) {
      throw new AuthorityLockError("authority lock release failed; the lease remains held", { cause });
    }
    this.#active = null;
  }

  async #createExclusive(payload: string): Promise<boolean> {
    try {
      return await this.#services.createExclusive(this.#lockPath, payload);
    } catch (cause) {
      throw new AuthorityLockError("authority lock could not be created", { cause });
    }
  }

  async #readExisting(): Promise<string | null> {
    try {
      return await this.#services.read(this.#lockPath);
    } catch (cause) {
      throw new AuthorityLockError("authority lock could not be read", { cause });
    }
  }

  async #compareAndRemove(expectedContent: string): Promise<boolean> {
    try {
      return await this.#services.compareAndRemove(this.#lockPath, expectedContent);
    } catch (cause) {
      throw new AuthorityLockError("authority lock could not be removed for stale takeover", { cause });
    }
  }

  async #isOwnerAlive(metadata: AuthorityLockMetadata): Promise<boolean> {
    try {
      return await this.#services.isOwnerAlive(metadata);
    } catch (cause) {
      throw new AuthorityLockError(
        "authority lock owner liveness could not be determined; failing closed",
        { cause },
      );
    }
  }

  #randomId(label: string): string {
    const value = this.#services.randomId();
    assertNonEmptyString(value, `authority lock ${label}`);
    return value;
  }

  #clockNow(): string {
    const value = this.#services.nowIso();
    assertNonEmptyString(value, "authority lock clock");
    if (!Number.isFinite(Date.parse(value))) {
      throw new TypeError("authority lock clock must return an ISO-8601 timestamp");
    }
    return value;
  }
}

/**
 * Strictly validates lock metadata read from disk. Any structural deviation
 * (non-object, missing or extra fields, wrong types, empty or unparseable
 * values) throws {@link AuthorityLockCorruptError} — the caller fails closed
 * and never deletes the file.
 */
function parseLockMetadata(raw: string): AuthorityLockMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthorityLockCorruptError("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AuthorityLockCorruptError("not a metadata object");
  }
  const record = parsed as Record<string, unknown>;
  for (const field of METADATA_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      throw new AuthorityLockCorruptError(`missing field ${field}`);
    }
  }
  if (Object.keys(record).length !== METADATA_FIELDS.length) {
    throw new AuthorityLockCorruptError("unexpected fields");
  }
  const { environmentKey, ownerNonce, createdAt } = record;
  if (typeof environmentKey !== "string" || environmentKey.length === 0) {
    throw new AuthorityLockCorruptError("environmentKey must be a non-empty string");
  }
  if (typeof ownerNonce !== "string" || ownerNonce.length === 0) {
    throw new AuthorityLockCorruptError("ownerNonce must be a non-empty string");
  }
  if (typeof createdAt !== "string" || createdAt.length === 0 || !Number.isFinite(Date.parse(createdAt))) {
    throw new AuthorityLockCorruptError("createdAt must be a parseable ISO-8601 string");
  }
  return { environmentKey, ownerNonce, createdAt };
}
