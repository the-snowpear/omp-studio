import { useEffect, useMemo, useRef, useState } from "react";
import type { GitHubAuthReadModel, GitHubComment, GitHubFile, GitHubFileDiff, GitHubItem, GitHubItemDetail, GitHubItemKind, GitHubItemPage, GitHubListInput, GitHubOperation, GitHubReference, GitHubRepository, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { MarkdownText } from "../conversation/markdown";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewGithubSource } from "../preview/githubPreview";
import { githubSource, type GitHubSource } from "./githubSource";
import { useOptionalGitWorkspace } from "./GitWorkspaceContext";
import type { GitOpenIntent } from "./GitWorkbench";

export function GitHubPanel({ client, workspaceId, kind, onReference, visible = true, intent }: {
  client: StudioClient; workspaceId?: WorkspaceId; kind: GitHubItemKind; visible?: boolean; intent?: GitOpenIntent; onReference: (reference: GitHubReference) => void;
}) {
  const { t } = useI18n();
  const { preview, marks } = usePreviewMode();
  const source = useMemo(() => preview ? previewGithubSource : githubSource(client), [preview, client]);
  const target = preview ? "preview-git" as WorkspaceId : workspaceId;
  const [repositories, setRepositories] = useState<readonly GitHubRepository[]>();
  const shared = useOptionalGitWorkspace();
  const [localRemote, setLocalRemote] = useState("");
  const remote = shared?.remote ?? localRemote;
  const setRemote = shared?.setRemote ?? setLocalRemote;
  const remoteRef = useRef(remote);
  const authGeneration = useRef(0);
  if (remoteRef.current !== remote) { remoteRef.current = remote; authGeneration.current++; }
  const [pendingRemote, setPendingRemote] = useState(intent?.remote);
  const [detailIntent, setDetailIntent] = useState(intent);
  const [auth, setAuth] = useState<GitHubAuthReadModel>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loginBusy, setLoginBusy] = useState(false);
  useEffect(() => { setLoginBusy(false); return () => { authGeneration.current++; }; }, [remote, target]);
  const repository = repositories?.find(repo => repo.remote === remote);
  useEffect(() => {
    if (!visible || !target) return;
    let current = true;
    setError(""); setRepositories(undefined);
    void source.query("github.repositories.list", { workspaceId: target }).then(result => {
      if (!current) return;
      setRepositories(result.repositories);
      setRemote(prior => result.repositories.some(repo => repo.remote === prior) ? prior : (result.repositories.find(repo => repo.remote === "origin") ?? result.repositories[0])?.remote ?? "");
    }, cause => { if (current) setError(hostErrorMessage(cause, t("github.failed"))); });
    return () => { current = false; };
  }, [source, target, refresh, visible]);
  useEffect(() => { setPendingRemote(intent?.remote); setDetailIntent(intent); }, [intent?.key]);
  useEffect(() => {
    if (!pendingRemote || !repositories) return;
    if (repositories.some(repo => repo.remote === pendingRemote)) setRemote(pendingRemote);
    setPendingRemote(undefined);
  }, [pendingRemote, repositories, setRemote]);
  useEffect(() => {
    if (!target || !remote || !visible) return;
    let current = true;
    setAuth(undefined); setError("");
    void source.query("github.auth.get", { workspaceId: target, remote }).then(value => { if (current) setAuth(value); }, cause => { if (current) setError(hostErrorMessage(cause, t("github.failed"))); });
    return () => { current = false; };
  }, [source, target, remote, refresh, visible]);
  const login = async () => {
    const generation = authGeneration.current;
    const currentRemote = remote;
    setLoginBusy(true); setError("");
    try {
      if (!preview) {
        const handle = await client.command("github.execute", { operation: { kind: "auth.login", host: repository?.host ?? "github.com" } });
        await waitReceipt(client, handle.requestId);
      }
      if (authGeneration.current === generation && remoteRef.current === currentRemote) setRefresh(value => value + 1);
    } catch (cause) { if (authGeneration.current === generation && remoteRef.current === currentRemote) setError(hostErrorMessage(cause, t("github.failed"))); }
    finally { if (authGeneration.current === generation && remoteRef.current === currentRemote) setLoginBusy(false); }
  };
  if (!target) return <div className="gh-empty">{t("github.chooseProject")}</div>;
  return <div className="github-panel">
    <div className="gh-repository-row">
      <Icon name="link" extra="sm" />
      {repositories?.length ? <AppSelect aria-label={t("github.remote")} value={remote} onChange={event => { setDetailIntent(undefined); setRemote(event.target.value); }}>
        {repositories.map(repo => <option value={repo.remote} key={repo.remote}>{repo.ownerRepo} · {repo.remote}</option>)}
      </AppSelect> : <span className="muted">GitHub</span>}
      {preview && marks ? <span className="chip gray xs">{t("github.demo")}</span> : null}
      <button type="button" className="icon-btn small" aria-label={t("github.refresh")} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" extra="sm" /></button>
    </div>
    {error ? <div role="alert" className="gh-error">{error}<button className="btn small outline" onClick={() => setRefresh(value => value + 1)}>{t("github.retry")}</button></div> : null}
    {!repositories && !error ? <div className="gh-empty" role="status">{t("github.loading")}</div> : repositories?.length === 0 ? <div className="gh-empty">{t("github.noRemote")}</div> : !auth && !error ? <div className="gh-empty" role="status">{t("github.loading")}</div> : auth && !auth.authenticated ? <div className="gh-empty">
      <p>{auth.available ? t("github.signInNeeded") : t("github.cliMissing")}</p><p className="muted">{auth.unavailableReason}</p>
      {auth.available ? <button className="btn small primary" disabled={loginBusy} onClick={() => void login()}>{t("github.signIn")}</button> : <a href="https://cli.github.com/" target="_blank" rel="noreferrer">{t("github.getCli")}</a>}
    </div> : repository && auth?.authenticated && (!pendingRemote || remote === pendingRemote) ? <GitHubCollection key={`${target}:${repository.host}:${repository.ownerRepo}:${repository.remote}:${kind}:${refresh}`} source={source} client={client} workspaceId={target} repository={repository} kind={kind} preview={preview} {...(detailIntent ? { intent: detailIntent } : {})} onReference={onReference} /> : null}
  </div>;
}

function GitHubCollection({ source, client, workspaceId, repository, kind, preview, onReference, intent }: {
  source: GitHubSource; client: StudioClient; workspaceId: WorkspaceId; repository: GitHubRepository; kind: GitHubItemKind; preview: boolean; intent?: GitOpenIntent; onReference: (reference: GitHubReference) => void;
}) {
  const { t, resolvedLanguage } = useI18n();
  const { marks } = usePreviewMode();
  const [filter, setFilter] = useState<Pick<GitHubListInput, "search" | "label" | "state" | "assignedToMe" | "reviewRequested">>({ state: "open", ...(intent?.search ? { search: intent.search } : {}) });
  const [search, setSearch] = useState(intent?.search ?? "");
  const [label, setLabel] = useState("");
  const [page, setPage] = useState<GitHubItemPage>();
  const [listBusy, setListBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<number | undefined>(intent?.number);
  const [detail, setDetail] = useState<GitHubItemDetail>();
  const [comments, setComments] = useState<readonly GitHubComment[]>([]);
  const [commentPage, setCommentPage] = useState<number>();
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [files, setFiles] = useState<readonly GitHubFile[]>();
  const [filePage, setFilePage] = useState<number>();
  const [diffs, setDiffs] = useState<Record<string, GitHubFileDiff>>({});
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [included, setIncluded] = useState<ReadonlySet<string>>(new Set());
  const [detailTab, setDetailTab] = useState("description");
  const [operationBusy, setOperationBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mergePending, setMergePending] = useState(false);
  const alive = useRef(true);
  const listVersion = useRef(0);
  const detailVersion = useRef(0);
  const target = { workspaceId, remote: repository.remote };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!intent) return;
    setSelected(intent.number);
    setSearch(intent.search ?? "");
    setFilter({ state: "open", ...(intent.search ? { search: intent.search } : {}) });
  }, [intent?.key]);
  const errorText = (cause: unknown) => hostErrorMessage(cause, t("github.failed")).includes("PR_HEAD_CHANGED") ? t("github.headChanged") : hostErrorMessage(cause, t("github.failed"));

  useEffect(() => {
    const version = ++listVersion.current;
    setListBusy(true); setPage(undefined); setError("");
    void source.query("github.items.list", { ...target, kind, ...filter }).then(value => {
      if (alive.current && version === listVersion.current) setPage(value);
    }, cause => { if (alive.current && version === listVersion.current) setError(errorText(cause)); }).finally(() => {
      if (alive.current && version === listVersion.current) setListBusy(false);
    });
    return () => { listVersion.current++; };
  }, [source, workspaceId, repository.remote, kind, filter, revision]);

  useEffect(() => {
    const version = ++detailVersion.current;
    setDetail(undefined); setComments([]); setFiles(undefined); setDiffs({}); setOpened(new Set()); setIncluded(new Set()); setDetailError(""); setDetailTab("description"); setMergePending(false); setOperationBusy(false);
    if (selected === undefined) return;
    setDetailBusy(true);
    const input = { ...target, kind, number: selected };
    void Promise.all([source.query("github.items.get", input), source.query("github.discussion.list", input)]).then(([value, discussion]) => {
      if (!alive.current || version !== detailVersion.current) return;
      setDetail(value); setComments(discussion.comments); setCommentPage(discussion.nextPage);
    }, cause => { if (alive.current && version === detailVersion.current) setDetailError(errorText(cause)); }).finally(() => {
      if (alive.current && version === detailVersion.current) setDetailBusy(false);
    });
    return () => { detailVersion.current++; };
  }, [source, workspaceId, repository.remote, kind, selected, revision]);

  const add = async (row: GitHubItem) => {
    const version = detailVersion.current;
    setOperationBusy(true); setNotice("");
    try {
      const current = detail?.item.number === row.number;
      const [value, discussion] = current ? [detail!, { comments }] : await Promise.all([
        source.query("github.items.get", { ...target, kind, number: row.number }), source.query("github.discussion.list", { ...target, kind, number: row.number }),
      ]);
      if (!alive.current || version !== detailVersion.current) return;
      onReference({ repository: value.repository, item: value.item, comments: discussion.comments, checks: value.checks, capturedAt: new Date().toISOString(),
        diffs: current ? [...included].flatMap(path => diffs[path] ? [diffs[path]!] : []) : [] });
      setNotice(t("github.added"));
    } catch (cause) { if (alive.current) setNotice(errorText(cause)); }
    finally { if (alive.current) setOperationBusy(false); }
  };

  const moreItems = async () => {
    if (!page?.nextCursor) return;
    const version = listVersion.current;
    setListBusy(true);
    try {
      const next = await source.query("github.items.list", { ...target, kind, ...filter, cursor: page.nextCursor });
      if (alive.current && version === listVersion.current) setPage(prior => ({ ...next, items: [...(prior?.items ?? []), ...next.items.filter(row => !prior?.items.some(item => item.number === row.number))] }));
    } catch (cause) { if (alive.current && version === listVersion.current) setError(errorText(cause)); }
    finally { if (alive.current && version === listVersion.current) setListBusy(false); }
  };

  const loadFiles = async (nextPage = 1) => {
    if (!detail?.item.headOid) return;
    const version = detailVersion.current;
    setOperationBusy(true); setDetailError("");
    try {
      const next = await source.query("github.pr.files", { ...target, number: detail.item.number, headOid: detail.item.headOid, page: nextPage });
      if (alive.current && version === detailVersion.current) { setFiles(prior => nextPage === 1 ? next.files : [...(prior ?? []), ...next.files]); setFilePage(next.nextPage); }
    } catch (cause) { if (alive.current && version === detailVersion.current) setDetailError(errorText(cause)); }
    finally { if (alive.current && version === detailVersion.current) setOperationBusy(false); }
  };
  const toggleFile = async (path: string) => {
    setOpened(prior => { const next = new Set(prior); next.has(path) ? next.delete(path) : next.add(path); return next; });
    if (diffs[path] || !detail?.item.headOid) return;
    const version = detailVersion.current;
    setOperationBusy(true); setDetailError("");
    try {
      const value = await source.query("github.pr.diff", { ...target, number: detail.item.number, headOid: detail.item.headOid, path });
      if (alive.current && version === detailVersion.current) setDiffs(prior => ({ ...prior, [path]: value }));
    } catch (cause) { if (alive.current && version === detailVersion.current) setDetailError(errorText(cause)); }
    finally { if (alive.current && version === detailVersion.current) setOperationBusy(false); }
  };
  const moreComments = async () => {
    if (!detail || !commentPage) return;
    const version = detailVersion.current;
    setOperationBusy(true);
    try {
      const next = await source.query("github.discussion.list", { ...target, kind, number: detail.item.number, page: commentPage });
      if (alive.current && version === detailVersion.current) { setComments(prior => [...prior, ...next.comments.filter(row => !prior.some(old => old.id === row.id))].sort((a, b) => a.createdAt.localeCompare(b.createdAt))); setCommentPage(next.nextPage); }
    } catch (cause) { if (alive.current && version === detailVersion.current) setDetailError(errorText(cause)); }
    finally { if (alive.current && version === detailVersion.current) setOperationBusy(false); }
  };
  const execute = async (operation: GitHubOperation) => {
    const version = detailVersion.current;
    setOperationBusy(true);
    try {
      if (preview) {
        if (operation.kind === "pr.ready") setDetail(prior => prior ? { ...prior, item: { ...prior.item, draft: false } } : prior);
        if (operation.kind === "pr.merge") { setDetail(prior => prior ? { ...prior, item: { ...prior.item, state: "merged" } } : prior); setMergePending(false); }
        if (operation.kind === "pr.ready" || operation.kind === "pr.merge") setPage(prior => prior ? { ...prior, items: prior.items.map(row => row.number === operation.number ? { ...row, ...(operation.kind === "pr.ready" ? { draft: false } : { state: "merged" as const }) } : row) } : prior);
        if (marks) setNotice(t("github.previewAction"));
      } else {
        const handle = await client.command("github.execute", { ...target, operation });
        await waitReceipt(client, handle.requestId);
        if (alive.current && version === detailVersion.current) setRevision(value => value + 1);
      }
    } catch (cause) { if (alive.current && version === detailVersion.current) setDetailError(errorText(cause)); }
    finally { if (alive.current && version === detailVersion.current) setOperationBusy(false); }
  };
  const date = (value: string) => value ? new Date(value).toLocaleDateString(resolvedLanguage === "zh" ? "zh-CN" : "en-US") : "";
  const rowState = (row: GitHubItem) => row.draft ? t("github.draft") : t(`github.${row.state}`);
  const status = (value: string | undefined) => {
    if (!value) return t("github.noStatus");
    const key = `github.status.${value}`;
    const translated = t(key);
    return translated === key ? value : translated;
  };
  return <>
    <form className={`gh-filters${selected === undefined ? "" : " has-selection"}`} onSubmit={event => { event.preventDefault(); setFilter(prior => ({ ...prior, search, label })); }}>
      <div className="gh-search"><input aria-label={t("github.search")} placeholder={t("github.search")} value={search} onChange={event => setSearch(event.target.value)} /><button className="icon-btn small" aria-label={t("github.search")} type="submit"><Icon name="search" extra="sm" /></button></div>
      <div className="gh-filter-row"><AppSelect aria-label={t("github.state")} value={filter.state} onChange={event => setFilter(prior => ({ ...prior, state: event.target.value as NonNullable<GitHubListInput["state"]> }))}>
        {["open", "closed", ...(kind === "pr" ? ["merged"] : []), "all"].map(state => <option key={state} value={state}>{t(`github.${state}`)}</option>)}
      </AppSelect><input aria-label={t("github.label")} placeholder={t("github.label")} value={label} onChange={event => setLabel(event.target.value)} onBlur={() => setFilter(prior => ({ ...prior, label }))} />
      <label><input type="checkbox" checked={filter.assignedToMe ?? false} onChange={event => setFilter(prior => ({ ...prior, assignedToMe: event.target.checked }))} />{t("github.assigned")}</label>
      {kind === "pr" ? <label><input type="checkbox" checked={filter.reviewRequested ?? false} onChange={event => setFilter(prior => ({ ...prior, reviewRequested: event.target.checked }))} />{t("github.reviewRequested")}</label> : null}</div>
    </form>
    {notice ? <div className="gh-notice" role="status">{notice}</div> : null}
    <div className={`gh-browser${selected === undefined ? "" : " has-detail"}`}>
      <div className="gh-list-pane">
        <div className="gh-list-caption">{kind === "issue" ? "Issues" : "PR"} <span>{page?.totalCount ?? "—"}</span><span className="spacer" /><span>{t("github.updated")}</span></div>
        {error ? <div className="gh-error" role="alert">{error}<button className="btn small outline" onClick={() => setRevision(value => value + 1)}>{t("github.retry")}</button></div> : null}
        {listBusy && !page ? <div className="gh-empty" role="status">{t("github.loading")}</div> : page?.items.length === 0 ? <div className="gh-empty">{t("github.empty")}</div> : null}
        {page?.items.map(row => <div key={row.number} className={`gh-item${selected === row.number ? " selected" : ""}`}>
          <button type="button" className="gh-item-main" onClick={() => setSelected(row.number)} aria-current={selected === row.number ? "true" : undefined}>
            <span className="gh-item-title"><span className={`gh-state ${row.state}`} title={rowState(row)}><Icon name={kind === "pr" ? "branch" : "alert-c"} extra="sm" /></span><strong>{row.title}</strong></span>
            <span className="gh-item-meta">#{row.number} · {rowState(row)} · {row.author} · {date(row.updatedAt)} · {row.commentCount} {t("github.comments")}</span>
            {row.labels.length ? <span className="gh-labels">{row.labels.map(name => <span key={name}>{name}</span>)}</span> : null}
            {kind === "pr" ? <span className="gh-item-meta">CI: {status(row.checkState)} · {status(row.reviewDecision)}</span> : null}
          </button>
          <button type="button" className="icon-btn small gh-add" disabled={operationBusy} title={t("github.add")} aria-label={`${t("github.add")} #${row.number}`} onClick={() => void add(row)}><Icon name="at" extra="sm" /></button>
        </div>)}
        {page?.nextCursor ? <button className="btn small outline gh-load-more" disabled={listBusy} onClick={() => void moreItems()}>{t("github.more")}</button> : null}
      </div>
      <section className="gh-detail-pane" aria-label={t("github.detail")}>
        {selected === undefined ? <div className="gh-empty">{t("github.selectItem")}</div> : <>
          <div className="gh-detail-actions"><button type="button" className="icon-btn small gh-back" aria-label={t("github.back")} title={t("github.back")} onClick={() => setSelected(undefined)}><Icon name="chevron-l" /></button><span className="spacer" />
            <button className="icon-btn small" aria-label={t("github.refresh")} onClick={() => setRevision(value => value + 1)}><Icon name="refresh" extra="sm" /></button>
            {detail ? <><a href={detail.item.url} target="_blank" rel="noreferrer" className="icon-btn small" aria-label={t("github.openGithub")} title={t("github.openGithub")}><Icon name="github" /></a><button type="button" className="icon-btn small gh-reference-action" aria-label={t("github.add")} title={t("github.add")} disabled={operationBusy} onClick={() => void add(detail.item)}><Icon name="at" /></button></> : null}
          </div>
          {detailError ? <div className="gh-error" role="alert">{detailError}<button className="btn small outline" onClick={() => setRevision(value => value + 1)}>{t("github.refresh")}</button></div> : null}
          {detailBusy ? <div className="gh-empty" role="status">{t("github.loading")}</div> : detail ? <>
            <header className="gh-detail-heading"><span className={`gh-state ${detail.item.state}`}>{rowState(detail.item)} · #{detail.item.number}</span><h3>{detail.item.title}</h3><p className="muted">{detail.item.author} · {date(detail.item.updatedAt)}</p>
              {kind === "pr" ? <><p className="gh-branches">{detail.item.headBranch} → {detail.item.baseBranch}</p><p className="muted">{detail.item.changedFiles} {t("github.files")} · +{detail.item.additions} −{detail.item.deletions} · {status(detail.item.reviewDecision)}</p><div className="gh-pr-actions"><button className="btn small outline" disabled={operationBusy} onClick={() => void execute({ kind: "pr.checkout", number: detail.item.number })}>{t("github.checkout")}</button>{detail.item.draft ? <button className="btn small outline" disabled={operationBusy} onClick={() => void execute({ kind: "pr.ready", number: detail.item.number })}>{t("github.ready")}</button> : null}{detail.item.state === "open" && !detail.item.draft ? <button className="btn small outline" disabled={operationBusy || !detail.item.headOid} onClick={() => setMergePending(true)}>{t("github.merge")}</button> : null}</div>
                {mergePending ? <div className="gh-merge-confirm"><p>{t("github.confirmMerge")}</p><button className="btn small primary" disabled={operationBusy} onClick={() => void execute({ kind: "pr.merge", number: detail.item.number, method: "squash", expectedHeadOid: detail.item.headOid! })}>{t("github.merge")}</button><button className="btn small outline" onClick={() => setMergePending(false)}>{t("common.cancel")}</button></div> : null}</> : null}
            </header>
            <div className="gh-detail-tabs" role="tablist" aria-label={t("github.detail")}>
              {["description", "discussion", ...(kind === "pr" ? ["checks", "files"] : [])].map(tab => <button type="button" role="tab" aria-selected={detailTab === tab} key={tab} onClick={() => { setDetailTab(tab); if (tab === "files" && files === undefined && !operationBusy) void loadFiles(); }}>{t(`github.${tab}`)}{tab === "discussion" ? ` (${comments.length})` : ""}</button>)}
            </div>
            <div className="gh-detail-body" role="tabpanel">
              {detailTab === "description" ? <MarkdownText text={detail.item.body || t("github.noDescription")} /> : null}
              {detailTab === "discussion" ? <><p className="muted">{t("github.loadedComments", { count: comments.length })}</p>{comments.map(comment => <article className="gh-comment" key={comment.id}><div><strong>{comment.author}</strong><span className="muted">{date(comment.createdAt)} {comment.state ? status(comment.state) : ""}</span><a href={comment.url} target="_blank" rel="noreferrer" aria-label={t("github.openGithub")}><Icon name="link" extra="sm" /></a></div>{comment.path ? <p className="gh-comment-path">{comment.path}{comment.line ? `:${comment.line}` : ""}</p> : null}<MarkdownText text={comment.body} /></article>)}{commentPage ? <button className="btn small outline" disabled={operationBusy} onClick={() => void moreComments()}>{t("github.more")}</button> : null}</> : null}
              {detailTab === "checks" ? detail.checks.length ? <ul className="gh-checks">{detail.checks.map((check, index) => <li key={`${check.name}:${index}`}><span className={`gh-check ${check.bucket}`}>{status(check.state)}</span>{check.link ? <a href={check.link} target="_blank" rel="noreferrer">{check.name}</a> : <span>{check.name}</span>}</li>)}</ul> : <p className="muted">{t("github.noChecks")}</p> : null}
              {detailTab === "files" ? <><p className="muted">{t("github.diffHint")}</p>{files === undefined && operationBusy ? <p role="status">{t("github.loading")}</p> : null}{files?.map(file => <article className="gh-file" key={file.path}>
                <button className="gh-file-head" disabled={operationBusy} aria-expanded={opened.has(file.path)} onClick={() => void toggleFile(file.path)}><Icon name={opened.has(file.path) ? "chevron-d" : "chevron-r"} extra="sm" /><span>{file.path}</span><span>+{file.additions} −{file.deletions}</span></button>
                {opened.has(file.path) ? diffs[file.path] ? <>{diffs[file.path]!.patch ? <><label className="gh-include"><input type="checkbox" checked={included.has(file.path)} onChange={event => setIncluded(prior => { const next = new Set(prior); event.target.checked ? next.add(file.path) : next.delete(file.path); return next; })} />{t("github.includeDiff")}</label><pre className="gh-patch">{diffs[file.path]!.patch.split("\n").map((line, index) => <div key={index} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}>{line || " "}</div>)}</pre></> : <p className="muted">{t("github.noPatch")}</p>}</> : <p role="status">{operationBusy ? t("github.loading") : t("github.retryDiff")}</p> : null}
              </article>)}{filePage ? <button className="btn small outline" disabled={operationBusy} onClick={() => void loadFiles(filePage)}>{t("github.more")}</button> : null}</> : null}
            </div>
          </> : null}
        </>}
      </section>
    </div>
  </>;
}
