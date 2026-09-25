/** OMP screen recordings and Studio's raw PTY output recordings. Never executable commands. */
export type RecordingFrame =
  | { t: "resize"; cols: number; rows: number }
  | { t: "viewport" | "history"; rows: string[] }
  | { t: "patch"; ops: [number, string][]; rows: number }
  | { t: "reset" }
  | { t: "output"; data: string };
export interface PlaybackRecording {
  format: "ompcast" | "studiocast"; cols: number; rows: number; title: string;
  events: Array<{ at: number; frame: RecordingFrame }>; durationMs: number; truncated: boolean;
}
export const RECORDING_MAX_BYTES = 32 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recording object"); return value as Record<string, unknown>; }
function dimension(value: unknown, maximum: number): asserts value is number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Recording terminal dimensions exceed the playback limit (500 columns, 200 rows)"); }
function text(value: unknown): asserts value is string { if (typeof value !== "string" || value.length > 262144) throw new Error("Recording text frame exceeds its limit"); }
export function parsePlaybackRecording(source: string): PlaybackRecording {
  if (new TextEncoder().encode(source).byteLength > RECORDING_MAX_BYTES) throw new Error("Recording exceeds 32 MiB");
  const lines = source.split("\n"); const header = object(JSON.parse(lines.shift() ?? ""));
  const format = header.ompcast === 1 ? "ompcast" : header.studiocast === 1 ? "studiocast" : undefined;
  if (!format) throw new Error("Unsupported recording format; choose .ompcast or .studiocast");
  dimension(header.cols, 500); dimension(header.rows, 200); text(header.title);
  const events: PlaybackRecording["events"] = []; let lastAt = 0; let truncated = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!; if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { if (index === lines.length - 1 && !source.endsWith("\n")) { truncated = true; break; } throw new Error(`Malformed recording line ${index + 2}`); }
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || !Number.isSafeInteger(value[0]) || value[0] < lastAt || value[0] > 8 * 3600000) throw new Error("Invalid or non-monotonic recording timestamp");
    const frame = object(value[1]);
    if (frame.t === "resize") { dimension(frame.cols, 500); dimension(frame.rows, 200); }
    else if (frame.t === "output" && format === "studiocast") text(frame.data);
    else if ((frame.t === "viewport" || frame.t === "history") && format === "ompcast") { if (!Array.isArray(frame.rows) || frame.rows.length > (frame.t === "history" ? 5000 : 200)) throw new Error("Too many recording rows"); frame.rows.forEach(text); }
    else if (frame.t === "patch" && format === "ompcast") {
      dimension(frame.rows, 200); if (!Array.isArray(frame.ops) || frame.ops.length > 2000) throw new Error("Invalid recording patch");
      for (const op of frame.ops) { if (!Array.isArray(op) || op.length !== 2 || !Number.isInteger(op[0]) || op[0] < 0 || op[0] >= frame.rows) throw new Error("Patch row is out of bounds"); text(op[1]); }
    } else if (frame.t !== "reset" || format !== "ompcast") throw new Error("Unknown recording frame");
    lastAt = value[0]; events.push({ at: lastAt, frame: frame as unknown as RecordingFrame });
    if (events.length > 100000) throw new Error("Recording exceeds 100,000 frames");
  }
  return { format, cols: header.cols, rows: header.rows, title: header.title.slice(0, 512), events, durationMs: lastAt, truncated };
}
export interface RecordedScreen { cols: number; rows: number; history: string[]; viewport: string[] }
/** Same bounded history/viewport semantics as upstream stream/protocol.ts. */
export function applyRecordedFrame(screen: RecordedScreen, frame: RecordingFrame): void {
  const fit = () => { screen.viewport.length = Math.min(screen.viewport.length, screen.rows); while (screen.viewport.length < screen.rows) screen.viewport.push(""); };
  if (frame.t === "resize") { screen.cols = frame.cols; screen.rows = frame.rows; fit(); }
  else if (frame.t === "viewport") screen.viewport = frame.rows.slice();
  else if (frame.t === "history") screen.history = [...screen.history, ...frame.rows].slice(-1000);
  else if (frame.t === "patch") { screen.rows = frame.rows; fit(); for (const [index, row] of frame.ops) screen.viewport[index] = row; }
  else if (frame.t === "reset") { screen.history = []; screen.viewport = []; }
}
