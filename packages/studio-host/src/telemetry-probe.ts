import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import { parseSessionTelemetrySnapshot, type SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";

/**
 * Host-internal request to the one-shot OMP archived-session telemetry probe.
 * `sessionFile` is a Host-created temporary transcript copy; the probe never
 * learns the original archive path.
 */
export interface SessionTelemetryProbeRunInput {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly allowedCwd: string;
  /** Part of the in-memory cache key together with session and executable identity. */
  readonly transcriptRevision: string;
}

export type SessionTelemetryProbeOutcome =
  | { readonly ok: true; readonly telemetry: SessionTelemetrySnapshot }
  | { readonly ok: false; readonly reason: "UNAVAILABLE" };

/** Presentation-neutral probe port consumed by the Host facade. */
export interface SessionTelemetryProbePort {
  run(input: SessionTelemetryProbeRunInput): Promise<SessionTelemetryProbeOutcome>;
}

export type SpawnFunction = typeof spawn;

export interface NodeSessionTelemetryProbeOptions {
  /** Returns the absolute path of a compatible OMP executable, if any. */
  readonly executablePath: () => string | Promise<string | undefined> | undefined;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
  readonly spawnProcess?: SpawnFunction;
  /**
   * Safe completion diagnostic for Host logs. Carries only coarse facts
   * (outcome category, exit code, duration) — never paths, session ids, or
   * captured process output.
   */
  readonly onDiagnostic?: (info: SessionTelemetryProbeDiagnostic) => void;
}

/** Coarse outcome facts for one probe child process; log-safe by construction. */
export interface SessionTelemetryProbeDiagnostic {
  readonly result: "ok" | "unavailable";
  readonly reason?:
    | "no-executable"
    | "disposed"
    | "spawn-error"
    | "timeout"
    | "overflow"
    | "nonzero-exit"
    | "malformed-output"
    | "identity-mismatch"
    | "invalid-telemetry";
  readonly exitCode?: number;
  readonly durationMs: number;
}

interface ProbeStdioLine {
  readonly schemaVersion: number;
  readonly requestId: string;
  readonly ok: boolean;
  readonly telemetry?: unknown;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_CACHE_TTL_MS = 30_000;
const PROBE_ARG = "--studio-session-telemetry-probe";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Spawns the one-shot OMP telemetry probe (`--studio-session-telemetry-probe`).
 *
 * Hard limits: `shell:false`, hidden window, piped stdio, a fixed 8s timeout,
 * 64 KiB stdout / 16 KiB stderr caps, and a single JSON reply that must echo
 * the request id and match the requested session id. Every deviation —
 * timeout, oversized output, non-zero exit, malformed JSON, identity mismatch
 * — collapses to a safe `UNAVAILABLE`; raw stderr never leaves this module.
 * Successful results are memoized for 30s per `sessionId + revision +
 * executable identity`, and concurrent requests with the same key share one
 * in-flight child process. The probe process is NOT a session worker: it is
 * never registered with the Session Broker and cannot touch leases, the
 * current selection, or the runtime epoch.
 */
export function createNodeSessionTelemetryProbe(
  options: NodeSessionTelemetryProbeOptions,
): SessionTelemetryProbePort & { dispose(): void } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const spawnProcess = options.spawnProcess ?? spawn;
  const cache = new Map<string, { readonly expiresAt: number; readonly telemetry: SessionTelemetrySnapshot }>();
  const inFlight = new Map<string, Promise<SessionTelemetryProbeOutcome>>();
  let disposed = false;
  const emitDiagnostic = (info: SessionTelemetryProbeDiagnostic): void => {
    try {
      options.onDiagnostic?.(info);
    } catch {
      // Diagnostics must never affect the probe outcome.
    }
  };

  const executableIdentity = async (executable: string): Promise<string> => {
    try {
      const metadata = await stat(executable);
      return `${executable}:${metadata.size}:${metadata.mtimeMs}`;
    } catch {
      return executable;
    }
  };

  const spawnOnce = async (
    input: SessionTelemetryProbeRunInput,
    executable: string,
  ): Promise<SessionTelemetryProbeOutcome & { readonly diagnostic: SessionTelemetryProbeDiagnostic }> => {
    const requestId = randomUUID();
    const startedAt = now();
    const failure: { reason: NonNullable<SessionTelemetryProbeDiagnostic["reason"]>; exitCode?: number } = {
      reason: "malformed-output",
    };
    const child = spawnProcess(
      executable,
      [PROBE_ARG],
      {
        cwd: input.allowedCwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill();
      return {
        ok: false,
        reason: "UNAVAILABLE",
        diagnostic: { result: "unavailable", reason: "spawn-error", durationMs: now() - startedAt },
      };
    }
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const result = new Promise<SessionTelemetryProbeOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        failure.reason = "timeout";
        child.kill();
        resolve({ ok: false, reason: "UNAVAILABLE" });
      }, timeoutMs);
      if (timer.unref !== undefined) timer.unref();
      const finish = (outcome: SessionTelemetryProbeOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      child.on("error", () => {
        failure.reason = "spawn-error";
        finish({ ok: false, reason: "UNAVAILABLE" });
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > maxStdoutBytes) {
          overflowed = true;
          failure.reason = "overflow";
          child.kill();
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > maxStderrBytes) {
          overflowed = true;
          failure.reason = "overflow";
          child.kill();
        }
      });
      child.on("close", (exitCode) => {
        if (overflowed) {
          finish({ ok: false, reason: "UNAVAILABLE" });
          return;
        }
        if (exitCode !== 0) {
          failure.reason = "nonzero-exit";
          if (exitCode !== null) failure.exitCode = exitCode;
          finish({ ok: false, reason: "UNAVAILABLE" });
          return;
        }
        const text = Buffer.concat(stdoutChunks).toString("utf8").trim();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          failure.reason = "malformed-output";
          finish({ ok: false, reason: "UNAVAILABLE" });
          return;
        }
        if (
          !isRecord(parsed) ||
          parsed.schemaVersion !== 1 ||
          parsed.requestId !== requestId ||
          parsed.ok !== true ||
          !isRecord(parsed.telemetry)
        ) {
          failure.reason = "identity-mismatch";
          finish({ ok: false, reason: "UNAVAILABLE" });
          return;
        }
        const line = parsed as unknown as ProbeStdioLine & { telemetry: Record<string, unknown> };
        try {
          const telemetry = parseSessionTelemetrySnapshot(line.telemetry);
          if (telemetry.sessionId !== input.sessionId) {
            failure.reason = "identity-mismatch";
            finish({ ok: false, reason: "UNAVAILABLE" });
            return;
          }
          finish({ ok: true, telemetry });
        } catch {
          failure.reason = "invalid-telemetry";
          finish({ ok: false, reason: "UNAVAILABLE" });
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(
        JSON.stringify({
          schemaVersion: 1,
          requestId,
          sessionFile: input.sessionFile,
          expectedSessionId: input.sessionId,
          allowedCwd: input.allowedCwd,
        }),
        "utf8",
      );
    });
    const outcome = await result;
    const diagnostic: SessionTelemetryProbeDiagnostic = outcome.ok
      ? { result: "ok", durationMs: now() - startedAt }
      : {
          result: "unavailable",
          reason: failure.reason,
          ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
          durationMs: now() - startedAt,
        };
    return { ...outcome, diagnostic };
  };

  const run = async (input: SessionTelemetryProbeRunInput): Promise<SessionTelemetryProbeOutcome> => {
    if (disposed) {
      emitDiagnostic({ result: "unavailable", reason: "disposed", durationMs: 0 });
      return { ok: false, reason: "UNAVAILABLE" };
    }
    const executable = await options.executablePath();
    if (executable === undefined || executable.length === 0) {
      emitDiagnostic({ result: "unavailable", reason: "no-executable", durationMs: 0 });
      return { ok: false, reason: "UNAVAILABLE" };
    }
    const identity = await executableIdentity(executable);
    const cacheKey = `${input.sessionId}\0${input.transcriptRevision}\0${identity}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now()) return { ok: true, telemetry: cached.telemetry };
    const pending = inFlight.get(cacheKey);
    if (pending !== undefined) return pending;
    const flight = spawnOnce(input, executable)
      .then((outcome) => {
        emitDiagnostic(outcome.diagnostic);
        if (outcome.ok) {
          cache.set(cacheKey, { expiresAt: now() + cacheTtlMs, telemetry: outcome.telemetry });
        }
        return outcome;
      })
      .finally(() => {
        inFlight.delete(cacheKey);
      });
    inFlight.set(cacheKey, flight);
    return flight;
  };

  return {
    run,
    dispose(): void {
      disposed = true;
      cache.clear();
    },
  };
}
