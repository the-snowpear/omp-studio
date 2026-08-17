/**
 * Desktop-chrome 系统通知 IPC 契约。
 *
 * Shared by Main and the sandboxed preload（无 Electron Main API，preload
 * 可 import）。这不是 Host / Studio Bridge 面：Renderer 只能提交一条已
 * 组装好的通知文案，长度受限，不含任何路径 / secret / Runtime 事实。
 */

export const CHROME_NOTIFY_CHANNEL = "omp-studio:desktop:chrome-notify" as const;

export interface ChromeNotifyInput {
  readonly title: string;
  readonly body?: string;
}

const MAX_TITLE = 120;
const MAX_BODY = 400;

export function parseChromeNotifyInput(value: unknown): ChromeNotifyInput | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { title?: unknown; body?: unknown };
  if (typeof record.title !== "string") return undefined;
  const title = record.title.trim();
  if (title.length === 0 || title.length > MAX_TITLE) return undefined;
  if (record.body === undefined) return { title };
  if (typeof record.body !== "string") return undefined;
  const body = record.body.trim();
  if (body.length > MAX_BODY) return undefined;
  return body.length === 0 ? { title } : { title, body };
}
