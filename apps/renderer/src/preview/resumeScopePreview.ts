import type { SessionResumeRow } from "@omp-studio/studio-protocol";
export const PREVIEW_RESUME_SESSIONS: SessionResumeRow[] = [
  { sessionId: "demo-resume-current", title: "会话恢复与附件检查", modifiedAt: "2026-10-28T02:20:00Z", currentDirectory: true, directoryName: "omp-studio", messageCount: 18, status: "complete", firstMessage: "检查恢复会话后，附件是否仍然能在 Composer 和对话流中正确显示。", conversationExcerpt: "已完成会话恢复与附件回放检查。图片引用与原始消息顺序一致，恢复后可以继续对话。\n\n下一步覆盖跨工作区恢复的场景。" },
  { sessionId: "demo-resume-worktree", title: "迁移后的继续副本", modifiedAt: "2026-10-28T02:15:00Z", currentDirectory: false, continuationOf: "demo-resume-old", directoryName: "omp-studio-session-storage", messageCount: 12, status: "interrupted", firstMessage: "把会话存储层的修改移到独立 Worktree，继续检查恢复后的 diff。", conversationExcerpt: "会话已迁移到关联 Worktree，原有对话与代码检查点已保留。接下来验证迁移后的继续副本和目标工作区绑定。" },
];
