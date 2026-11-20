import type { SessionResumeRow } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

/** Demo row whose recorded worktree no longer exists, so resume asks for an execution workspace. */
export const PREVIEW_RESUME_STRANDED_ID = "demo-resume-stranded";
export const PREVIEW_RESUME_STRANDED_CWD = "D:/work/omp-studio-wt/dictation-policy";

export function getPreviewResumeSessions(zh = isZh()): SessionResumeRow[] {
  const stranded: SessionResumeRow = {
    sessionId: PREVIEW_RESUME_STRANDED_ID, modifiedAt: "2026-10-27T09:40:00Z", backend: "ovnfs", sourceDirectory: "/workspace/studio", currentDirectory: false, directoryName: "dictation-policy", messageCount: 9, status: "interrupted",
    title: zh ? "语音 Provider 政策核对" : "Dictation provider policy check",
    firstMessage: zh ? "核对 models.offline 开启后语音转写是否只走当前 Provider。" : "Check that dictation only uses the session provider while models.offline is on.",
    conversationExcerpt: zh ? "已确认转写模型不在当前 Provider 时会阻止上传。该 Worktree 已在本机清理，恢复时需要选择继续执行的工作区。" : "Confirmed uploads are blocked when the dictation model is on another provider. This worktree was cleaned up locally, so resuming asks where to continue.",
  };
  const rows: SessionResumeRow[] = zh
    ? [
        { sessionId: "demo-resume-current", title: "会话恢复与附件检查", modifiedAt: "2026-10-28T02:20:00Z", currentDirectory: true, directoryName: "omp-studio", messageCount: 18, status: "complete", firstMessage: "检查恢复会话后，附件是否仍然能在 Composer 和对话流中正确显示。", conversationExcerpt: "已完成会话恢复与附件回放检查。图片引用与原始消息顺序一致，恢复后可以继续对话。\n\n下一步覆盖跨工作区恢复的场景。" },
        { sessionId: "demo-resume-worktree", title: "迁移后的继续副本", modifiedAt: "2026-10-28T02:15:00Z", currentDirectory: false, continuationOf: "demo-resume-old", directoryName: "omp-studio-session-storage", messageCount: 12, status: "interrupted", firstMessage: "把会话存储层的修改移到独立 Worktree，继续检查恢复后的 diff。", conversationExcerpt: "会话已迁移到关联 Worktree，原有对话与代码检查点已保留。接下来验证迁移后的继续副本和目标工作区绑定。" },
      ]
    : [
        { sessionId: "demo-resume-current", title: "Session resume & attachment check", modifiedAt: "2026-10-28T02:20:00Z", currentDirectory: true, directoryName: "omp-studio", messageCount: 18, status: "complete", firstMessage: "Verify whether attachments still appear properly in the Composer and conversation stream after resuming a session.", conversationExcerpt: "Completed session resume and attachment replay checks. Image references match the original message order, and the conversation can continue.\n\nNext step: cover cross-workspace resume scenarios." },
        { sessionId: "demo-resume-worktree", title: "Migrated continuation copy", modifiedAt: "2026-10-28T02:15:00Z", currentDirectory: false, continuationOf: "demo-resume-old", directoryName: "omp-studio-session-storage", messageCount: 12, status: "interrupted", firstMessage: "Move the session storage changes into an isolated worktree and inspect the restored diff.", conversationExcerpt: "Session migrated to the linked worktree with original conversation and code checkpoints preserved. Next, verify the continuation copy and destination workspace binding." },
      ];
  return [...rows, stranded];
}

export const PREVIEW_RESUME_SESSIONS: SessionResumeRow[] = getPreviewResumeSessions();
