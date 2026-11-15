import type { ForeignSessionSummary, WorkspaceRecord } from "@omp-studio/client-contract";
import { isZh } from "../i18n";

export function getPreviewForeignSessions(zh = isZh()): ForeignSessionSummary[] {
  return [
    { source: "claude", sourceId: "demo-claude", title: zh ? "检查 SessionChanges 的重命名处理" : "Review SessionChanges rename handling", directoryName: "omp-studio", cwdExists: true, modifiedAt: "2026-09-18T08:00:00Z", messageCount: 4, firstMessage: zh ? "请检查重命名文件的 diff 展示。" : "Please check diff rendering for renamed files." },
    { source: "claude", sourceId: "demo-claude-moved", title: zh ? "迁移工作区后的会话恢复" : "Resume session after moving workspace", directoryName: "omp-studio-legacy", cwdExists: false, modifiedAt: "2026-09-17T08:00:00Z", messageCount: 8, firstMessage: zh ? "保留原有对话，把后续工作移到当前工作区。" : "Keep the original conversation and move follow-up work to the current workspace." },
    { source: "codex", sourceId: "demo-codex", title: zh ? "验证会话恢复后的 diff" : "Verify diff after session resume", directoryName: "omp-studio", cwdExists: true, modifiedAt: "2026-09-18T08:30:00Z", messageCount: 6, firstMessage: zh ? "验证恢复后的文件变更与代码检查点。" : "Verify file changes and code checkpoints after resuming." },
  ];
}

export function getPreviewImportText(zh = isZh()): string {
  return zh
    ? "user: 请检查重命名文件的 diff 展示。\n\nassistant: 已定位会话变更投影，接下来覆盖恢复后的显示。"
    : "user: Please check diff rendering for renamed files.\n\nassistant: Located the session change projection; next I'll cover post-resume display.";
}

export function getPreviewImportPreviews(zh = isZh()): Record<string, string> {
  return {
    "demo-claude": getPreviewImportText(zh),
    "demo-claude-moved": zh
      ? "user: 保留原有对话，把后续工作移到当前工作区。\n\nassistant: 原工作目录已迁移。导入时选择现有工作区，可以保留对话并继续处理会话恢复。"
      : "user: Keep the original conversation and move follow-up work to the current workspace.\n\nassistant: The original working directory moved. Choose an existing workspace on import to preserve history and continue resuming.",
    "demo-codex": zh
      ? "user: 验证恢复后的文件变更与代码检查点。\n\nassistant: 恢复后已对齐文件变更和检查点。接下来验证工作区切换与 diff 的显示。"
      : "user: Verify file changes and code checkpoints after resuming.\n\nassistant: Aligned file changes and checkpoints after resume. Next I'll verify workspace switching and diff rendering.",
  };
}

export const PREVIEW_FOREIGN_SESSIONS: ForeignSessionSummary[] = getPreviewForeignSessions();
export const PREVIEW_IMPORT_TEXT = getPreviewImportText();
export const PREVIEW_IMPORT_PREVIEWS: Record<string, string> = getPreviewImportPreviews();
export const PREVIEW_IMPORT_WORKSPACES: readonly WorkspaceRecord[] = [
  { workspaceId: "demo-import-workspace" as never, name: "omp-studio", lastOpenedAt: "2026-09-18T08:00:00Z", active: true },
  { workspaceId: "demo-import-worktree" as never, name: "omp-studio-session-storage", lastOpenedAt: "2026-09-17T08:00:00Z", active: false },
];

export const PREVIEW_MODEL_MENTIONS = [{ agent: "m1", selector: "deepseek/deepseek-chat", name: "DeepSeek" }];
