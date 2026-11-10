/**
 * Host-owned append-only diagnostic log.
 *
 * Lives under `<profile>/logs/host-YYYY-MM-DD.log` (production:
 * `%APPDATA%\omp-studio\logs`). Lines are pre-redacted so a copy of the
 * file is safe to paste: no tokens, endpoints, PIDs or filesystem paths.
 * Failures to write never throw into Runtime lifecycle.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { redactText } from "@omp-studio/host-client-api";
import type { MemorySample } from "@omp-studio/studio-protocol";

import { desktopPaths } from "./platform/desktop-paths.js";

export type HostLogLevel = "info" | "warn" | "error";

/** Dated Host log basename: `host-YYYY-MM-DD.log`. */
export const HOST_LOG_BASENAME = /^host-\d{4}-\d{2}-\d{2}\.log$/u;

/** Logs directory under a Host profile directory. */
export function hostLogsDirectory(profileDirectory: string): string {
  return join(profileDirectory, "logs");
}

/**
 * Production Host logs directory (`%APPDATA%\omp-studio\logs` on Windows).
 * Shared by the file log writer and the diagnostics chrome IPC so the
 * Renderer never has to learn a filesystem path.
 */
export function defaultHostLogsDirectory(): string {
  return desktopPaths().logsRoot;
}

export interface HostLog {
  /** Only complete numeric values under these fields may bypass PID-like text redaction. */
  write(level: HostLogLevel, event: string, detail?: string, numericFields?: ReadonlySet<string>): void;
}

const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu;
const EVENT_NAME = /^[a-z][a-z0-9._-]{0,63}$/u;
const MAX_DETAIL = 2_000;
const MEMORY_NUMERIC_FIELDS = ["rssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes"];
// The Runtime's dedicated numeric sampler emits this fixed subset over stderr.
const RUNTIME_PERFORMANCE_FIELDS = new Set([
  ...MEMORY_NUMERIC_FIELDS, "seq", "workerResidency", "workerGeneration", "projectors", "messages", "tools", "pending", "blockBytes", "listeners",
]);
const SENSITIVE_NUMERIC_FIELD = /pid|process|path|token|secret|password|endpoint|pipe|auth|bearer|credential/iu;

/** Opt in the fields produced by formatMemorySampleLine, not arbitrary event text. */
export function performanceSampleNumericFields(sample: MemorySample): ReadonlySet<string> {
  return new Set([...MEMORY_NUMERIC_FIELDS, "instance", "seq", ...Object.keys(sample.counters)]);
}

export function formatHostLogLine(
  now: Date,
  level: HostLogLevel,
  event: string,
  detail?: string,
  numericFields?: ReadonlySet<string>,
): string {
  const safeEvent = EVENT_NAME.test(event) ? event : "host.invalid_event";
  const raw = detail === undefined ? "" : stripControl(detail);
  const fields = numericFields ?? (safeEvent === "runtime.stderr" && /^\[studio\.performance\] role=runtime(?: |$)/u.test(raw)
    ? RUNTIME_PERFORMANCE_FIELDS : undefined);
  const redacted = raw.length === 0 ? "" : (fields === undefined ? redactFully(raw) : redactNumericFields(raw, fields)).slice(0, MAX_DETAIL);
  const suffix = redacted.length === 0 ? "" : ` ${redacted}`;
  return `${now.toISOString()} ${level} ${safeEvent}${suffix}\n`;
}

/**
 * Maximum lines waiting on the append chain. A chatty Runtime emits one line
 * per stderr line (`runtime-session.ts` `attachRuntimeOutput`), each bounded by
 * `MAX_DETAIL` (2000 chars), so the backlog costs at most a few MB before it is
 * dropped. Diagnostics are worth less than Main-process headroom.
 */
const MAX_PENDING_LINES = 1_000;

export function createHostFileLog(options: {
  readonly directory: string;
  readonly now?: () => Date;
  readonly append?: (path: string, line: string) => Promise<void>;
}): HostLog {
  const now = options.now ?? (() => new Date());
  const append = options.append ?? defaultAppend;
  let directoryReady: Promise<void> | undefined;

  const ensureDirectory = (): Promise<void> => {
    directoryReady ??= mkdir(options.directory, { recursive: true }).then(
      () => undefined,
      () => {
        directoryReady = undefined;
      },
    );
    return directoryReady;
  };

  /**
   * Appends are serialized through one chain: an unawaited `appendFile` per
   * line lets a chatty Runtime pile up in-flight fs promises (each retaining
   * its line) and concurrent file handles.
   */
  const pending: { path: string; line: string }[] = [];
  let dropped = 0;
  let draining = false;

  const drain = (): void => {
    if (draining) return;
    draining = true;
    void (async () => {
      try {
        while (pending.length > 0) {
          const next = pending.shift();
          if (next === undefined) break;
          try {
            await ensureDirectory();
            await append(next.path, next.line);
          } catch {
            // Logging must never take down the Host.
          }
          if (dropped > 0 && pending.length === 0) {
            const count = dropped;
            dropped = 0;
            pending.push({
              path: next.path,
              line: formatHostLogLine(now(), "warn", "host.log_dropped", `lines=${count}`),
            });
          }
        }
      } finally {
        draining = false;
      }
    })();
  };

  return {
    write(level, event, detail, numericFields) {
      const stamp = now();
      const day = stamp.toISOString().slice(0, 10);
      const path = join(options.directory, `host-${day}.log`);
      const line = formatHostLogLine(stamp, level, event, detail, numericFields);
      if (pending.length >= MAX_PENDING_LINES) {
        dropped += 1;
        return;
      }
      pending.push({ path, line });
      drain();
    },
  };
}

function stripControl(value: string): string {
  return value.replace(ANSI, "").replace(/[\r\n\t]+/gu, " ").trim();
}

function redactNumericFields(value: string, fields: ReadonlySet<string>): string {
  const field = /(^|\s)([a-z][A-Za-z0-9_.-]{0,79})=(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|$)/gu;
  const parts: string[] = [];
  let from = 0;
  for (let match = field.exec(value); match !== null; match = field.exec(value)) {
    const key = match[2] ?? "";
    const number = match[3] ?? "";
    if (!fields.has(key) || SENSITIVE_NUMERIC_FIELD.test(key) || !Number.isFinite(Number(number))) continue;
    const start = match.index + match[0].length - number.length;
    // Only the number is exempt: keys and all surrounding text still redact.
    parts.push(redactFully(value.slice(from, start)), number);
    from = start + number.length;
  }
  parts.push(redactFully(value.slice(from)));
  return parts.join("");
}

/** `redactText` only replaces the first path-like match; logs may contain several. */
function redactFully(value: string): string {
  let current = value;
  for (let i = 0; i < 8; i++) {
    const next = redactText(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

async function defaultAppend(path: string, line: string): Promise<void> {
  await appendFile(path, line, { encoding: "utf8" });
}
