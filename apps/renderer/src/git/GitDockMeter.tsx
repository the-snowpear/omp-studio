import { useMemo } from "react";
import type { GitRepositoryReadModel } from "@omp-studio/client-contract";
import { DockPanelMeter, type PanelStatusCount, type PanelStatusMeter } from "../dock/panelMeters";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { useGitWorkspace } from "./GitWorkspaceContext";
import { combineGitFileState, GIT_STATUS_META, type TreeGitStatus } from "./treeStatus";

/** 折叠卡摘要：状态字母与目录树徽标一致，颜色沿用 git 状态 token。 */
const STATUS_ORDER: readonly TreeGitStatus[] = ["conflicted", "modified", "added", "deleted", "untracked", "renamed"];
/** 280px 工具区只放得下 4 组；其余状态留给悬停明细，标题仍报总文件数。 */
const SUMMARY_LIMIT = 4;
const STATUS_COLOR: Readonly<Record<TreeGitStatus, string>> = {
  conflicted: "var(--git-conflict)",
  modified: "var(--git-modified)",
  added: "var(--git-added)",
  deleted: "var(--git-deleted)",
  renamed: "var(--git-renamed)",
  untracked: "var(--git-untracked)",
};
const STATUS_TEXT: Readonly<Record<TreeGitStatus, readonly [string, string]>> = {
  conflicted: ["冲突", "conflicted"],
  modified: ["已修改", "modified"],
  added: ["新增", "added"],
  deleted: ["已删除", "deleted"],
  renamed: ["已重命名", "renamed"],
  untracked: ["未跟踪", "untracked"],
};

export type GitDockMeterInput = {
  repository: GitRepositoryReadModel | undefined;
  loading: boolean;
  error: string | undefined;
  preview: boolean;
  marks: boolean;
  zh: boolean;
};

/** 折叠的 Git 卡仍要回答「这里还欠多少东西」：状态计数 + 领先/落后。 */
export function buildGitDockMeter({ repository, loading, error, preview, marks, zh }: GitDockMeterInput): PanelStatusMeter {
  const demo = preview && marks ? (zh ? "演示" : "Demo") : "";
  if (repository === undefined || !repository.isRepository) {
    const emptyLabel = repository === undefined
      ? error !== undefined ? (zh ? "不可用" : "Unavailable") : loading ? (zh ? "读取中" : "Loading") : (zh ? "未连接" : "Not connected")
      : repository.unavailableReason ?? (zh ? "非 Git 仓库" : "Not a repository");
    const label = [emptyLabel, demo].filter(Boolean).join(" · ");
    return {
      kind: "status", total: 0, counts: [], emptyLabel, stale: error !== undefined,
      tone: error === undefined ? "normal" : "danger", label,
      detail: [label, error].filter(Boolean).join("\n"),
    };
  }

  const tally = new Map<TreeGitStatus, number>();
  let total = 0;
  for (const change of repository.changes) {
    const status = combineGitFileState(change);
    if (status === undefined) continue;
    total += 1;
    tally.set(status, (tally.get(status) ?? 0) + 1);
  }
  const counts: PanelStatusCount[] = [];
  const summary: string[] = [];
  for (const status of STATUS_ORDER) {
    const count = tally.get(status) ?? 0;
    if (count === 0) continue;
    // 只有前几组进卡片头，完整拆分在 detail 里；计数顺序按「需要立刻处理」排。
    if (counts.length < SUMMARY_LIMIT) counts.push({ id: status, count, color: STATUS_COLOR[status], label: GIT_STATUS_META[status].letter });
    summary.push(`${count} ${STATUS_TEXT[status][zh ? 0 : 1]}`);
  }

  const branch = repository.branch ?? (repository.detached ? "detached HEAD" : undefined);
  const sync = [
    repository.ahead > 0 ? `↑${repository.ahead}` : undefined,
    repository.behind > 0 ? `↓${repository.behind}` : undefined,
    repository.stashCount > 0 ? `⚑${repository.stashCount}` : undefined,
  ].filter(Boolean).join(" ");
  const emptyLabel = zh ? "工作区干净" : "Clean";
  const label = [
    total === 0 ? emptyLabel : zh ? `${total} 个文件改动` : `${total} changed ${total === 1 ? "file" : "files"}`,
    sync, demo,
  ].filter(Boolean).join(" · ");
  return {
    kind: "status", total, counts, emptyLabel, ...(sync ? { note: sync } : {}), stale: false,
    tone: (tally.get("conflicted") ?? 0) > 0 ? "danger" : total > 0 ? "warning" : "normal",
    label,
    detail: [
      branch === undefined ? undefined : `${branch}${sync ? ` · ${sync}` : ""}`,
      total === 0 ? emptyLabel : summary.join(zh ? "、" : ", "),
      repository.operation === undefined ? undefined : zh ? `正在进行 ${repository.operation}` : `${repository.operation} in progress`,
      error,
    ].filter(Boolean).join("\n"),
  };
}

/** 挂在 GitWorkspaceProvider 里：卡片折叠时正文不挂载，摘要仍要跟着仓库状态走。 */
export function GitDockMeter() {
  const { repository, loading, error } = useGitWorkspace();
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const meter = useMemo(() => buildGitDockMeter({ repository, loading, error, preview, marks, zh }),
    [repository, loading, error, preview, marks, zh]);
  return <><DockPanelMeter id="git" value={meter} /><DockPanelMeter id="git-quick" value={meter} /></>;
}
