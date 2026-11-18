import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  GitBranchListReadModel,
  GitCommitChangesReadModel,
  GitCommitDiffReadModel,
  GitDiffReadModel,
  GitDiffTarget,
  GitHubAuthReadModel,
  GitLogListReadModel,
  GitRemoteListReadModel,
  GitWorktreeListReadModel,
  StudioClient,
  WorkspaceId,
} from "@omp-studio/client-contract";

import { hostErrorMessage } from "../hostError";
import { Icon } from "../icons";
import { fileTypeOf, iconNameFor, isSensitive } from "../explorer-types";
import { useI18n } from "../i18n";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { DiffDisplayMode } from "../conversation/ChangesPanel";
import { splitDisplayPath } from "../conversation/toolMeta";

import { GitCommitGraph } from "./GitCommitGraph";
import { GitDiffPlaceholder, GitDiffResizer, useGitDiffHeight } from "./GitDiffResizer";
import { GitPatch } from "./GitPatch";
import { GitMoreActionsMenu } from "./GitMoreActionsMenu";
import { GitPanelSplit } from "./GitPanelSplit";
import { GitTip } from "./GitTip";
import { SelectiveCommitButton } from "../commit/SelectiveCommitLauncher";
import { readGitGraphLayout, writeGitGraphLayout } from "./gitGraphMemory";
import { useGitWorkspace } from "./GitWorkspaceContext";

export { useGitRepository } from "./useGitRepository";

function ask(label: string, initial = ""): string | undefined {
  const value = window.prompt(label, initial)?.trim();
  return value ? value : undefined;
}

/** Electron 渲染进程不支持 window.prompt（electron/electron#472，官方明确不实现）：
    这些靠 prompt 收集文本输入的操作在桌面端拿不到任何输入，点击后只会静默无反应。
    Host 侧操作本身都已实现，等应用内输入对话框接入后从此清单移除即可恢复。
    选中时先给出明确提示，而不是假装可用。 */
const PENDING_INPUT_PAIRS: Record<string, readonly [string, string]> = {
  "branch.create": ["新建并切换分支", "Create & switch branch"],
  "branch.switch": ["切换分支", "Switch branch"],
  "branch.rename": ["重命名当前分支", "Rename current branch"],
  "branch.delete": ["删除分支", "Delete branch"],
  "worktree.create": ["新建 Worktree", "Create worktree"],
  "worktree.lock": ["锁定 Worktree", "Lock worktree"],
  "worktree.unlock": ["解锁 Worktree", "Unlock worktree"],
  "worktree.remove": ["移除 Worktree", "Remove worktree"],
  merge: ["Merge", "Merge"],
  rebase: ["Rebase", "Rebase"],
  "cherry-pick": ["Cherry-pick", "Cherry-pick"],
  revert: ["Revert", "Revert"],
  reset: ["Hard reset", "Hard reset"],
  "tag.create": ["创建 Tag", "Create tag"],
  "tag.delete": ["删除 Tag", "Delete tag"],
  "push.force": ["Force-with-lease Push", "Force-with-lease Push"],
  "remote.add": ["添加 Remote", "Add remote"],
  "remote.set": ["修改 Remote URL", "Edit remote URL"],
  "remote.remove": ["移除 Remote", "Remove remote"],
  "pr.create": ["创建 PR", "Create PR"],
  "pr.edit": ["编辑 PR", "Edit PR"],
  "pr.comment": ["评论 PR", "Comment on PR"],
  "pr.review": ["Review PR", "Review PR"],
  "pr.merge": ["合并 PR", "Merge PR"],
  "pr.update": ["更新 PR 分支", "Update PR branch"],
  "pr.close": ["关闭 PR", "Close PR"],
  "pr.reopen": ["重新打开 PR", "Reopen PR"],
};

function pendingInputLabel(value: string, zh: boolean): string | undefined {
  const pair = PENDING_INPUT_PAIRS[value];
  return pair ? (zh ? pair[0] : pair[1]) : undefined;
};

function statusLabel(index: string, worktree: string, t: (k: string) => string): string {
  if (index === "conflicted" || worktree === "conflicted") return t("git.conflict");
  if (index !== "unmodified" && worktree !== "unmodified") return t("git.stagedAndWorking");
  if (index !== "unmodified") return t("git.staged");
  return worktree === "untracked" ? t("git.untracked") : t("git.workingTree");
}

export function GitStatusPanel({ client, workspaceId, focusPath, focusTarget, focusKey, view, visible = true }: { readonly client: StudioClient; readonly workspaceId?: WorkspaceId; readonly focusPath?: string; readonly focusTarget?: GitDiffTarget; readonly focusKey?: number; readonly view?: "changes" | "history"; readonly visible?: boolean }) {
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const zhRef = useRef(zh);
  zhRef.current = zh;
  const active = visible !== false;
  const { syncRevision } = useExecutionTarget();
  const repositoryHook = useGitWorkspace();
  const repository = repositoryHook.repository;
  const [branches, setBranches] = useState<GitBranchListReadModel>();
  const [worktrees, setWorktrees] = useState<GitWorktreeListReadModel>();
  const [remotes, setRemotes] = useState<GitRemoteListReadModel>();
  const [githubAuth, setGithubAuth] = useState<GitHubAuthReadModel>();
  const [selected, setSelected] = useState<{ path: string; target: GitDiffTarget }>();
  const [diff, setDiff] = useState<GitDiffReadModel>();
  const { draft: commitMessage, setDraft: setCommitMessage, busy, notice, setNotice, activeRequest, execute, executeGithub, cancel: cancelActive } = repositoryHook;
  const [graphLayout, setGraphLayout] = useState(readGitGraphLayout);
  const graphVisible = view ? view === "history" : graphLayout.open;
  const historyActive = active && graphVisible;
  const [diffHeight, setDiffHeight] = useGitDiffHeight();
  const [splitDiff, setSplitDiff] = useState(false);
  const [log, setLog] = useState<GitLogListReadModel>();
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string>();
  const [logLimit, setLogLimit] = useState(80);
  const [selectedCommit, setSelectedCommit] = useState<string>();
  const [commitChanges, setCommitChanges] = useState<GitCommitChangesReadModel>();
  const [changesLoading, setChangesLoading] = useState(false);
  const [selectedCommitPath, setSelectedCommitPath] = useState<string>();
  const [commitDiff, setCommitDiff] = useState<GitCommitDiffReadModel>();
  const detailsGeneration = useRef(0);
  const logGeneration = useRef(0);
  const detailsDirty = useRef(true);
  const logDirty = useRef(true);

  const refreshDetails = useCallback(async () => {
    const requestGeneration = ++detailsGeneration.current;
    if (workspaceId === undefined) {
      setBranches(undefined);
      setWorktrees(undefined);
      setRemotes(undefined);
      setGithubAuth(undefined);
      return;
    }
    const results = await Promise.allSettled([
      client.query("git.branches.list", { workspaceId }),
      client.query("git.worktrees.list", { workspaceId }),
      client.query("git.remotes.list", { workspaceId }),
      client.query("github.auth.get", { workspaceId }),
    ]);
    if (requestGeneration !== detailsGeneration.current) return;
    if (results[0].status === "fulfilled") setBranches(results[0].value);
    else setBranches(undefined);
    if (results[1].status === "fulfilled") setWorktrees(results[1].value);
    else setWorktrees(undefined);
    if (results[2].status === "fulfilled") setRemotes(results[2].value);
    else setRemotes(undefined);
    if (results[3].status === "fulfilled") setGithubAuth(results[3].value);
    else setGithubAuth(undefined);
  }, [client, workspaceId]);

  const persistGraphLayout = useCallback((next: typeof graphLayout) => {
    setGraphLayout(next);
    writeGitGraphLayout(next);
  }, []);

  const refreshLog = useCallback(async () => {
    const requestGeneration = ++logGeneration.current;
    if (workspaceId === undefined) {
      setLog(undefined);
      setLogError(undefined);
      setLogLoading(false);
      return;
    }
    setLogLoading(true);
    try {
      const value = await client.query("git.log.list", { workspaceId, limit: logLimit });
      if (requestGeneration !== logGeneration.current) return;
      setLog(value);
      setLogError(undefined);
    } catch (cause) {
      if (requestGeneration !== logGeneration.current) return;
      setLogError(hostErrorMessage(cause, zhRef.current ? "无法读取提交历史" : "Cannot read commit history"));
    } finally {
      if (requestGeneration === logGeneration.current) setLogLoading(false);
    }
  }, [client, logLimit, workspaceId]);

  const refreshAll = repositoryHook.refresh;

  useEffect(() => {
    detailsGeneration.current += 1;
    logGeneration.current += 1;
    detailsDirty.current = true;
    logDirty.current = true;
    setBranches(undefined);
    setWorktrees(undefined);
    setRemotes(undefined);
    setGithubAuth(undefined);
    setLog(undefined);
    setLogError(undefined);
    setLogLoading(false);
    setSelected(undefined);
    setDiff(undefined);
    setSelectedCommit(undefined);
    setCommitChanges(undefined);
    setSelectedCommitPath(undefined);
    setCommitDiff(undefined);
  }, [workspaceId]);

  useEffect(() => {
    detailsDirty.current = true;
    logDirty.current = true;
  }, [syncRevision, repositoryHook.revision, repository?.revision, repository?.headOid]);

  useEffect(() => {
    logDirty.current = true;
  }, [logLimit]);

  useEffect(() => {
    if (!active) return;
    if (!detailsDirty.current) return;
    detailsDirty.current = false;
    void refreshDetails();
    return () => { detailsGeneration.current += 1; };
  }, [active, refreshDetails, syncRevision, repositoryHook.revision, repository?.revision]);

  useEffect(() => {
    if (!historyActive || workspaceId === undefined) return;
    if (logDirty.current || log === undefined) {
      logDirty.current = false;
      void refreshLog();
    }
    const unsubscribe = client.subscribe({ scope: "all" }, (event) => {
      if (event.kind === "git.repository.changed" && event.repository.workspaceId === workspaceId) {
        logDirty.current = false;
        void refreshLog();
      }
    });
    return () => {
      logGeneration.current += 1;
      unsubscribe();
    };
  }, [client, historyActive, log === undefined, refreshLog, workspaceId, syncRevision, repositoryHook.revision, repository?.revision, repository?.headOid, logLimit]);

  useEffect(() => {
    if (!active || workspaceId === undefined || selectedCommit === undefined) {
      if (selectedCommit === undefined || workspaceId === undefined) setCommitChanges(undefined);
      return;
    }
    let cancelled = false;
    setChangesLoading(true);
    void client.query("git.commit.changes", { workspaceId, oid: selectedCommit }).then(
      (value) => { if (!cancelled) { setCommitChanges(value); setChangesLoading(false); } },
      (cause) => { if (!cancelled) { setCommitChanges(undefined); setChangesLoading(false); setNotice(hostErrorMessage(cause, zhRef.current ? "无法读取提交文件" : "Cannot read commit files")); } },
    );
    return () => { cancelled = true; };
  }, [active, client, selectedCommit, workspaceId]);

  useEffect(() => {
    if (!active || workspaceId === undefined || selectedCommit === undefined || selectedCommitPath === undefined) {
      if (selectedCommit === undefined || selectedCommitPath === undefined || workspaceId === undefined) setCommitDiff(undefined);
      return;
    }
    let cancelled = false;
    setCommitDiff(undefined);
    void client.query("git.commit.diff", { workspaceId, oid: selectedCommit, path: selectedCommitPath }).then(
      (value) => { if (!cancelled) setCommitDiff(value); },
      (cause) => { if (!cancelled) { setCommitDiff(undefined); setNotice(hostErrorMessage(cause, zhRef.current ? "无法读取提交 Diff" : "Cannot read commit diff")); } },
    );
    return () => { cancelled = true; };
  }, [active, client, selectedCommit, selectedCommitPath, workspaceId]);

  useEffect(() => {
    if (!selected || !repository) return;
    const inWorking = repository.changes.some((change) => change.path === selected.path && change.worktree !== "unmodified");
    const inStaged = repository.changes.some((change) => change.path === selected.path && change.index !== "unmodified");
    if (selected.target === "working" && !inWorking) {
      setSelected(inStaged ? { path: selected.path, target: "staged" } : undefined);
    } else if (selected.target === "staged" && !inStaged) {
      setSelected(inWorking ? { path: selected.path, target: "working" } : undefined);
    }
  }, [repository, selected]);

  useEffect(() => {
    if (workspaceId === undefined || selected === undefined) {
      setDiff(undefined);
      return;
    }
    if (!active) return;
    let cancelled = false;
    setDiff(undefined);
    void client.query("git.diff.get", { workspaceId, path: selected.path, target: selected.target }).then(
      (value) => { if (!cancelled) setDiff(value); },
      (cause) => { if (!cancelled) { setDiff(undefined); setNotice(hostErrorMessage(cause, zhRef.current ? "无法读取 Diff" : "Cannot read diff")); } },
    );
    return () => { cancelled = true; };
  }, [active, client, selected, workspaceId, syncRevision, repositoryHook.revision, repository?.revision]);

  const runAdvanced = (value: string) => {
    if (!repository) return;
    const pending = pendingInputLabel(value, zh);
    if (pending !== undefined) {
      setNotice(zh ? `${pending}：该功能待后续实现` : `${pending}: coming soon`);
      return;
    }
    switch (value) {
      case "branch.create": { const name = ask(zh ? "新分支名称" : "New branch name"); if (name) void execute({ kind: "branch.create", name, checkout: true }); break; }
      case "branch.switch": { const name = ask(zh ? "切换到分支" : "Switch to branch", branches?.branches.find((item) => !item.remote && !item.current)?.name); if (name) void execute({ kind: "branch.switch", name }); break; }
      case "branch.rename": { const newName = ask(zh ? "新的分支名称" : "New branch name", repository.branch); if (newName) void execute({ kind: "branch.rename", newName }); break; }
      case "branch.delete": { const name = ask(zh ? "删除本地分支" : "Delete local branch"); if (name && window.confirm(zh ? `确认删除分支 ${name}？` : `Delete branch ${name}?`)) void execute({ kind: "branch.delete", name, ...(repository.revision === undefined ? {} : { expectedRevision: repository.revision }) }); break; }
      case "worktree.root": void execute({ kind: "worktree.pickRoot" }); break;
      case "worktree.create": { const branch = ask(zh ? "Worktree 分支名" : "Worktree branch name"); if (branch) void execute({ kind: "worktree.create", branch, createBranch: true }); break; }
      case "worktree.lock": { const name = ask(zh ? "锁定哪个 Worktree？" : "Lock which worktree?", worktrees?.worktrees.find((item) => !item.current)?.name); const target = worktrees?.worktrees.find((item) => item.name === name); if (target) void execute({ kind: "worktree.lock", worktreeId: target.worktreeId }); else if (name) setNotice(zh ? "找不到该 Worktree" : "Worktree not found"); break; }
      case "worktree.unlock": { const name = ask(zh ? "解锁哪个 Worktree？" : "Unlock which worktree?", worktrees?.worktrees.find((item) => item.locked)?.name); const target = worktrees?.worktrees.find((item) => item.name === name); if (target) void execute({ kind: "worktree.unlock", worktreeId: target.worktreeId }); else if (name) setNotice(zh ? "找不到该 Worktree" : "Worktree not found"); break; }
      case "worktree.remove": { const name = ask(zh ? "移除哪个 Worktree？" : "Remove which worktree?", worktrees?.worktrees.find((item) => !item.current)?.name); const target = worktrees?.worktrees.find((item) => item.name === name); if (target && window.confirm(zh ? `确认移除 Worktree ${target.name}？` : `Remove worktree ${target.name}?`)) void execute({ kind: "worktree.remove", worktreeId: target.worktreeId }); else if (name && !target) setNotice(zh ? "找不到该 Worktree" : "Worktree not found"); break; }
      case "worktree.prune": void execute({ kind: "worktree.prune" }); break;
      case "stash": void execute({ kind: "stash.push", includeUntracked: true }); break;
      case "stash.pop": if (window.confirm(zh ? "确认 Pop 最近一次 Stash？可能产生冲突。" : "Pop the latest stash? Conflicts may occur.")) void execute({ kind: "stash.apply", pop: true }); break;
      case "merge": { const ref = ask(zh ? "合并哪个分支或提交？" : "Merge branch or commit"); if (ref) void execute({ kind: "merge", ref }); break; }
      case "rebase": { const ref = ask(zh ? "Rebase 到哪个分支或提交？" : "Rebase onto branch or commit"); if (ref) void execute({ kind: "rebase", ref }); break; }
      case "cherry-pick": { const ref = ask(zh ? "Cherry-pick 提交" : "Cherry-pick commit"); if (ref) void execute({ kind: "cherry-pick", ref }); break; }
      case "revert": { const ref = ask(zh ? "Revert 提交" : "Revert commit"); if (ref) void execute({ kind: "revert", ref }); break; }
      case "reset": { const ref = ask(zh ? "Hard reset 到（会丢弃改动）" : "Hard reset to (discards changes)"); if (ref && repository.revision && window.confirm(zh ? `确认 hard reset 到 ${ref}？此操作不可撤销。` : `Hard reset to ${ref}? This cannot be undone.`)) void execute({ kind: "reset", mode: "hard", ref, expectedRevision: repository.revision }); break; }
      case "remote.add": { const name = ask(zh ? "Remote 名称" : "Remote name", "upstream"); const url = name ? ask("Remote URL") : undefined; if (name && url) void execute({ kind: "remote.add", name, url }); break; }
      case "remote.set": { const name = ask(zh ? "Remote 名称" : "Remote name", remotes?.remotes[0]?.name ?? "origin"); const url = name ? ask(zh ? "新的 Remote URL" : "New Remote URL") : undefined; if (name && url) void execute({ kind: "remote.setUrl", name, url }); break; }
      case "remote.remove": { const name = ask(zh ? "移除 Remote" : "Remove remote", remotes?.remotes[0]?.name); if (name && window.confirm(zh ? `确认移除 Remote ${name}？` : `Remove remote ${name}?`)) void execute({ kind: "remote.remove", name }); break; }
      case "pull.rebase": void execute({ kind: "pull", strategy: "rebase" }); break;
      case "pull.merge": void execute({ kind: "pull", strategy: "merge" }); break;
      case "push.force": { const remote = ask("Remote", "origin"); const branch = remote ? ask(zh ? "分支" : "Branch", repository.branch) : undefined; const expected = remote && branch ? branches?.branches.find((item) => item.remote && item.name === `${remote}/${branch}`)?.headOid : undefined; if (!expected) { setNotice(zh ? "无法取得远端分支 OID，已拒绝 force push" : "Cannot resolve remote branch OID; force push aborted"); break; } if (remote && branch && window.confirm(zh ? `确认使用 force-with-lease 推送 ${remote}/${branch}？` : `Push ${remote}/${branch} with --force-with-lease?`)) void execute({ kind: "push", remote, branch, forceWithLease: true, expectedRemoteOid: expected }); break; }
      case "tag.create": { const name = ask(zh ? "Tag 名称" : "Tag name"); const message = name ? window.prompt(zh ? "注释（留空创建轻量 Tag）" : "Annotation (leave empty for lightweight tag)", "") : null; if (name && message !== null) void execute({ kind: "tag.create", name, ...(message.trim() ? { message: message.trim() } : {}) }); break; }
      case "tag.delete": { const name = ask(zh ? "删除 Tag" : "Delete tag"); if (name && window.confirm(zh ? `确认删除本地 Tag ${name}？` : `Delete local tag ${name}?`)) void execute({ kind: "tag.delete", name }); break; }
      case "pr.create": { const title = ask(zh ? "PR 标题" : "PR title"); const base = title ? ask(zh ? "目标分支" : "Target branch", "main") : undefined; const body = base ? window.prompt(zh ? "PR 描述" : "PR description", "") : null; if (title && base && body !== null) void executeGithub({ kind: "pr.create", title, base, body }); break; }
      case "auth": void executeGithub({ kind: "auth.login" }); break;
      case "auth.logout": if (window.confirm(zh ? "确认退出 GitHub CLI 当前账户？" : "Sign out of the current GitHub CLI account?")) void executeGithub({ kind: "auth.logout", ...(githubAuth?.host === undefined ? {} : { host: githubAuth.host }) }); break;
      case "pr.edit": { const number = Number(ask(zh ? "PR 编号" : "PR number")); const title = Number.isSafeInteger(number) && number > 0 ? ask(zh ? "新标题" : "New title") : undefined; if (title) void executeGithub({ kind: "pr.edit", number, title }); break; }
      case "pr.comment": { const number = Number(ask(zh ? "PR 编号" : "PR number")); const body = Number.isSafeInteger(number) && number > 0 ? ask(zh ? "评论内容" : "Comment") : undefined; if (body) void executeGithub({ kind: "pr.comment", number, body }); break; }
      case "pr.review": { const number = Number(ask(zh ? "PR 编号" : "PR number")); const decision = Number.isSafeInteger(number) && number > 0 ? ask(zh ? "Review 决定：approve / comment / request-changes" : "Review decision: approve / comment / request-changes", "comment") : undefined; const body = decision ? window.prompt(zh ? "Review 意见（可留空）" : "Review comment (optional)", "") : null; if ((decision === "approve" || decision === "comment" || decision === "request-changes") && body !== null) void executeGithub({ kind: "pr.review", number, decision, ...(body.trim() ? { body: body.trim() } : {}) }); break; }
      case "pr.update": { const number = Number(ask(zh ? "PR 编号" : "PR number")); if (Number.isSafeInteger(number) && number > 0) void executeGithub({ kind: "pr.updateBranch", number }); break; }
      case "pr.close": { const number = Number(ask(zh ? "PR 编号" : "PR number")); if (Number.isSafeInteger(number) && number > 0 && window.confirm(zh ? `确认关闭 PR #${number}？` : `Close PR #${number}?`)) void executeGithub({ kind: "pr.close", number }); break; }
      case "pr.reopen": { const number = Number(ask(zh ? "PR 编号" : "PR number")); if (Number.isSafeInteger(number) && number > 0) void executeGithub({ kind: "pr.reopen", number }); break; }
    }
  };

  const staged = useMemo(() => repository?.changes.filter((change) => change.index !== "unmodified") ?? [], [repository]);
  const working = useMemo(() => repository?.changes.filter((change) => change.worktree !== "unmodified") ?? [], [repository]);

  useEffect(() => {
    if (focusPath === undefined || repository === undefined) return;
    const normalized = focusPath.replaceAll("\\", "/");
    const matches = (path: string) => {
      const value = path.replaceAll("\\", "/");
      return value === normalized || value.endsWith(`/${normalized}`) || normalized.endsWith(`/${value}`);
    };
    const workingHit = repository.changes.find((change) => change.worktree !== "unmodified" && matches(change.path));
    const stagedHit = repository.changes.find((change) => change.index !== "unmodified" && matches(change.path));
    const hit = focusTarget === "staged" ? stagedHit : focusTarget === "working" ? workingHit : workingHit ?? stagedHit;
    if (hit === undefined) return;
    setSelected({ path: hit.path, target: focusTarget ?? (workingHit !== undefined ? "working" : "staged") });
  }, [focusPath, focusTarget, focusKey, repository]);

  const graphPanel = (
    <GitCommitGraph
      {...(log === undefined ? {} : { model: log })}
      loading={logLoading}
      {...(logError === undefined ? {} : { error: logError })}
      busy={busy}
      {...(selectedCommit === undefined ? {} : { selectedOid: selectedCommit })}
      {...(commitChanges === undefined ? {} : { changes: commitChanges })}
      changesLoading={changesLoading}
      {...(selectedCommitPath === undefined ? {} : { selectedPath: selectedCommitPath })}
      {...(commitDiff === undefined ? {} : { diff: commitDiff })}
      onRefresh={() => void refreshLog()}
      onSelectCommit={setSelectedCommit}
      onSelectFile={setSelectedCommitPath}
      onLoadMore={() => setLogLimit((value) => Math.min(200, value + 80))}
      onCherryPick={(oid) => void execute({ kind: "cherry-pick", ref: oid })}
      onRevert={(oid) => void execute({ kind: "revert", ref: oid })}
      onCheckout={(oid) => void execute({ kind: "checkout", ref: oid })}
      onCreateBranch={(oid, name) => void execute({ kind: "branch.create", name, startPoint: oid, checkout: true })}
    />
  );
  const wrap = (top: ReactNode) => (
    <GitPanelSplit
      top={top}
      {...(view ? { view } : {})}
      graphOpen={graphLayout.open}
      splitRatio={graphLayout.splitRatio}
      onToggle={() => persistGraphLayout({ ...graphLayout, open: !graphVisible })}
      onResizeSplit={(ratio) => persistGraphLayout({ ...graphLayout, splitRatio: ratio })}
      {...(repository && (repository.ahead || repository.behind) ? { meta: <span className="chip gray xs">↑{repository.ahead} ↓{repository.behind}</span> } : {})}
    >
      {graphPanel}
    </GitPanelSplit>
  );

  if (workspaceId === undefined) return wrap(<div className="empty" style={{ padding: 18 }}>{zh ? "请先选择项目" : "Select a project first"}</div>);
  if (repositoryHook.loading && repository === undefined) return wrap(<div className="empty" style={{ padding: 18 }}>{zh ? "正在读取 Git 状态…" : "Reading Git status…"}</div>);
  if (repositoryHook.error) return wrap(<div className="empty" style={{ padding: 18 }}><p>{repositoryHook.error}</p><button className="btn small outline" onClick={() => void repositoryHook.refresh()}>{zh ? "重试" : "Retry"}</button></div>);
  if (!repository?.isRepository) return wrap(<div className="empty" style={{ padding: 18 }}><p>{repository?.unavailableReason ?? (zh ? "当前项目还不是 Git 仓库" : "This project is not a Git repository")}</p><button className="btn small primary" disabled={busy} onClick={() => void execute({ kind: "init" })}>{zh ? "初始化仓库" : "Initialize repository"}</button></div>);

  const rows = (title: string, changes: typeof staged, target: GitDiffTarget) => (
    <div className="ch-group">
      <div className="ch-group-title">
        {title}
        <span className="ch-count">{changes.length}</span>
        <span className="spacer" />
        {target === "working" ? (
          <GitTip text={working.length === 0 ? t("git.noChanges") : t("git.stageAll")}>
            <button type="button" className="icon-btn small" aria-label={t("git.stageAll")} disabled={busy || working.length === 0} onClick={() => void execute({ kind: "stage", paths: working.map((change) => change.path) })}>
              <Icon name="plus" extra="sm" />
            </button>
          </GitTip>
        ) : (
          <GitTip text={staged.length === 0 ? t("git.noChanges") : t("git.unstageAll")}>
            <button type="button" className="icon-btn small" aria-label={t("git.unstageAll")} disabled={busy || staged.length === 0} onClick={() => void execute({ kind: "unstage", paths: staged.map((change) => change.path) })}>
              <Icon name="minimize" extra="sm" />
            </button>
          </GitTip>
        )}
      </div>
      {changes.map((change) => {
        const name = splitDisplayPath(change.path).name;
        const ftype = fileTypeOf(name);
        return (
        <div
          className={`git-change-line${selected?.path === change.path && selected.target === target ? " selected" : ""}`}
          key={`${target}-${change.path}`}
          data-ftype={ftype ?? undefined}
          data-secret={isSensitive(name) || undefined}
        >
          <button className="ch-row" aria-label={zh ? `查看 ${change.path} 的 ${target === "staged" ? "暂存" : "工作区"} Diff` : `View ${target === "staged" ? "staged" : "working tree"} diff for ${change.path}`} onClick={() => setSelected({ path: change.path, target })}>
            <span className="ch-row-icon" aria-hidden="true"><Icon name={iconNameFor(ftype, name)} extra="sm" /></span>
            <span className="ch-file ellipsis">{change.path}</span><span className="ch-note">{statusLabel(change.index, change.worktree, t)}</span>
          </button>
          <GitTip text={target === "staged" ? t("git.unstage") : t("git.stage")}>
            <button type="button" className="icon-btn small" aria-label={target === "staged" ? t("git.unstage") : t("git.stage")} disabled={busy} onClick={() => void execute({ kind: target === "staged" ? "unstage" : "stage", paths: [change.path] })}><Icon name={target === "staged" ? "minimize" : "plus"} extra="sm" /></button>
          </GitTip>
          {target === "working" ? (
            <GitTip text={t("git.discard")}>
              <button type="button" className="icon-btn small danger" aria-label={t("git.discardChanges")} disabled={busy || !repository.revision} onClick={() => { if (repository.revision && window.confirm(t("git.confirmDiscard", { path: change.path }))) void execute({ kind: "discard", paths: [change.path], expectedRevision: repository.revision }); }}><Icon name="trash" extra="sm" /></button>
            </GitTip>
          ) : null}
        </div>
        );
      })}
    </div>
  );

  return wrap(<>
    <div className="ch-toolbar git-toolbar">
      <GitTip text={t("common.refresh")}>
        <button type="button" className="icon-btn small" aria-label={t("common.refresh")} disabled={busy} onClick={() => void refreshAll()}><Icon name="refresh" extra="sm" /></button>
      </GitTip>
      <span className="git-branch-label ellipsis"><Icon name="branch" extra="sm" />{repository.branch ?? "detached HEAD"}</span>
      {repository.ahead || repository.behind ? <span className="chip gray xs">↑{repository.ahead} ↓{repository.behind}</span> : null}
      <span className="spacer" />
      {activeRequest ? <button className="btn small danger" onClick={() => void cancelActive()}>{t("common.cancel")}</button> : null}
      <button className="btn small outline" disabled={busy} onClick={() => void execute({ kind: "fetch", prune: true })}>Fetch</button>
      <button className="btn small outline" disabled={busy} onClick={() => void execute({ kind: "pull", strategy: "ff-only" })}>Pull</button>
      <button className="btn small outline" disabled={busy} onClick={() => void execute({ kind: "push" })}>Push</button>
    </div>
    {notice ? <div className="git-notice" role="status">{notice}</div> : null}
    {repository.operation ? <div className="git-operation"><b>{repository.operation}</b> {t("git.inProgress")} <span className="spacer" /><button className="btn small outline" disabled={busy} onClick={() => void execute({ kind: "continue", operation: repository.operation! })}>{t("git.continue")}</button><button className="btn small danger" disabled={busy} onClick={() => void execute({ kind: "abort", operation: repository.operation! })}>{t("git.abort")}</button></div> : null}
    <div className="git-actions">
      <GitMoreActionsMenu disabled={busy} githubDisabled={githubAuth?.available === false} onPick={runAdvanced} />
      <span className="tiny muted">{branches ? branches.branches.length : "—"} branches · {worktrees ? worktrees.worktrees.length : "—"} worktrees · {repository.stashCount} stash{githubAuth?.available === false ? ` · ${githubAuth.unavailableReason ?? (zh ? "GitHub CLI 不可用" : "GitHub CLI unavailable")}` : ""}</span>
    </div>
    <div className="ch-list">
      {rows(t("git.staged"), staged, "staged")}
      {rows(t("git.workingTree"), working, "working")}
      {repository.changes.length === 0 ? <div className="empty" style={{ padding: 18 }}>{t("git.workingTreeClean")}</div> : null}

    </div>
    <div className="git-commit-box">
      <textarea value={commitMessage} placeholder="Commit message" rows={1} onChange={(event) => setCommitMessage(event.target.value)} />
      <button className="btn small primary" disabled={busy || staged.length === 0 || !commitMessage.trim()} onClick={() => { const submitted = commitMessage; const message = submitted.trim(); if (!message) return; void execute({ kind: "commit", message }).then((completed) => { if (completed) setCommitMessage(current => current === submitted ? "" : current); }); }}>Commit</button>
      {repository.changes.length > 0 ? <SelectiveCommitButton variant="icon" /> : null}
    </div>
    {selected ? (
      <>
        <GitDiffResizer height={diffHeight} onHeight={setDiffHeight} />
        <div className="ch-diff-slot git-diff-slot" style={{ height: diffHeight }}>
          <div className="diff-toolbar"><Icon name="file-code" extra="sm" /><span className="mono small ellipsis">{selected.path}</span><span className="chip gray xs">{selected.target === "staged" ? "staged" : "working"}</span>{diff?.truncated ? <span className="chip gray xs">{t("common.truncated")}</span> : null}<span className="spacer" /><DiffDisplayMode split={splitDiff} onSplit={setSplitDiff} /></div>
          <div className={`diff-scroll${splitDiff ? " diff-split" : ""}`}>{diff ? (diff.binary ? <div className="empty">Binary diff</div> : diff.patch.length === 0 && repository.changes.some((change) => change.path === selected.path && change.worktree === "untracked") ? <div className="empty">{t("git.untrackedNoDiff")}</div> : <GitPatch patch={diff.patch} split={splitDiff} />) : <div className="empty">{t("git.readingDiff")}</div>}</div>
        </div>
      </>
    ) : <GitDiffPlaceholder />}
  </>);
}
