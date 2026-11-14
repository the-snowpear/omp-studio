import { TerminalIpcError, parseSessionId, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS } from "../terminal-shared.js";

export const TMUX_IPC_CHANNELS = {
  sessions: "omp-studio:desktop:terminal-tmux-sessions",
  attach: "omp-studio:desktop:terminal-tmux-attach",
  command: "omp-studio:desktop:terminal-tmux-command",
  detach: "omp-studio:desktop:terminal-tmux-detach",
  topology: "omp-studio:desktop:terminal-tmux-topology",
} as const;
export const TMUX_MIN_VERSION = [3, 2] as const;
export const TMUX_MAX_CONNECTIONS_PER_WINDOW = 4;
export const TMUX_MAX_PANES_PER_CONNECTION = 64;
export const TMUX_SESSION_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export const TMUX_WINDOW_ID_PATTERN = /^@\d{1,9}$/;
export const TMUX_PANE_ID_PATTERN = /^%\d{1,9}$/;

export interface TmuxSessionsInput { targetId: string; workspaceId: string }
export interface TmuxSessionSummary { id: string; name: string; windows: number; attached: number; createdAt: number }
export type TmuxSessionsResult =
  | { available: true; version: string; sessions: TmuxSessionSummary[] }
  | { available: false; reason: "remote-windows" | "not-installed" | "too-old" | "ssh-failed"; version?: string; message: string };
export interface TmuxAttachInput extends TmuxSessionsInput { session?: string; cols: number; rows: number; flowControl?: boolean }
export interface TmuxAttachResult { connectionId: string }
export type TmuxAction =
  | { kind: "newWindow"; afterWindowId?: string }
  | { kind: "splitPane"; paneId: string; direction: "right" | "down" }
  | { kind: "killPane" | "selectPane" | "zoomPane"; paneId: string }
  | { kind: "killWindow" | "selectWindow"; windowId: string }
  | { kind: "killSession" }
  | { kind: "renameWindow"; windowId: string; name: string }
  | { kind: "resizeWindow"; windowId: string; cols: number; rows: number }
  | { kind: "resizePane"; paneId: string; axis: "x" | "y"; cells: number }
  | { kind: "setPaneVisible"; paneIds: string[]; visible: boolean };
export interface TmuxCommandInput { connectionId: string; action: TmuxAction }
export type TmuxLayoutNode =
  | { type: "pane"; paneId: string; x: number; y: number; cols: number; rows: number }
  | { type: "row" | "column"; x: number; y: number; cols: number; rows: number; children: TmuxLayoutNode[] };
export interface TmuxTopology {
  connectionId: string; targetId: string; workspaceId: string;
  state: "attaching" | "attached" | "exited" | "lost";
  reason?: string; version?: string;
  session?: { id: string; name: string };
  activeWindowId?: string;
  windows: Array<{ id: string; index: number; name: string; zoomed: boolean; layout: TmuxLayoutNode; fullLayout?: TmuxLayoutNode; cols: number; rows: number }>;
  panes: Record<string, { terminalId: string; windowId: string; active: boolean; title: string; cwd?: string; paused: boolean; dead: boolean; off: boolean }>;
  configErrors?: string[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TerminalIpcError("tmux: expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.length || value.length > 512 || /[\x00-\x1f\x7f]/.test(value) || (pattern && !pattern.test(value))) throw new TerminalIpcError(`Invalid tmux ${field}`);
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new TerminalIpcError(`Invalid tmux ${field}`);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TerminalIpcError(`Invalid tmux ${field}`);
  return value;
}
function size(value: Record<string, unknown>) {
  return { cols: integer(value.cols, "cols", TERMINAL_MIN_COLS, TERMINAL_MAX_COLS), rows: integer(value.rows, "rows", TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS) };
}
export function parseTmuxSessionsInput(value: unknown): TmuxSessionsInput {
  const input = object(value);
  return { targetId: text(input.targetId, "targetId"), workspaceId: text(input.workspaceId, "workspaceId") };
}
export function parseTmuxAttachInput(value: unknown): TmuxAttachInput {
  const input = object(value);
  return { ...parseTmuxSessionsInput(input), ...size(input), ...(input.session === undefined ? {} : { session: text(input.session, "session", TMUX_SESSION_NAME_PATTERN) }), ...(input.flowControl === undefined ? {} : { flowControl: boolean(input.flowControl, "flowControl") }) };
}
export function parseTmuxDetachInput(value: unknown): string { return parseSessionId(object(value).connectionId, "tmux connectionId"); }
export function parseTmuxCommandInput(value: unknown): TmuxCommandInput {
  const input = object(value), raw = object(input.action);
  const connectionId = parseSessionId(input.connectionId, "tmux connectionId");
  const pane = () => text(raw.paneId, "paneId", TMUX_PANE_ID_PATTERN);
  const window = () => text(raw.windowId, "windowId", TMUX_WINDOW_ID_PATTERN);
  let action: TmuxAction;
  switch (raw.kind) {
    case "newWindow": action = { kind: raw.kind, ...(raw.afterWindowId === undefined ? {} : { afterWindowId: text(raw.afterWindowId, "windowId", TMUX_WINDOW_ID_PATTERN) }) }; break;
    case "killSession": action = { kind: raw.kind }; break;
    case "killPane": case "selectPane": case "zoomPane": action = { kind: raw.kind, paneId: pane() }; break;
    case "killWindow": case "selectWindow": action = { kind: raw.kind, windowId: window() }; break;
    case "splitPane":
      if (raw.direction !== "right" && raw.direction !== "down") throw new TerminalIpcError("Invalid tmux split direction");
      action = { kind: raw.kind, paneId: pane(), direction: raw.direction }; break;
    case "renameWindow": {
      const name = text(raw.name, "window name");
      if (name.length > 128) throw new TerminalIpcError("tmux window name exceeds 128 characters");
      action = { kind: raw.kind, windowId: window(), name }; break;
    }
    case "resizeWindow": action = { kind: raw.kind, windowId: window(), ...size(raw) }; break;
    case "resizePane":
      if (raw.axis !== "x" && raw.axis !== "y") throw new TerminalIpcError("Invalid tmux resize axis");
      action = { kind: raw.kind, paneId: pane(), axis: raw.axis, cells: integer(raw.cells, "cells", 1, raw.axis === "x" ? TERMINAL_MAX_COLS : TERMINAL_MAX_ROWS) }; break;
    case "setPaneVisible":
      if (!Array.isArray(raw.paneIds) || raw.paneIds.length > TMUX_MAX_PANES_PER_CONNECTION) throw new TerminalIpcError("Invalid tmux pane list");
      action = { kind: raw.kind, paneIds: raw.paneIds.map(id => text(id, "paneId", TMUX_PANE_ID_PATTERN)), visible: boolean(raw.visible, "visible") }; break;
    default: throw new TerminalIpcError("Unknown tmux action");
  }
  return { connectionId, action };
}
