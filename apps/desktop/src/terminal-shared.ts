/**
 * Desktop-chrome terminal IPC contract.
 *
 * Shared by Main and the sandboxed preload. No Electron Main APIs — preload
 * may import this file. This is not a Host / Studio Bridge surface.
 */

export const TERMINAL_IPC_CHANNELS = {
  create: "omp-studio:desktop:terminal-create",
  write: "omp-studio:desktop:terminal-write",
  resize: "omp-studio:desktop:terminal-resize",
  dispose: "omp-studio:desktop:terminal-dispose",
  data: "omp-studio:desktop:terminal-data",
  exit: "omp-studio:desktop:terminal-exit",
} as const;

export const TERMINAL_MAX_SESSIONS = 8;
export const TERMINAL_MAX_WRITE = 65_536;
export const TERMINAL_MIN_COLS = 2;
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MIN_ROWS = 1;
export const TERMINAL_MAX_ROWS = 200;
export const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface TerminalCreateInput {
  readonly cols?: number;
  readonly rows?: number;
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalSessionInfo {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
}

export interface TerminalWriteInput {
  readonly id: string;
  readonly data: string;
}

export interface TerminalResizeInput {
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalDisposeInput {
  readonly id: string;
}

export interface TerminalDataEvent {
  readonly id: string;
  readonly data: string;
}

export interface TerminalExitEvent {
  readonly id: string;
}

export class TerminalIpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalIpcError";
  }
}

function assertPlainObject(value: unknown, what: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TerminalIpcError(`${what}: expected an object`);
  }
}

function parseDimension(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TerminalIpcError(`${field}: expected an integer ${min}–${max}`);
  }
  return value;
}

export function parseSessionId(value: unknown, field: string): string {
  if (typeof value !== "string" || !TERMINAL_ID_PATTERN.test(value)) {
    throw new TerminalIpcError(`${field}: expected a terminal session id`);
  }
  return value;
}

export function parseCreateInput(value: unknown): TerminalSize {
  const input = value === undefined ? {} : value;
  assertPlainObject(input, "terminal create");
  for (const key of Object.keys(input)) {
    if (key !== "cols" && key !== "rows") {
      throw new TerminalIpcError(`terminal create: unexpected field ${key}`);
    }
  }
  return {
    cols: parseDimension(input.cols, "terminal create: cols", TERMINAL_MIN_COLS, TERMINAL_MAX_COLS, 80),
    rows: parseDimension(input.rows, "terminal create: rows", TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS, 24),
  };
}

export function parseWriteInput(value: unknown): TerminalWriteInput {
  assertPlainObject(value, "terminal write");
  for (const key of Object.keys(value)) {
    if (key !== "id" && key !== "data") {
      throw new TerminalIpcError(`terminal write: unexpected field ${key}`);
    }
  }
  if (typeof value.data !== "string") {
    throw new TerminalIpcError("terminal write: data must be a string");
  }
  if (value.data.length > TERMINAL_MAX_WRITE) {
    throw new TerminalIpcError(`terminal write: data exceeds ${TERMINAL_MAX_WRITE} characters`);
  }
  return { id: parseSessionId(value.id, "terminal write: id"), data: value.data };
}

export function parseResizeInput(value: unknown): TerminalResizeInput {
  assertPlainObject(value, "terminal resize");
  for (const key of Object.keys(value)) {
    if (key !== "id" && key !== "cols" && key !== "rows") {
      throw new TerminalIpcError(`terminal resize: unexpected field ${key}`);
    }
  }
  return {
    id: parseSessionId(value.id, "terminal resize: id"),
    cols: parseDimension(value.cols, "terminal resize: cols", TERMINAL_MIN_COLS, TERMINAL_MAX_COLS, 80),
    rows: parseDimension(value.rows, "terminal resize: rows", TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS, 24),
  };
}

export function parseDisposeInput(value: unknown): TerminalDisposeInput {
  assertPlainObject(value, "terminal dispose");
  for (const key of Object.keys(value)) {
    if (key !== "id") {
      throw new TerminalIpcError(`terminal dispose: unexpected field ${key}`);
    }
  }
  return { id: parseSessionId(value.id, "terminal dispose: id") };
}

export interface OmpStudioTerminalApi {
  create(size?: TerminalCreateInput): Promise<TerminalSessionInfo>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  dispose(id: string): Promise<void>;
  onData(listener: (event: TerminalDataEvent) => void): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
}
