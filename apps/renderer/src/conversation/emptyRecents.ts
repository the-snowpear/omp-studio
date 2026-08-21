import type { SessionHistoryEntry } from "@omp-studio/client-contract";
import { PREVIEW_PROJECTS, type PreviewThread } from "../preview/fixtures";

export type EmptyRecentStatus = "running" | "approval" | "idle";

export type EmptyRecentRow = {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly time: string;
  readonly status: EmptyRecentStatus;
  readonly statusLabel: string;
  readonly previewThreadId?: string;
  readonly entry?: SessionHistoryEntry;
};

const RECENT_LIMIT = 3;

function previewAgeMinutes(time: string): number {
  if (time === "now") return 0;
  const match = /(\d+)\s*(m|h|d)/.exec(time);
  if (!match) return 99_999;
  const amount = Number(match[1]);
  if (match[2] === "m") return amount;
  if (match[2] === "h") return amount * 60;
  return amount * 1440;
}

function previewStatus(thread: PreviewThread, lang: "zh" | "en" = "zh"): { status: EmptyRecentStatus; statusLabel: string } {
  if (thread.status === "running") return { status: "running", statusLabel: lang === "en" ? "Running" : "运行中" };
  if (thread.wait === "approval" || thread.wait === "plan" || thread.wait === "ask") {
    return {
      status: "approval",
      statusLabel: thread.wait === "ask"
        ? (lang === "en" ? "Waiting for reply" : "等待回答")
        : (lang === "en" ? "Waiting for approval" : "等待审批"),
    };
  }
  return { status: "idle", statusLabel: lang === "en" ? "Idle" : "空闲" };
}

/** Preview recents: flatten ver1 projects, skip archived / the blank t0 thread. */
export function collectPreviewRecents(
  hiddenIds: ReadonlySet<string> = new Set(),
  lang: "zh" | "en" = "zh",
): EmptyRecentRow[] {
  return PREVIEW_PROJECTS
    .flatMap((project) => project.threads.map((thread) => ({ project: project.name, thread })))
    .filter(({ thread }) => thread.status !== "archived" && thread.id !== "t0" && !hiddenIds.has(thread.id))
    .sort((left, right) => previewAgeMinutes(left.thread.time) - previewAgeMinutes(right.thread.time))
    .slice(0, RECENT_LIMIT)
    .map(({ project, thread }) => {
      const tone = previewStatus(thread, lang);
      return {
        id: thread.id,
        title: thread.title,
        project,
        time: thread.time,
        status: tone.status,
        statusLabel: tone.statusLabel,
        previewThreadId: thread.id,
      };
    });
}

export function relativeTime(iso: string, now = Date.now(), lang: "zh" | "en" = "zh"): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return lang === "en" ? "just now" : "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d`;
  return new Date(then).toLocaleDateString(lang === "en" ? "en-US" : "zh-CN");
}

export function collectHistoryRecents(input: {
  readonly entries: readonly SessionHistoryEntry[];
  readonly projectName: string;
  readonly runningSessionId?: string;
  readonly waitingSessionId?: string;
  readonly now?: number;
  readonly lang?: "zh" | "en";
}): EmptyRecentRow[] {
  const lang = input.lang ?? "zh";
  return input.entries
    .filter((entry) => entry.status !== "archived")
    .slice()
    .sort((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt))
    .slice(0, RECENT_LIMIT)
    .map((entry) => {
      const running = input.runningSessionId !== undefined && entry.sessionId === input.runningSessionId;
      const waiting = input.waitingSessionId !== undefined && entry.sessionId === input.waitingSessionId;
      const status: EmptyRecentStatus = running ? "running" : waiting ? "approval" : "idle";
      const statusLabel = status === "running"
        ? (lang === "en" ? "Running" : "运行中")
        : status === "approval"
          ? (lang === "en" ? "Waiting for approval" : "等待审批")
          : (lang === "en" ? "Idle" : "空闲");
      return {
        id: entry.historyId,
        title: entry.title,
        project: input.projectName,
        time: relativeTime(entry.lastActiveAt, input.now, lang),
        status,
        statusLabel,
        entry,
      };
    });
}
