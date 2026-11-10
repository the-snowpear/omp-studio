import type { ForeignSessionSummary, WorkspaceRecord } from "@omp-studio/client-contract";
export const PREVIEW_FOREIGN_SESSIONS: ForeignSessionSummary[] = [
 {source:"claude",sourceId:"demo-claude",title:"检查 SessionChanges 的重命名处理",directoryName:"omp-studio",cwdExists:true,modifiedAt:"2026-09-18T08:00:00Z",messageCount:4,firstMessage:"请检查重命名文件的 diff 展示。"},
 {source:"claude",sourceId:"demo-claude-moved",title:"迁移工作区后的会话恢复",directoryName:"omp-studio-legacy",cwdExists:false,modifiedAt:"2026-09-17T08:00:00Z",messageCount:8,firstMessage:"保留原有对话，把后续工作移到当前工作区。"},
 {source:"codex",sourceId:"demo-codex",title:"验证会话恢复后的 diff",directoryName:"omp-studio",cwdExists:true,modifiedAt:"2026-09-18T08:30:00Z",messageCount:6,firstMessage:"验证恢复后的文件变更与代码检查点。"},
];
export const PREVIEW_IMPORT_TEXT = "user: 请检查重命名文件的 diff 展示。\n\nassistant: 已定位会话变更投影，接下来覆盖恢复后的显示。";
export const PREVIEW_IMPORT_PREVIEWS: Record<string, string> = {
 "demo-claude": PREVIEW_IMPORT_TEXT,
 "demo-claude-moved": "user: 保留原有对话，把后续工作移到当前工作区。\n\nassistant: 原工作目录已迁移。导入时选择现有工作区，可以保留对话并继续处理会话恢复。",
 "demo-codex": "user: 验证恢复后的文件变更与代码检查点。\n\nassistant: 恢复后已对齐文件变更和检查点。接下来验证工作区切换与 diff 的显示。",
};
export const PREVIEW_IMPORT_WORKSPACES: readonly WorkspaceRecord[] = [
 { workspaceId: "demo-import-workspace" as never, name: "omp-studio", lastOpenedAt: "2026-09-18T08:00:00Z", active: true },
 { workspaceId: "demo-import-worktree" as never, name: "omp-studio-session-storage", lastOpenedAt: "2026-09-17T08:00:00Z", active: false },
];

export const PREVIEW_MODEL_MENTIONS = [{ agent:"m1", selector:"deepseek/deepseek-chat", name:"DeepSeek" }];
