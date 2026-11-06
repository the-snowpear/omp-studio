import type { GitHubComment, GitHubItem, GitHubRepository, QueryInput, QueryResult } from "@omp-studio/client-contract";
import type { GitHubQuery, GitHubSource } from "../git/githubSource";

const repositories: readonly GitHubRepository[] = [
  { remote: "origin", host: "github.com", ownerRepo: "studio/omp-studio", url: "https://github.com/studio/omp-studio" },
  { remote: "upstream", host: "github.com", ownerRepo: "upstream/omp-studio", url: "https://github.com/upstream/omp-studio" },
];
const updatedAt = "2026-11-01T10:30:00Z";
const items: readonly GitHubItem[] = [
  { kind: "issue", number: 42, title: "切换主题后 Mermaid 图表没有更新", body: "## 复现步骤\n1. 打开包含 Mermaid 图表的会话。\n2. 切换深色主题。\n\n图表应使用新的主题颜色，无需重新打开会话。", state: "open", author: "chen", labels: ["bug", "renderer"], commentCount: 2, updatedAt, url: "" },
  { kind: "issue", number: 38, title: "为 MCP 连接状态增加重试入口", body: "连接暂时中断后，希望可以直接在面板里重试，并保留当前设置。", state: "open", author: "lin", labels: ["enhancement"], commentCount: 0, updatedAt, url: "" },
  { kind: "issue", number: 31, title: "长文件名在更改列表中被截断", body: "文件路径的完整内容现在可以通过悬停查看。", state: "closed", author: "chen", labels: ["renderer"], commentCount: 1, updatedAt, url: "" },
  { kind: "pr", number: 47, title: "修复 Mermaid 主题切换并补充回归验证", body: "## 改动\n- 随界面主题更新 Mermaid 配置。\n- 保留图表内容。\n\nCloses #42", state: "open", author: "lin", labels: ["bug"], commentCount: 2, updatedAt, url: "", draft: false, headBranch: "fix/mermaid-theme", baseBranch: "main", headOid: "preview-head-47", reviewDecision: "REVIEW_REQUIRED", checkState: "SUCCESS", additions: 6, deletions: 3, changedFiles: 1 },
  { kind: "pr", number: 44, title: "完善模型与 MCP 入口", body: "整合模型选择与连接状态展示。", state: "open", author: "chen", labels: ["enhancement"], commentCount: 0, updatedAt, url: "", draft: true, headBranch: "feat/model-hub", baseBranch: "main", headOid: "preview-head-44", reviewDecision: "", checkState: "PENDING", additions: 92, deletions: 24, changedFiles: 5 },
  { kind: "pr", number: 39, title: "更新工作区文档", body: "补充工作区和分支使用说明。", state: "merged", author: "lin", labels: ["docs"], commentCount: 0, updatedAt, url: "", draft: false, headBranch: "docs/workspace", baseBranch: "main", headOid: "preview-head-39", reviewDecision: "APPROVED", checkState: "SUCCESS", additions: 12, deletions: 2, changedFiles: 1 },
];
const patch = "@@ -142,5 +142,5 @@\n const renderMermaid = useCallback(async (theme: MermaidTheme) => {\n-  const codeTheme = getCodeTheme() as string;\n+  const codeTheme = getCodeTheme() as const;\n   mermaid.initialize({\n-    theme: codeTheme,\n+    theme: codeTheme satisfies MermaidTheme,\n   });";

/** UI-only fixtures; this source never calls a client or changes runtime state. */
export const previewGithubSource: GitHubSource = {
  async query<K extends GitHubQuery>(name: K, input: QueryInput<K>): Promise<QueryResult<K>> {
    const args = input as QueryInput<"github.items.list"> & { number?: number; path?: string; headOid?: string };
    const repository = repositories.find(repo => repo.remote === args.remote) ?? repositories[0]!;
    const rows = items.map(row => ({ ...row, url: `${repository.url}/${row.kind === "pr" ? "pull" : "issues"}/${row.number}` }));
    const row = rows.find(row => row.number === args.number) ?? rows[0]!;
    const comments: GitHubComment[] = row.commentCount ? [
      { id: "comment:1", kind: "comment", author: "chen", body: "可以在深色和浅色主题间切换，确认图表颜色跟随更新。", createdAt: updatedAt, url: `${row.url}#issuecomment-1` },
      { id: "inline:2", kind: row.kind === "pr" ? "inline" : "comment", author: "lin", body: "这里保留了类型检查，重新打开会话后也使用当前主题。", createdAt: updatedAt, url: `${row.url}#discussion-2`, ...(row.kind === "pr" ? { path: "components/MermaidBlock.tsx", line: 146 } : {}) },
    ] : [];
    const checks = row.kind === "pr" ? [{ name: "renderer", state: "SUCCESS", bucket: "pass" as const }] : [];
    let result: unknown;
    switch (name) {
      case "github.repositories.list": result = { workspaceId: args.workspaceId, repositories }; break;
      case "github.auth.get": result = { available: true, authenticated: true, account: "chen", host: "github.com" }; break;
      case "github.items.list": {
        const head = /^head:(\S+)$/u.exec(args.search ?? "")?.[1];
        const filtered = rows.filter(item => item.kind === args.kind && (!args.state || args.state === "all" || item.state === args.state)
          && (!args.search || (head ? item.headBranch === head : `${item.number} ${item.title} ${item.body}`.toLowerCase().includes(args.search.toLowerCase())))
          && (!args.label || item.labels.includes(args.label)) && (!args.assignedToMe || item.number === 42 || item.number === 47)
          && (!args.reviewRequested || item.number === 47));
        result = { repository, items: filtered, totalCount: filtered.length }; break;
      }
      case "github.items.get": result = { repository, item: row, checks }; break;
      case "github.discussion.list": result = { comments: comments.slice(0, row.commentCount) }; break;
      case "github.pr.files": result = { headOid: row.headOid, files: [{ path: "components/MermaidBlock.tsx", status: "modified", additions: 6, deletions: 3 }] }; break;
      case "github.pr.diff": result = { headOid: row.headOid, path: args.path, patch }; break;
    }
    return result as QueryResult<K>;
  },
};
