/**
 * 桌面通知分发（App 级，非 Host 能力）。
 *
 * 偏好开关读 appSettings；实际展示经 preload 暴露的
 * `ompStudioChrome.notify` 走 Electron Main 的系统 Notification。
 * Web / Vite dev 环境没有该通道时静默跳过——不降级到页面内伪造。
 *
 * 任务完成 / 长时间任务提醒只在窗口失焦时打扰；错误与等待确认始终提醒。
 */

import { getAppSettings } from "./appSettings";

export type DesktopNoticeKind = "task" | "error" | "ask" | "longTask";

const PREF_BY_KIND: Readonly<Record<DesktopNoticeKind, "notifyTaskDone" | "notifyErrors" | "notifyConfirmations" | "notifyLongTasks">> = {
  task: "notifyTaskDone",
  error: "notifyErrors",
  ask: "notifyConfirmations",
  longTask: "notifyLongTasks",
};

export function desktopNotice(kind: DesktopNoticeKind, title: string, body?: string): void {
  if (!getAppSettings()[PREF_BY_KIND[kind]]) return;
  if ((kind === "task" || kind === "longTask") && typeof document !== "undefined" && document.hasFocus()) return;
  try {
    void globalThis.ompStudioChrome?.notify?.({ title, ...(body === undefined ? {} : { body }) });
  } catch {
    /* 通道异常时静默；通知是尽力而为的附加提示。 */
  }
}
