/**
 * Desktop-chrome 用系统默认浏览器打开 https 链接的 IPC 契约。
 *
 * Shared by Main and the sandboxed preload（无 Electron Main API）。
 * 这不是 Host / Studio Bridge 面：Renderer 只提交一条 URL，Main 校验后
 * 走 `shell.openExternal`，不会在 Electron 里再开一扇窗。
 */

export const CHROME_OPEN_URL_CHANNEL = "omp-studio:desktop:chrome-open-url" as const;

export interface ChromeOpenUrlInput {
  readonly url: string;
}

const MAX_URL = 2048;

export function parseChromeOpenUrlInput(value: unknown): ChromeOpenUrlInput | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { url?: unknown };
  if (typeof record.url !== "string") return undefined;
  const raw = record.url.trim();
  if (raw.length === 0 || raw.length > MAX_URL) return undefined;
  if (/[\u0000-\u001F\u007F]/u.test(raw)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0) return undefined;
  return { url: parsed.href };
}
