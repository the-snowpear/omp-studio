import type { ForeignSessionSummary } from "@omp-studio/client-contract";
export const PREVIEW_FOREIGN_SESSIONS: ForeignSessionSummary[] = [
 {source:"claude",sourceId:"demo-claude",title:"检查 SessionChanges 的重命名处理",directoryName:"omp-studio",cwdExists:true,modifiedAt:"2026-09-18T08:00:00Z",messageCount:4},
 {source:"codex",sourceId:"demo-codex",title:"验证会话恢复后的 diff",directoryName:"omp-studio",cwdExists:true,modifiedAt:"2026-09-18T08:30:00Z",messageCount:6},
];
export const PREVIEW_IMPORT_TEXT = "user: 请检查重命名文件的 diff 展示。\n\nassistant: 已定位会话变更投影，接下来覆盖恢复后的显示。";

export const PREVIEW_MODEL_MENTIONS = [{ agent:"m1", selector:"deepseek/deepseek-chat", name:"DeepSeek" }];
