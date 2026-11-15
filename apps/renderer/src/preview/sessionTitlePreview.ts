import type { SessionTitleRow } from "@omp-studio/studio-protocol";
const titles: Record<string, { code: string; emoji: string; nf?: string }> = {
  "跟踪上游 pi-web 更新到 omp-web": {
    code: "SYNC",
    emoji: "🧩",
    nf: "nf-md-source_merge",
  },
  "Track upstream pi-web updates to omp-web": {
    code: "SYNC",
    emoji: "🧩",
    nf: "nf-md-source_merge",
  },
  "Mermaid 渲染优化与全屏缩放拖拽": { code: "CHART", emoji: "📊" },
  "Mermaid rendering optimization and fullscreen zoom & pan": { code: "CHART", emoji: "📊" },
  "Audit and fix OSS repository issues": { code: "AUDIT", emoji: "🔎" },
  "修复 Git Bash 路径未找到问题": { code: "BASH", emoji: "🛠️" },
  "Fix Git Bash path not found issue": { code: "BASH", emoji: "🛠️" },
  "重构 session 存储层 (session)": { code: "STORE", emoji: "🗄️" },
  "Refactor session storage layer (session)": { code: "STORE", emoji: "🗄️" },
};
export function previewSessionTitle(
  sessionId: string,
  title: string,
): SessionTitleRow | undefined {
  const card = titles[title];
  return card
    ? { sessionId, title, state: "available", source: "auto", card }
    : undefined;
}
