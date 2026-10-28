import type { SessionResumeRow } from "@omp-studio/studio-protocol";
export const PREVIEW_RESUME_SESSIONS: SessionResumeRow[] = [
  { sessionId: "demo-resume-current", title: "会话恢复与附件检查", modifiedAt: "2026-10-28 10:20", currentDirectory: true },
  { sessionId: "demo-resume-worktree", title: "迁移后的继续副本", modifiedAt: "2026-10-28 10:15", currentDirectory: false, continuationOf: "demo-resume-old" },
];
