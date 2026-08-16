import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CommandRequestId,
  GitBranchListReadModel,
  GitDiffReadModel,
  GitDiffTarget,
  GitHubAuthReadModel,
  GitHubOperation,
  GitHubPullRequestListReadModel,
  GitOperation,
  GitOperationResult,
  GitRemoteListReadModel,
  GitRepositoryReadModel,
  GitWorktreeListReadModel,
  StudioClient,
  WorkspaceId,
} from "@omp-studio/client-contract";

import { hostErrorMessage, waitReceipt } from "../hostError";
import { Icon } from "../icons";

type RepositoryHook = {
  readonly repository?: GitRepositoryReadModel;
  readonly loading: boolean;
  readonly error?: string;
  readonly refresh: () => Promise<void>;
};

export function useGitRepository(client: StudioClient, workspaceId?: WorkspaceId): RepositoryHook {
  const [repository, setRepository] = useState<GitRepositoryReadModel | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const requestGeneration = ++generation.current;
    if (workspaceId === undefined) {
      setRepository(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const value = await client.query("git.repository.get", { workspaceId });
      if (requestGeneration !== generation.current) return;
      setRepository(value);
      setError(undefined);
    } catch (cause) {
      if (requestGeneration !== generation.current) return;
      setRepository(undefined);
      setError(hostErrorMessage(cause, "无法读取 Git 仓库状态"));
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void refresh();
    const unsubscribe = client.subscribe({ scope: "all" }, (event) => {
      if (event.kind === "git.repository.changed" && event.repository.workspaceId === workspaceId) void refresh();
    });
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [client, refresh, workspaceId]);

  return { ...(repository === undefined ? {} : { repository }), loading, ...(error === undefined ? {} : { error }), refresh };
}

function ask(label: string, initial = ""): string | undefined {
  const value = window.prompt(label, initial)?.trim();
  return value ? value : undefined;
}

function statusLabel(index: string, worktree: string): string {
  if (index === "conflicted" || worktree === "conflicted") return "冲突";
  if (index !== "unmodified" && worktree !== "unmodified") return "已暂存 + 工作区";
  if (index !== "unmodified") return "已暂存";
  return worktree === "untracked" ? "未跟踪" : "工作区";
}

function patchLines(patch: string) {
  return patch.split(/\r?\n/u).map((line, index) => {
    const tone = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
    return <div key={`${index}-${line}`} className={`dl ${tone}`}><span className="dm">{tone === "add" ? "+" : tone === "del" ? "−" : " "}</span><span className="lc">{line}</span></div>;
  });
}

export function GitStatusPanel({ client, workspaceId }: { readonly client: StudioClient; readonly workspaceId?: WorkspaceId }) {
  const repositoryHook = useGitRepository(client, workspaceId);
  const repository = repositoryHook.repository;
  const [branches, setBranches] = useState<GitBranchListReadModel>();
  const [worktrees, setWorktrees] = useState<GitWorktreeListReadModel>();
  const [remotes, setRemotes] = useState<GitRemoteListReadModel>();
  const [githubAuth, setGithubAuth] = useState<GitHubAuthReadModel>();
  const [pullRequests, setPullRequests] = useState<GitHubPullRequestListReadModel>();
  const [selected, setSelected] = useState<{ path: string; target: GitDiffTarget }>();
  const [diff, setDiff] = useState<GitDiffReadModel>();
  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [activeRequest, setActiveRequest] = useState<{ domain: "git" | "github"; requestId: CommandRequestId }>();
  const detailsGeneration = useRef(0);

  const refreshDetails = useCallback(async () => {
    const requestGeneration = ++detailsGeneration.current;
    if (workspaceId === undefined) {
      setBranches(undefined);
      setWorktrees(undefined);
      setRemotes(undefined);
      setGithubAuth(undefined);
      setPullRequests(undefined);
      return;
    }
    const results = await Promise.allSettled([
      client.query("git.branches.list", { workspaceId }),
      client.query("git.worktrees.list", { workspaceId }),
      client.query("git.remotes.list", { workspaceId }),
      client.query("github.auth.get", { workspaceId }),
      client.query("github.pr.list", { workspaceId, state: "open" }),
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
    if (results[4].status === "fulfilled") setPullRequests(results[4].value);
    else setPullRequests(undefined);
  }, [client, workspaceId]);

  const refreshAll = useCallback(async () => {
    await Promise.all([repositoryHook.refresh(), refreshDetails()]);
  }, [refreshDetails, repositoryHook.refresh]);

  useEffect(() => {
    void refreshDetails();
    return () => { detailsGeneration.current += 1; };
  }, [refreshDetails]);

  useEffect(() => {
    if (workspaceId === undefined || selected === undefined) {
      setDiff(undefined);
      return;
    }
    let cancelled = false;
    setDiff(undefined);
    void client.query("git.diff.get", { workspaceId, path: selected.path, target: selected.target }).then(
      (value) => { if (!cancelled) setDiff(value); },
      (cause) => { if (!cancelled) { setDiff(undefined); setNotice(hostErrorMessage(cause, "无法读取 Diff")); } },
    );
    return () => { cancelled = true; };
  }, [client, selected, workspaceId]);

  const execute = useCallback(async (operation: GitOperation) => {
    if (operation.kind !== "clone" && workspaceId === undefined) return false;
    setBusy(true);
    setNotice(undefined);
    try {
      const handle = await client.command("git.execute", {
        ...(workspaceId === undefined ? {} : { workspaceId }),
        operation,
      });
      setActiveRequest({ domain: "git", requestId: handle.requestId });
      const result = await waitReceipt<GitOperationResult>(client, handle.requestId, 5 * 60_000);
      setNotice(result.message);
      await refreshAll();
      return true;
    } catch (cause) {
      setNotice(hostErrorMessage(cause, "Git 操作失败"));
      return false;
    } finally {
      setActiveRequest(undefined);
      setBusy(false);
    }
  }, [client, refreshAll, workspaceId]);

  const executeGithub = useCallback(async (operation: GitHubOperation) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const handle = await client.command("github.execute", {
        ...(workspaceId === undefined ? {} : { workspaceId }),
        operation,
      });
      setActiveRequest({ domain: "github", requestId: handle.requestId });
      await waitReceipt(client, handle.requestId, 16 * 60_000);
      setNotice(`${operation.kind} completed`);
      await refreshAll();
    } catch (cause) {
      setNotice(hostErrorMessage(cause, "GitHub 操作失败"));
    } finally {
      setActiveRequest(undefined);
      setBusy(false);
    }
  }, [client, refreshAll, workspaceId]);

  const cancelActive = useCallback(async () => {
    if (activeRequest === undefined) return;
    try {
      const handle = await client.command(activeRequest.domain === "git" ? "git.execute" : "github.execute", {
        operation: { kind: "cancel", requestId: activeRequest.requestId },
      });
      await waitReceipt(client, handle.requestId, 30_000);
      setNotice("已请求取消操作");
    } catch (cause) {
      setNotice(hostErrorMessage(cause, "取消操作失败"));
    }
  }, [activeRequest, client]);

  const runAdvanced = (value: string) => {
    if (!repository) return;
    switch (value) {
      case "branch.create": { const name = ask("新分支名称"); if (name) void execute({ kind: "branch.create", name, checkout: true }); break; }
      case "branch.switch": { const name = ask("切换到分支", branches?.branches.find((item) => !item.remote && !item.current)?.name); if (name) void execute({ kind: "branch.switch", name }); break; }
      case "branch.rename": { const newName = ask("新的分支名称", repository.branch); if (newName) void execute({ kind: "branch.rename", newName }); break; }
      case "branch.delete": { const name = ask("删除本地分支"); if (name && window.confirm(`确认删除分支 ${name}？`)) void execute({ kind: "branch.delete", name, ...(repository.revision === undefined ? {} : { expectedRevision: repository.revision }) }); break; }
      case "worktree.root": void execute({ kind: "worktree.pickRoot" }); break;
      case "worktree.create": { const branch = ask("Worktree 分支名"); if (branch) void execute({ kind: "worktree.create", branch, createBranch: true }); break; }
      case "worktree.lock": { const name = ask("锁定哪个 Worktree？", worktrees?.worktrees.find((item) => !item.current)?.name); const target = worktrees?.worktrees.find((item) => item.name === name); if (target) void execute({ kind: "worktree.lock", worktreeId: target.worktreeId }); else if (name) setNotice("找不到该 Worktree"); break; }
      case "worktree.unlock": { const name = ask("解锁哪个 Worktree？", worktrees?.worktrees.find((item) => item.locked)?.name); const target = worktrees?.worktrees.find((item) => item.name === name); if (target) void execute({ kind: "worktree.unlock", worktreeId: target.worktreeId }); else if (name) setNotice("找不到该 Worktree"); break; }
      case "worktree.remove": { const name = ask("移除哪个 Worktree？", worktrees?.worktrees.find((item) => !item.current)?.name); const target = worktrees?.worktrees.find((item) => item.name === name); if (target && window.confirm(`确认移除 Worktree ${target.name}？`)) void execute({ kind: "worktree.remove", worktreeId: target.worktreeId }); else if (name && !target) setNotice("找不到该 Worktree"); break; }
      case "worktree.prune": void execute({ kind: "worktree.prune" }); break;
      case "stash": void execute({ kind: "stash.push", includeUntracked: true }); break;
      case "stash.pop": if (window.confirm("确认 Pop 最近一次 Stash？可能产生冲突。")) void execute({ kind: "stash.apply", pop: true }); break;
      case "merge": { const ref = ask("合并哪个分支或提交？"); if (ref) void execute({ kind: "merge", ref }); break; }
      case "rebase": { const ref = ask("Rebase 到哪个分支或提交？"); if (ref) void execute({ kind: "rebase", ref }); break; }
      case "cherry-pick": { const ref = ask("Cherry-pick 提交"); if (ref) void execute({ kind: "cherry-pick", ref }); break; }
      case "revert": { const ref = ask("Revert 提交"); if (ref) void execute({ kind: "revert", ref }); break; }
      case "reset": { const ref = ask("Hard reset 到（会丢弃改动）"); if (ref && repository.revision && window.confirm(`确认 hard reset 到 ${ref}？此操作不可撤销。`)) void execute({ kind: "reset", mode: "hard", ref, expectedRevision: repository.revision }); break; }
      case "remote.add": { const name = ask("Remote 名称", "upstream"); const url = name ? ask("Remote URL") : undefined; if (name && url) void execute({ kind: "remote.add", name, url }); break; }
      case "remote.set": { const name = ask("Remote 名称", remotes?.remotes[0]?.name ?? "origin"); const url = name ? ask("新的 Remote URL") : undefined; if (name && url) void execute({ kind: "remote.setUrl", name, url }); break; }
      case "remote.remove": { const name = ask("移除 Remote", remotes?.remotes[0]?.name); if (name && window.confirm(`确认移除 Remote ${name}？`)) void execute({ kind: "remote.remove", name }); break; }
      case "pull.rebase": void execute({ kind: "pull", strategy: "rebase" }); break;
      case "pull.merge": void execute({ kind: "pull", strategy: "merge" }); break;
      case "push.force": { const remote = ask("Remote", "origin"); const branch = remote ? ask("分支", repository.branch) : undefined; const expected = remote && branch ? branches?.branches.find((item) => item.remote && item.name === `${remote}/${branch}`)?.headOid : undefined; if (!expected) { setNotice("无法取得远端分支 OID，已拒绝 force push"); break; } if (remote && branch && window.confirm(`确认使用 force-with-lease 推送 ${remote}/${branch}？`)) void execute({ kind: "push", remote, branch, forceWithLease: true, expectedRemoteOid: expected }); break; }
      case "tag.create": { const name = ask("Tag 名称"); const message = name ? window.prompt("注释（留空创建轻量 Tag）", "") : null; if (name && message !== null) void execute({ kind: "tag.create", name, ...(message.trim() ? { message: message.trim() } : {}) }); break; }
      case "tag.delete": { const name = ask("删除 Tag"); if (name && window.confirm(`确认删除本地 Tag ${name}？`)) void execute({ kind: "tag.delete", name }); break; }
      case "pr.create": { const title = ask("PR 标题"); const base = title ? ask("目标分支", "main") : undefined; const body = base ? window.prompt("PR 描述", "") : null; if (title && base && body !== null) void executeGithub({ kind: "pr.create", title, base, body }); break; }
      case "auth": void executeGithub({ kind: "auth.login" }); break;
      case "auth.logout": if (window.confirm("确认退出 GitHub CLI 当前账户？")) void executeGithub({ kind: "auth.logout", ...(githubAuth?.host === undefined ? {} : { host: githubAuth.host }) }); break;
      case "pr.edit": { const number = Number(ask("PR 编号")); const title = Number.isSafeInteger(number) && number > 0 ? ask("新标题") : undefined; if (title) void executeGithub({ kind: "pr.edit", number, title }); break; }
      case "pr.comment": { const number = Number(ask("PR 编号")); const body = Number.isSafeInteger(number) && number > 0 ? ask("评论内容") : undefined; if (body) void executeGithub({ kind: "pr.comment", number, body }); break; }
      case "pr.review": { const number = Number(ask("PR 编号")); const decision = Number.isSafeInteger(number) && number > 0 ? ask("Review 决定：approve / comment / request-changes", "comment") : undefined; const body = decision ? window.prompt("Review 意见（可留空）", "") : null; if ((decision === "approve" || decision === "comment" || decision === "request-changes") && body !== null) void executeGithub({ kind: "pr.review", number, decision, ...(body.trim() ? { body: body.trim() } : {}) }); break; }
      case "pr.merge": { const number = Number(ask("PR 编号")); const pr = pullRequests?.pullRequests.find((item) => item.number === number); const method = pr ? ask("合并方式：merge / squash / rebase", "squash") : undefined; if (!pr?.headOid) { if (Number.isSafeInteger(number)) setNotice("找不到该 Open PR 或缺少 head OID"); break; } if ((method === "merge" || method === "squash" || method === "rebase") && window.confirm(`确认 ${method} merge PR #${number}？`)) void executeGithub({ kind: "pr.merge", number, method, expectedHeadOid: pr.headOid }); break; }
      case "pr.update": { const number = Number(ask("PR 编号")); if (Number.isSafeInteger(number) && number > 0) void executeGithub({ kind: "pr.updateBranch", number }); break; }
      case "pr.close": { const number = Number(ask("PR 编号")); if (Number.isSafeInteger(number) && number > 0 && window.confirm(`确认关闭 PR #${number}？`)) void executeGithub({ kind: "pr.close", number }); break; }
      case "pr.reopen": { const number = Number(ask("PR 编号")); if (Number.isSafeInteger(number) && number > 0) void executeGithub({ kind: "pr.reopen", number }); break; }
    }
  };

  const staged = useMemo(() => repository?.changes.filter((change) => change.index !== "unmodified") ?? [], [repository]);
  const working = useMemo(() => repository?.changes.filter((change) => change.worktree !== "unmodified") ?? [], [repository]);

  if (workspaceId === undefined) return <div className="empty" style={{ padding: 18 }}>请先选择项目</div>;
  if (repositoryHook.loading && repository === undefined) return <div className="empty" style={{ padding: 18 }}>正在读取 Git 状态…</div>;
  if (repositoryHook.error) return <div className="empty" style={{ padding: 18 }}><p>{repositoryHook.error}</p><button className="btn small outline" onClick={() => void repositoryHook.refresh()}>重试</button></div>;
  if (!repository?.isRepository) return <div className="empty" style={{ padding: 18 }}><p>{repository?.unavailableReason ?? "当前项目还不是 Git 仓库"}</p><button className="btn small primary" disabled={busy} onClick={() => void execute({ kind: "init" })}>初始化仓库</button></div>;

  const rows = (title: string, changes: typeof staged, target: GitDiffTarget) => (
    <div className="ch-group">
      <div className="ch-group-title">{title}<span className="ch-count">{changes.length}</span></div>
      {changes.map((change) => (
        <div className={`git-change-line${selected?.path === change.path && selected.target === target ? " selected" : ""}`} key={`${target}-${change.path}`}>
          <button className="ch-row" aria-label={`查看 ${change.path} 的 ${target === "staged" ? "暂存" : "工作区"} Diff`} onClick={() => setSelected({ path: change.path, target })}>
            <span className="ch-file ellipsis">{change.path}</span><span className="ch-note">{statusLabel(change.index, change.worktree)}</span>
          </button>
          <button className="icon-btn small" title={target === "staged" ? "取消暂存" : "暂存"} disabled={busy} onClick={() => void execute({ kind: target === "staged" ? "unstage" : "stage", paths: [change.path] })}><Icon name={target === "staged" ? "minus" : "plus"} extra="sm" /></button>
          {target === "working" ? <button className="icon-btn small danger" title="丢弃更改" disabled={busy || !repository.revision} onClick={() => { if (repository.revision && window.confirm(`确认丢弃 ${change.path} 的工作区更改？`)) void execute({ kind: "discard", paths: [change.path], expectedRevision: repository.revision }); }}><Icon name="trash" extra="sm" /></button> : null}
        </div>
      ))}
    </div>
  );

  return <>
    <div className="ch-toolbar git-toolbar">
      <button className="icon-btn small" title="刷新" disabled={busy} onClick={() => void refreshAll()}><Icon name="refresh" extra="sm" /></button>
      <span className="git-branch-label ellipsis"><Icon name="branch" extra="sm" />{repository.branch ?? "detached HEAD"}</span>
      {repository.ahead || repository.behind ? <span className="chip gray xs">↑{repository.ahead} ↓{repository.behind}</span> : null}
      <span className="spacer" />
      {activeRequest ? <button className="btn small danger" onClick={() => void cancelActive()}>取消</button> : null}
      <button className="btn small outline" disabled={busy} onClick={() => void execute({ kind: "fetch", prune: true })}>Fetch</button>
      <button className="btn small outline" disabled={busy} onClick={() => void execute({ kind: "pull", strategy: "ff-only" })}>Pull</button>
      <button className="btn small outline" disabled={busy} onClick={() => void execute({ kind: "push" })}>Push</button>
    </div>
    {notice ? <div className="git-notice" role="status">{notice}</div> : null}
    {repository.operation ? <div className="git-operation"><b>{repository.operation}</b> 正在进行 <span className="spacer" /><button className="btn small outline" disabled={busy} onClick={() => void execute({ kind: "continue", operation: repository.operation! })}>继续</button><button className="btn small danger" disabled={busy} onClick={() => void execute({ kind: "abort", operation: repository.operation! })}>中止</button></div> : null}
    <div className="git-actions">
      <select aria-label="更多 Git 操作" disabled={busy} defaultValue="" onChange={(event) => { runAdvanced(event.target.value); event.currentTarget.value = ""; }}>
        <option value="" disabled>更多操作…</option>
        <optgroup label="分支"><option value="branch.create">新建并切换分支</option><option value="branch.switch">切换分支</option><option value="branch.rename">重命名当前分支</option><option value="branch.delete">删除分支</option></optgroup>
        <optgroup label="Worktree"><option value="worktree.root">选择 Worktree 根目录</option><option value="worktree.create">新建 Worktree</option><option value="worktree.lock">锁定 Worktree</option><option value="worktree.unlock">解锁 Worktree</option><option value="worktree.remove">移除 Worktree</option><option value="worktree.prune">Prune Worktree</option></optgroup>
        <optgroup label="历史"><option value="stash">Stash 全部</option><option value="stash.pop">Pop Stash</option><option value="merge">Merge</option><option value="rebase">Rebase</option><option value="cherry-pick">Cherry-pick</option><option value="revert">Revert</option><option value="reset">Hard reset…</option><option value="tag.create">创建 Tag</option><option value="tag.delete">删除 Tag</option></optgroup>
        <optgroup label="远端"><option value="pull.rebase">Pull --rebase</option><option value="pull.merge">Pull --merge</option><option value="push.force">Force-with-lease Push</option><option value="remote.add">添加 Remote</option><option value="remote.set">修改 Remote URL</option><option value="remote.remove">移除 Remote</option></optgroup>
        <optgroup label="GitHub" disabled={githubAuth?.available === false}><option value="auth">登录 GitHub</option><option value="auth.logout">退出 GitHub</option><option value="pr.create">创建 PR</option><option value="pr.edit">编辑 PR</option><option value="pr.comment">评论 PR</option><option value="pr.review">Review PR</option><option value="pr.update">更新 PR 分支</option><option value="pr.merge">合并 PR</option><option value="pr.close">关闭 PR</option><option value="pr.reopen">重新打开 PR</option></optgroup>
      </select>
      <span className="tiny muted">{branches ? branches.branches.length : "—"} branches · {worktrees ? worktrees.worktrees.length : "—"} worktrees · {repository.stashCount} stash{githubAuth?.available === false ? ` · ${githubAuth.unavailableReason ?? "GitHub CLI 不可用"}` : ""}</span>
    </div>
    <div className="ch-list">
      {rows("已暂存", staged, "staged")}
      {rows("工作区", working, "working")}
      {repository.changes.length === 0 ? <div className="empty" style={{ padding: 18 }}>工作区干净</div> : null}
      {githubAuth?.authenticated && pullRequests?.pullRequests.length ? <div className="git-pr-list"><div className="ch-group-title">Open pull requests<span className="ch-count">{pullRequests.pullRequests.length}</span></div>{pullRequests.pullRequests.map((pr) => <div className="git-pr-row" key={pr.number}><span className="ellipsis">#{pr.number} {pr.title}</span><button className="btn small outline" disabled={busy} onClick={() => void executeGithub({ kind: "pr.checkout", number: pr.number })}>Checkout</button>{pr.draft ? <button className="btn small outline" disabled={busy} onClick={() => void executeGithub({ kind: "pr.ready", number: pr.number })}>Ready</button> : null}<button className="btn small primary" disabled={busy || !pr.headOid} title={pr.headOid ? "Squash merge" : "缺少远端 head OID"} onClick={() => { if (pr.headOid && window.confirm(`确认 squash merge #${pr.number}？`)) void executeGithub({ kind: "pr.merge", number: pr.number, method: "squash", expectedHeadOid: pr.headOid, deleteBranch: true }); }}>Merge</button></div>)}</div> : null}
    </div>
    <div className="git-commit-box">
      <textarea value={commitMessage} placeholder="Commit message" rows={2} onChange={(event) => setCommitMessage(event.target.value)} />
      <button className="btn small primary" disabled={busy || staged.length === 0 || !commitMessage.trim()} onClick={() => { const message = commitMessage.trim(); if (!message) return; void execute({ kind: "commit", message }).then((completed) => { if (completed) setCommitMessage(""); }); }}>Commit</button>
    </div>
    {selected ? <div className="ch-diff-slot git-diff-slot"><div className="diff-toolbar"><Icon name="file-code" extra="sm" /><span className="mono small ellipsis">{selected.path}</span><span className="chip gray xs">{selected.target === "staged" ? "staged" : "working"}</span>{diff?.truncated ? <span className="chip gray xs">已截断</span> : null}</div><div className="diff-scroll">{diff ? (diff.binary ? <div className="empty">Binary diff</div> : diff.patch.length === 0 && repository.changes.some((change) => change.path === selected.path && change.worktree === "untracked") ? <div className="empty">未跟踪文件暂时没有 Git diff；暂存后可查看。</div> : patchLines(diff.patch)) : <div className="empty">读取 Diff…</div>}</div></div> : null}
  </>;
}
