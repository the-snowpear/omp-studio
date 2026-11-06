import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GitFileState, GitHubItem, GitHubReference, GitHubRepository, GitLogCommitRecord, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { gitCommitReferenceSnapshot, type GitCommitReferenceSnapshot } from "../composer/gitCommitReference";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { hostErrorMessage } from "../hostError";
import { Icon, type IconName } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_GIT_LOG } from "../preview/fixtures";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import type { GitOpenIntent } from "./GitWorkbench";
import { GitGraphSvg, gitRefClass } from "./GitCommitGraph";
import { buildGitGraphRows } from "./gitGraphLayout";
import { useGitWorkspace } from "./GitWorkspaceContext";
import { useGitQuickReads, type GitQuickView } from "./useGitQuickReads";
import "./gitQuickCard.css";

type OpenTarget = Omit<GitOpenIntent, "key">;

function statusMark(state: GitFileState): string {
  return ({ unmodified: "", modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", untracked: "U", conflicted: "!" })[state];
}

type Props = {
  client: StudioClient; workspaceId?: WorkspaceId | undefined; workspaceName?: string | undefined; visible: boolean; worktrees: ReactNode;
  onOpen(target: OpenTarget): void; onReference(reference: GitHubReference): void;
  onCommitReference(reference: GitCommitReferenceSnapshot): void;
};

export function GitQuickCard(props: Props) {
  const { preview } = usePreviewMode();
  const { id } = useExecutionTarget();
  const scope = JSON.stringify([id, props.workspaceId ?? "none", preview]);
  return <GitQuickCardBody key={scope} {...props} storage={`omp.git.quick.view:${scope}`} />;
}

function GitQuickCardBody({ client, workspaceId, workspaceName, visible, worktrees, onOpen, onReference, onCommitReference, storage }: Props & { storage: string }) {
  const { resolvedLanguage, t } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview, marks } = usePreviewMode();
  const executionTarget = useExecutionTarget();
  const shared = useGitWorkspace();
  const { repository, remote } = shared;
  const [view, setView] = useState<GitQuickView>(() => {
    const saved = localStorage.getItem(storage);
    return saved === "history" || saved === "issue" || saved === "pr" ? saved : "changes";
  });
  const { read, source, target } = useGitQuickReads(client, workspaceId, preview, visible, view, zh);
  const tabsId = useId();
  const [historyLayout, setHistoryLayout] = useState<"list" | "graph">(() => localStorage.getItem(`${storage}:history-layout`) === "graph" ? "graph" : "list");
  const graphRows = useMemo(() => read.log ? buildGitGraphRows(read.log) : [], [read.log]);
  const [adding, setAdding] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const [group, setGroup] = useState<"working" | "staged">("working");
  const [chosenGroup, setChosenGroup] = useState(false);
  const [menu, setMenu] = useState<{ top: number; left: number }>();
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const doc = useSurfaceDocument();

  useEffect(() => {
    generation.current++;
    setReferenceError(""); setAdding(false);
    return () => { generation.current++; };
  }, [source, target, remote]);

  useEffect(() => {
    if (!menu) return;
    const down = (event: PointerEvent) => {
      if (doc.querySelector("dialog.worktree-manager-dialog[open]")) return;
      if (!menuRoot.current?.contains(event.target as Node) && !menuButton.current?.contains(event.target as Node)) setMenu(undefined);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !doc.querySelector("dialog.worktree-manager-dialog[open]")) { event.preventDefault(); setMenu(undefined); menuButton.current?.focus(); }
    };
    const dismiss = () => { if (!doc.querySelector("dialog.worktree-manager-dialog[open]")) setMenu(undefined); };
    doc.addEventListener("pointerdown", down); doc.addEventListener("keydown", key); doc.addEventListener("scroll", dismiss, true); doc.defaultView?.addEventListener("resize", dismiss);
    return () => { doc.removeEventListener("pointerdown", down); doc.removeEventListener("keydown", key); doc.removeEventListener("scroll", dismiss, true); doc.defaultView?.removeEventListener("resize", dismiss); };
  }, [doc, menu]);
  useEffect(() => { if (!visible) setMenu(undefined); }, [visible]);

  const staged = repository?.changes.filter(row => row.index !== "unmodified") ?? [];
  const working = repository?.changes.filter(row => row.worktree !== "unmodified") ?? [];
  const activeGroup = !chosenGroup && !working.length && staged.length ? "staged" : group;
  const files = activeGroup === "staged" ? staged : working;
  const navigate = (intent: OpenTarget) => { setMenu(undefined); onOpen(intent); };
  const addReference = async (item: GitHubItem, origin: GitHubRepository) => {
    if (!target || adding) return;
    const current = generation.current;
    const input = { workspaceId: target, remote: origin.remote, kind: item.kind, number: item.number };
    setAdding(true); setReferenceError("");
    try {
      const [detail, discussion] = await Promise.all([source.query("github.items.get", input), source.query("github.discussion.list", input)]);
      if (generation.current !== current) return;
      onReference({ repository: detail.repository, item: detail.item, checks: detail.checks, comments: discussion.comments, capturedAt: new Date().toISOString(), diffs: [] });
    } catch (cause) { if (generation.current === current) setReferenceError(hostErrorMessage(cause, zh ? "无法加入引用" : "Could not add reference")); }
    finally { if (generation.current === current) setAdding(false); }
  };
  const addCommitReference = async (commit: GitLogCommitRecord) => {
    if (!target || adding) return;
    const current = generation.current;
    setAdding(true); setReferenceError("");
    try {
      const files = preview
        ? PREVIEW_GIT_LOG.commits.find(row => row.oid === commit.oid)?.files ?? []
        : (await client.query("git.commit.changes", { workspaceId: target, oid: commit.oid })).files;
      if (generation.current !== current) return;
      onCommitReference(gitCommitReferenceSnapshot({ commit, files,
        repositoryKey: JSON.stringify([preview ? "preview" : "real", executionTarget.id ?? "local", repository?.repositoryId ?? workspaceId ?? target]),
        workspaceName: workspaceName ?? (preview ? "omp-web" : String(target)) }));
    } catch (cause) { if (generation.current === current) setReferenceError(hostErrorMessage(cause, zh ? "无法加入提交引用" : "Could not add commit reference")); }
    finally { if (generation.current === current) setAdding(false); }
  };
  const selectGroup = (next: "working" | "staged") => { setChosenGroup(true); setGroup(next); };
  const chooseHistoryLayout = (next: "list" | "graph") => { setHistoryLayout(next); localStorage.setItem(`${storage}:history-layout`, next); };
  const sync = (label: string, icon: IconName, action: "fetch" | "pull" | "push") => <button type="button" className="icon-btn small" aria-label={label} data-tip={label} disabled={shared.busy || !repository?.isRepository} onClick={() => void shared.execute(action === "fetch" ? { kind: "fetch", prune: true } : action === "pull" ? { kind: "pull", strategy: "ff-only" } : { kind: "push" })}><Icon name={icon} extra="sm" /></button>;
  const status = (value?: string) => {
    switch (value) {
      case "SUCCESS": return zh ? "检查通过" : "Checks passed";
      case "FAILURE": case "ERROR": return zh ? "检查失败" : "Checks failed";
      case "PENDING": case "EXPECTED": return zh ? "检查进行中" : "Checks pending";
      default: return zh ? "暂无检查" : "No checks";
    }
  };
  const review = (value?: string) => value === "APPROVED" ? zh ? "已批准" : "Approved" : value === "CHANGES_REQUESTED" ? zh ? "需修改" : "Changes requested" : value === "REVIEW_REQUIRED" ? zh ? "等待评审" : "Review required" : zh ? "暂无评审" : "No review";

  const chooseView = (next: GitQuickView) => { setView(next); localStorage.setItem(storage, next); };
  const tabs: { view: GitQuickView; icon: IconName; label: string }[] = [
    { view: "changes", icon: "changes", label: zh ? "更改" : "Changes" },
    { view: "history", icon: "history", label: zh ? "历史" : "History" },
    { view: "issue", icon: "issue", label: "Issues" },
    { view: "pr", icon: "pull-request", label: "PR" },
  ];
  const openView = () => navigate({ view, ...(view === "issue" || view === "pr" ? { remote } : {}) });
  const itemRow = (item: GitHubItem, origin: GitHubRepository) => <div className="git-quick-item" key={item.number}>
    <button type="button" className="git-quick-pr-main" data-tip={item.title} onClick={() => navigate({ view: item.kind, remote: origin.remote, number: item.number })}>
      <span><Icon name={item.kind === "pr" ? "pull-request" : "issue"} extra="sm" /><strong>#{item.number}</strong><span className="git-quick-pr-title">{item.title}</span></span>
      {item.kind === "pr" ? <small data-tip={`${item.draft ? (zh ? "草稿 · " : "Draft · ") : ""}${status(item.checkState)} · ${review(item.reviewDecision)}`}>
        {item.draft ? `${zh ? "草稿" : "Draft"} · ` : ""}<span data-tone={item.checkState === "SUCCESS" ? "success" : item.checkState === "FAILURE" || item.checkState === "ERROR" ? "error" : undefined}>{status(item.checkState)}</span> · {review(item.reviewDecision)}
      </small> : <small className="git-quick-issue-meta">
        {item.labels[0] ? <span className="git-quick-label" data-tip={item.labels[0]}>{item.labels[0]}</span> : null}
        <span className="git-quick-comments" aria-label={`${item.commentCount} ${zh ? "条评论" : "comments"}`}><Icon name="message" extra="sm" />{item.commentCount}</span>
        <time dateTime={item.updatedAt} data-tip={new Date(item.updatedAt).toLocaleString()}>{relativeTime(item.updatedAt, zh)}</time>
      </small>}
    </button>
    <button type="button" className="icon-btn small git-quick-at" aria-label={zh ? `将 ${item.kind === "pr" ? "PR" : "Issue"} #${item.number} 加入输入框` : `Add ${item.kind === "pr" ? "PR" : "Issue"} #${item.number} to composer`} data-tip={zh ? "加入输入框" : "Add to composer"} disabled={adding} onClick={() => void addReference(item, origin)}><Icon name="at" extra="sm" /></button>
  </div>;
  const commitReferenceButton = (commit: GitLogCommitRecord) => <button type="button" className="icon-btn small git-quick-commit-at" aria-label={zh ? `将提交 ${commit.oid.slice(0, 7)} 加入输入框` : `Add commit ${commit.oid.slice(0, 7)} to composer`} data-tip={zh ? "加入输入框" : "Add to composer"} disabled={adding} onClick={() => void addCommitReference(commit)}><Icon name="at" extra="sm" /></button>;

  return <section className="git-quick" aria-label={zh ? "Git 快捷卡" : "Git quick card"}>
    <div className="git-quick-head">
      <Icon name="branch" extra="sm" /><span className="git-quick-branch" data-tip={repository?.branch ?? "detached HEAD"}>{repository?.branch ?? (repository?.detached ? "detached HEAD" : "Git")}</span>
      <div className="git-quick-tabs" role="tablist" aria-label={zh ? "Git 视图" : "Git views"}>
      {tabs.map(tab => <button type="button" key={tab.view} id={`${tabsId}-${tab.view}`} role="tab" aria-label={tab.label} data-tip={tab.label} aria-controls={`${tabsId}-panel`} aria-selected={view === tab.view} tabIndex={view === tab.view ? 0 : -1} onClick={() => chooseView(tab.view)} onKeyDown={event => {
        const index = tabs.indexOf(tab);
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); chooseView(tabs[next]!.view); doc.getElementById(`${tabsId}-${tabs[next]!.view}`)?.focus();
      }}><Icon name={tab.icon} extra="sm" /></button>)}
      </div>
    </div>
    {menu ? createPortal(<div ref={menuRoot} className="menu git-quick-menu" style={{ position: "fixed", top: menu.top, left: menu.left }} role="group" aria-label={zh ? "更多 Git 操作" : "More Git actions"}>
      <button type="button" className="menu-item" onClick={() => { setMenu(undefined); void shared.refresh(); }}><Icon name="refresh" extra="sm" />{zh ? "刷新" : "Refresh"}</button>
      <button type="button" className="menu-item" onClick={() => navigate({ view: "history" })}><Icon name="history" extra="sm" />{zh ? "提交历史" : "History"}</button>
      {worktrees}
    </div>, doc.body) : null}
    {preview && marks ? <span className="git-quick-demo">{zh ? "演示" : "Demo"}</span> : null}
    <div className="git-quick-body" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${view}`}>
    {!target && !preview ? <p className="git-quick-empty">{zh ? "请先选择项目" : "Choose a project"}</p> : shared.loading && !repository ? <p className="git-quick-empty" role="status">{zh ? "正在读取 Git…" : "Loading Git…"}</p> : shared.error || !repository?.isRepository ? <p className="git-quick-empty" role="status">{shared.error ?? repository?.unavailableReason ?? (zh ? "当前项目不是 Git 仓库" : "Not a Git repository")}</p> : <>
      {repository.operation || repository.changes.some(row => row.conflicted) ? <button className="git-quick-warning" type="button" onClick={() => navigate({ view: "changes" })}><Icon name="alert" extra="sm" />{repository.operation ? `${repository.operation} · ${zh ? "进行中" : "in progress"}` : zh ? "存在冲突，打开 Git 处理" : "Conflicts need attention"}</button> : null}
      {view === "changes" ? <>
      <div className="git-quick-groups" role="group" aria-label={zh ? "文件分组" : "File groups"}>
        <button type="button" aria-pressed={activeGroup === "working"} onClick={() => selectGroup("working")}>{zh ? "未暂存" : "Changes"} <span>{working.length}</span></button>
        <button type="button" aria-pressed={activeGroup === "staged"} onClick={() => selectGroup("staged")}>{zh ? "已暂存" : "Staged"} <span>{staged.length}</span></button>
        <span className="spacer" />{repository.insertions ? <span className="ch-add">+{repository.insertions}</span> : null}{repository.deletions ? <span className="ch-del">−{repository.deletions}</span> : null}
      </div>
      <div className="git-quick-files">
        {files.slice(0, 3).map(file => <div className="git-quick-file" key={file.path}>
          <span className="git-quick-file-status" data-state={file.conflicted ? "conflicted" : file[activeGroup === "staged" ? "index" : "worktree"]}>{statusMark(file[activeGroup === "staged" ? "index" : "worktree"])}</span>
          <button type="button" className="git-quick-file-name" data-tip={file.path} aria-label={`${zh ? "查看" : "Open"} ${file.path}`} onClick={() => navigate({ view: "changes", path: file.path, target: activeGroup })}>{file.path.split("/").at(-1)}</button>
          <button type="button" className="icon-btn small" disabled={shared.busy} aria-label={`${activeGroup === "staged" ? zh ? "取消暂存" : "Unstage" : zh ? "暂存" : "Stage"} ${file.path}`} data-tip={activeGroup === "staged" ? zh ? "取消暂存" : "Unstage" : zh ? "暂存" : "Stage"} onClick={() => void shared.execute({ kind: activeGroup === "staged" ? "unstage" : "stage", paths: [file.path] })}><Icon name={activeGroup === "staged" ? "minimize" : "plus"} extra="sm" /></button>
        </div>)}
        {files.length === 0 ? <p className="git-quick-empty">{zh ? "没有文件改动" : "No files"}</p> : null}
        {files.length > 3 ? <button type="button" className="git-quick-more-files" onClick={() => navigate({ view: "changes" })}>{zh ? `其余 ${files.length - 3} 个文件` : `${files.length - 3} more files`} <Icon name="chevron-r" extra="sm" /></button> : null}
      </div>
      <form className="git-quick-commit" onSubmit={event => { event.preventDefault(); const submitted = shared.draft; const message = submitted.trim(); if (message) void shared.execute({ kind: "commit", message }).then(ok => { if (ok) shared.setDraft(current => current === submitted ? "" : current); }); }}>
        <textarea rows={1} aria-label={zh ? "提交信息" : "Commit message"} placeholder={zh ? "提交信息…" : "Commit message…"} value={shared.draft} onChange={event => { shared.setDraft(event.target.value); event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 64)}px`; }} />
        <button type="submit" className="btn small primary" disabled={shared.busy || !staged.length || !shared.draft.trim()}>{zh ? "提交" : "Commit"}</button>
      </form>
      <div className="git-quick-pr">
        {read.items?.[0] && read.repository ? itemRow(read.items[0], read.repository) : <button type="button" className="git-quick-pr-empty" {...(read.error ? { "data-tip": read.error } : {})} onClick={() => navigate({ view: "pr", ...(remote ? { remote } : {}) })}>{read.loading ? zh ? "正在读取 PR…" : "Loading PR…" : read.error ?? (zh ? "当前分支暂无开放 PR" : "No open PR for this branch")}</button>}
        {read.items?.[0] && (read.branchCount ?? 0) > 1 ? <button type="button" className="git-quick-more-pr" onClick={() => navigate({ view: "pr", remote, search: `head:${repository.branch}` })}>{zh ? "其他匹配 PR" : "Other matching PRs"} ›</button> : null}
      </div>
      </> : <>
        <div className="git-quick-caption">
          <span>{view === "history" ? zh ? "最近提交" : "Recent commits" : `${zh ? "开放" : "Open"} · ${remote || "—"}`}</span>
          {view === "history" ? <div className="git-quick-tabs git-quick-history-tabs" role="tablist" aria-label={zh ? "历史显示方式" : "History display"}>
            {([ { layout: "list", icon: "tool-list", label: zh ? "列表视图" : "List view" }, { layout: "graph", icon: "fork", label: zh ? "历史树" : "History graph" } ] as const).map(tab => <button type="button" key={tab.layout} id={`${tabsId}-history-${tab.layout}`} role="tab" aria-label={tab.label} data-tip={tab.label} aria-controls={`${tabsId}-history-panel`} aria-selected={historyLayout === tab.layout} tabIndex={historyLayout === tab.layout ? 0 : -1} onClick={() => chooseHistoryLayout(tab.layout)} onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "list" : event.key === "End" ? "graph" : tab.layout === "list" ? "graph" : "list";
              chooseHistoryLayout(next); doc.getElementById(`${tabsId}-history-${next}`)?.focus();
            }}><Icon name={tab.icon} extra="sm" /></button>)}
          </div> : null}
        </div>
        {read.loading ? <p className="git-quick-empty" role="status">{zh ? "正在读取…" : "Loading…"}</p> : read.error ? <p className="git-quick-error" role="status">{read.error}</p> : view === "history" ? <div className="git-quick-history" role="tabpanel" id={`${tabsId}-history-panel`} aria-labelledby={`${tabsId}-history-${historyLayout}`}>
          {historyLayout === "list" ? read.log?.commits.map(commit => <div className="git-quick-commit-row" key={commit.oid}>
            <button type="button" className="git-quick-commit-main" data-tip={commit.subject} onClick={() => navigate({ view: "history" })}>
              <Icon name="commit" extra="sm" /><span className="git-quick-commit-text"><span>{commit.subject}</span><small><code>{commit.oid.slice(0, 7)}</code><span className="git-quick-author">{commit.authorName}</span><time dateTime={commit.authorDate} data-tip={new Date(commit.authorDate).toLocaleString()}>{relativeTime(commit.authorDate, zh)}</time></small></span>
            </button>
            {commitReferenceButton(commit)}
          </div>) : graphRows.map(row => <div className="git-quick-commit-row git-quick-tree-row" key={row.id}>
            <GitGraphSvg row={row} />
            {row.commit ? <>
              <button type="button" className="git-quick-tree-main" data-tip={row.subject} onClick={() => navigate({ view: "history" })}>
                <span className="git-quick-tree-subject">{row.subject}</span>
                <span className="git-quick-tree-refs">{row.refs.filter(ref => ref.kind !== "head").map(ref => <span key={`${ref.kind}-${ref.name}`} className={gitRefClass(ref)} data-tip={ref.name}><span className="git-ref-sizer" aria-hidden="true">{ref.name}</span><span className="git-ref-clip"><span className="git-ref-scroll">{ref.name}</span></span></span>)}</span>
              </button>
              {commitReferenceButton(row.commit)}
            </> : <span className="git-quick-tree-synthetic">{row.kind === "outgoing-changes" ? t("git.outgoingChanges") : t("git.incomingChanges")}</span>}
          </div>)}
          {!read.log?.commits.length ? <p className="git-quick-empty">{zh ? "暂无提交" : "No commits yet"}</p> : null}
        </div> : <div className="git-quick-items">
          {read.items?.map(item => read.repository ? itemRow(item, read.repository) : null)}
          {!read.items?.length ? <p className="git-quick-empty">{view === "issue" ? zh ? "暂无开放 Issue" : "No open issues" : zh ? "暂无开放 PR" : "No open pull requests"}</p> : null}
        </div>}
      </>}
    </>}
    </div>
    {shared.notice ? <p className="git-quick-notice" role="status">{shared.notice}</p> : null}
    {shared.busy ? <div className="git-quick-progress" role="status">{zh ? "正在执行…" : "Working…"}{shared.activeRequest ? <button type="button" onClick={() => void shared.cancel()}>{zh ? "取消" : "Cancel"}</button> : null}</div> : null}
    {referenceError ? <p role="alert" className="git-quick-error">{referenceError}</p> : null}
    <div className="git-quick-footer">
      <button type="button" onClick={openView}>{zh ? "查看全部" : "View all"} <Icon name="chevron-r" extra="sm" /></button>
      {repository ? <span className="git-quick-sync" data-tip={zh ? `领先 ${repository.ahead} · 落后 ${repository.behind}` : `${repository.ahead} ahead · ${repository.behind} behind`}>↑{repository.ahead} ↓{repository.behind}</span> : null}
      <span className="spacer" />{sync("Fetch", "refresh", "fetch")}{sync("Pull", "arrow-d", "pull")}{sync("Push", "arrow-u", "push")}
      <button ref={menuButton} type="button" className="icon-btn small" aria-label={zh ? "更多 Git 操作" : "More Git actions"} data-tip={zh ? "更多操作" : "More actions"} aria-expanded={!!menu} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu(menu ? undefined : { top: Math.max(8, Math.min(rect.bottom + 4, (doc.defaultView?.innerHeight ?? window.innerHeight) - 128)), left: Math.max(8, rect.right - 190) }); }}><Icon name="more" extra="sm" /></button>
    </div>
  </section>;
}

function relativeTime(value: string, zh: boolean) {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(zh ? "zh-CN" : "en", { numeric: "auto", style: "narrow" });
  if (seconds < 60) return zh ? "刚刚" : "now";
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), "hour");
  return formatter.format(-Math.floor(seconds / 86400), "day");
}
