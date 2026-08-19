/**
 * Desktop-chrome Host log directory / export IPC 契约。
 *
 * Shared by Main and the sandboxed preload（无 Electron Main API）。
 * 这不是 Host / Studio Bridge 面：Renderer 只请求打开或导出，Main 读写
 * `%APPDATA%\omp-studio\logs`，永不把路径回传。
 */

export const CHROME_LOGS_CHANNELS = {
  openDir: "omp-studio:desktop:chrome-logs-open-dir",
  exportLogs: "omp-studio:desktop:chrome-logs-export",
} as const;

export type ChromeLogsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly message: string };

export const HOST_LOG_EXPORT_MAX_CHARS = 512_000;
export const HOST_LOG_BASENAME = /^host-\d{4}-\d{2}-\d{2}\.log$/u;

export function isHostLogBasename(name: string): boolean {
  return HOST_LOG_BASENAME.test(name);
}

export function parseChromeLogsPayload(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length === 0;
}

/**
 * Concatenate dated Host logs for export. Names only, never paths.
 * Keeps the newest tail when the combined text exceeds `maxChars`.
 */
export function composeHostLogExport(
  files: ReadonlyArray<{ readonly name: string; readonly text: string }>,
  maxChars = HOST_LOG_EXPORT_MAX_CHARS,
): string {
  const sorted = [...files]
    .filter((file) => isHostLogBasename(file.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const parts = sorted.map((file) => `--- ${file.name} ---\n${file.text.replace(/\s+$/u, "")}\n`);
  let text = parts.join("\n");
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return text;
}
