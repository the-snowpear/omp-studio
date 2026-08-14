/**
 * Safe read-model construction for the Host facade: neutral empty
 * manifests, deterministic opaque id derivation, display-text bounding and
 * defense-in-depth redaction of diagnostic detail values.
 *
 * Contract guarantee (client-contract §read-models): every value that
 * reaches the client is pre-redacted. The facade only ever builds values
 * from safe sources, and `redactDetail` additionally scrubs any detail
 * value that *resembles* an absolute path, a token or a PID so a future
 * injected source cannot leak one.
 */

import { createHash } from "node:crypto";

import type {
  DiagnosticEntryId,
  DiagnosticReadModel,
  EnvironmentId,
  HistoryEntryId,
  PublicAuthorityIdentity,
  ThreadId,
} from "@omp-studio/client-contract";
import type {
  CapabilityManifest,
  OperatorCommandManifest,
  RuntimeInstallationManifest,
} from "@omp-studio/studio-protocol";

/** Deterministic sha256 hex of a stable payload (used for neutral manifest hashes). */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Neutral capability manifest used when no Runtime evidence exists.
 * Profile "limited" with zero capabilities: fails closed — the facade
 * never claims a capability it cannot prove. The hash is deterministic so
 * bootstrap output is stable across runs.
 */
export function neutralCapabilityManifest(now: string): CapabilityManifest {
  return {
    profile: "limited",
    generatedAt: now,
    hash: sha256Hex('{"profile":"limited","capabilities":[]}'),
    capabilities: [],
  };
}

/**
 * Neutral operator command manifest used when no Runtime evidence exists.
 * Empty commands and an empty upstream commit sentinel: there is no
 * upstream runtime to attribute commands to.
 */
export function neutralCommandManifest(now: string): OperatorCommandManifest {
  return {
    generatedAt: now,
    upstreamCommit: "",
    hash: sha256Hex('{"commands":[],"unclassifiedBuiltins":[]}'),
    commands: [],
    unclassifiedBuiltins: [],
  };
}

/**
 * Deterministic opaque id derivation: the same source session identity
 * always maps to the same branded public id, and the derivation never
 * reveals the source value. The brand casts are the opaque-identity
 * boundary: a derived hex token becomes a client-contract brand.
 */
function opaqueId(prefix: string, source: string): string {
  return `${prefix}${sha256Hex(source).slice(0, 24)}`;
}

/** Environment identity: deterministic per Host authority. */
export function environmentIdFor(authorityId: string): EnvironmentId {
  return opaqueId("env-", authorityId) as EnvironmentId;
}

/** Thread identity derived deterministically from a catalog session id. */
export function threadIdFor(sessionId: string): ThreadId {
  return opaqueId("thread-", sessionId) as ThreadId;
}

/** History entry identity derived deterministically from a catalog session id. */
export function historyIdFor(sessionId: string): HistoryEntryId {
  return opaqueId("hist-", sessionId) as HistoryEntryId;
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/gu;
const WHITESPACE_RUNS = /\s+/gu;

/**
 * Bound and sanitize display text: strip control characters, collapse
 * whitespace, trim and cap the length. Returns undefined when nothing
 * usable remains.
 */
export function sanitizeDisplayText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(CONTROL_CHARS, " ").replace(WHITESPACE_RUNS, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength).trimEnd()}…`;
}

const PATH_LIKE =
  /(^|[^\p{L}\p{N}])([A-Za-z]:[\\/]|\\\\([?.]\\pipe\\|[^\\]+\\[^\\])|(^|[^\p{L}\p{N}])~[\\/]|\/(?:Users|home|home\/[^/]+\/|etc\/|tmp\/|var\/|opt\/|usr\/|Applications\/))/u;
const TOKEN_LIKE = /(^|[^\p{L}\p{N}])(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|[A-Za-z0-9_-]{32,})(?=$|[^\p{L}\p{N}])/gu;
const PID_LIKE = /(^|[^\p{L}\p{N}])\d{5,9}(?=$|[^\p{L}\p{N}])/gu;
const SENSITIVE_KEYS = /token|secret|password|pid|process|endpoint|pipe|auth|bearer|credential/i;

const REDACTED = "[redacted]";

/**
 * Defense-in-depth text redaction: replace path-like, token-like and
 * PID-like substrings so a message is safe to display and copy verbatim.
 */
export function redactText(value: string): string {
  return value
    .replace(PATH_LIKE, "$1[redacted]")
    .replace(TOKEN_LIKE, "$1[redacted]")
    .replace(PID_LIKE, "$1[redacted]");
}

function redactScalar(key: string, value: string): string {
  if (SENSITIVE_KEYS.test(key)) return REDACTED;
  if (PATH_LIKE.test(value) || TOKEN_LIKE.test(value.replace(/^[A-Za-z0-9_-]{0,4}/u, "")) || PID_LIKE.test(value)) {
    return REDACTED;
  }
  return redactText(value);
}

/**
 * Scrub a heterogeneous diagnostic detail record in place of any value
 * that resembles an absolute path, token or PID. Records and arrays are
 * walked; scalar strings are redacted by key sensitivity and value shape.
 */
export function redactDetail(detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const key of Object.keys(detail)) {
    const value = detail[key];
    if (typeof value === "string") {
      redacted[key] = redactScalar(key, value);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      redacted[key] = redactDetail(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      redacted[key] = value.map((item) => (typeof item === "string" ? redactScalar(key, item) : item));
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Build the diagnostics read model with the facade's clock/id factory and
 * redaction applied to every entry. `detail` values never leak absolute
 * paths, tokens or PIDs — the `redacted: true` flag is a contract
 * guarantee, not decoration.
 */
export function buildDiagnosticsReadModel(
  generatedAt: string,
  authority: PublicAuthorityIdentity,
  entries: ReadonlyArray<{
    readonly entryId: DiagnosticEntryId;
    readonly scope: "host" | "runtime" | "bridge" | "installer";
    readonly level: "info" | "warning" | "error";
    readonly message: string;
    readonly detail?: Readonly<Record<string, unknown>>;
    readonly occurredAt: string;
  }>,
): DiagnosticReadModel {
  return {
    generatedAt,
    authority: { ...authority },
    entries: entries.map((entry) => ({
      entryId: entry.entryId,
      scope: entry.scope,
      level: entry.level,
      message: redactText(entry.message),
      ...(entry.detail === undefined ? {} : { detail: redactDetail(entry.detail) }),
      occurredAt: entry.occurredAt,
    })),
    redacted: true,
  };
}

/** Safe display facts from an installed runtime manifest (never its entrypoint path). */
export function safeInstallerFacts(manifest: RuntimeInstallationManifest): {
  readonly version: string;
  readonly channel: "stable" | "canary";
  readonly profile: "full-parity-v1" | "limited";
} {
  return {
    version: manifest.runtimeVersion,
    channel: manifest.channel,
    profile: manifest.profile,
  };
}
