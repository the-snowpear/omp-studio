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

export type HostLogLevel = "info" | "warn" | "error";

export interface HostLog {
  write(level: HostLogLevel, event: string, detail?: string): void;
}

const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu;
const EVENT_NAME = /^[a-z][a-z0-9._-]{0,63}$/u;
const MAX_DETAIL = 2_000;

export function formatHostLogLine(
  now: Date,
  level: HostLogLevel,
  event: string,
  detail?: string,
): string {
  const safeEvent = EVENT_NAME.test(event) ? event : "host.invalid_event";
  const raw = detail === undefined ? "" : stripControl(detail);
  const redacted = raw.length === 0 ? "" : redactFully(raw).slice(0, MAX_DETAIL);
  const suffix = redacted.length === 0 ? "" : ` ${redacted}`;
  return `${now.toISOString()} ${level} ${safeEvent}${suffix}\n`;
}

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

  return {
    write(level, event, detail) {
      const stamp = now();
      const day = stamp.toISOString().slice(0, 10);
      const path = join(options.directory, `host-${day}.log`);
      const line = formatHostLogLine(stamp, level, event, detail);
      void ensureDirectory()
        .then(() => append(path, line))
        .catch(() => {
          // Logging must never take down the Host.
        });
    },
  };
}

function stripControl(value: string): string {
  return value.replace(ANSI, "").replace(/[\r\n\t]+/gu, " ").trim();
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
