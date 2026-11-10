import { useMemo, useState } from "react";

import type { GitCommitChangeRecord, GitCommitChangesReadModel, GitCommitDiffReadModel, GitLogListReadModel, GitLogRef } from "@omp-studio/client-contract";

import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { useWideLayout } from "../layout/useWideLayout";
import { fileTypeOf, iconNameFor } from "../explorer-types";
import { DiffDisplayMode } from "../conversation/ChangesPanel";
import { splitDisplayPath } from "../conversation/toolMeta";
import { GitPatch } from "./GitPatch";

import { buildGitGraphRows, GRAPH_COLORS, renderGraphRow, renderGraphThroughLanes, SWIMLANE_HEIGHT, SWIMLANE_WIDTH, type GraphRow } from "./gitGraphLayout";

/** From this width the history becomes a log beside the selected commit's files and diff. */
const GIT_GRAPH_WIDE_MIN = 860;
const FILE_STATUS: Record<GitCommitChangeRecord["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C" };

export function gitRefClass(ref: GitLogRef): string {
  if (ref.kind === "head" || (ref.kind === "local" && ref.current)) return "git-ref local";
  if (ref.kind === "remote") return "git-ref remote";
  if (ref.kind === "tag") return "git-ref tag";
  return "git-ref";
}

export function GitGraphSvg({ row }: { readonly row: GraphRow }) {
  const rendered = renderGraphRow(row);
  return (
    <svg className="git-graph-svg" width={rendered.width} height={rendered.height} aria-hidden="true">
      {rendered.paths.map((path, index) => (
        <path key={`${path.d}-${index}`} d={path.d} fill="none" stroke={path.color} strokeWidth={path.strokeWidth} strokeLinecap="round" />
      ))}
      {rendered.circles.map((circle, index) => (
        <circle
          key={`${circle.index}-${circle.radius}-${index}`}
          cx={SWIMLANE_WIDTH * (circle.index + 1)}
          cy={SWIMLANE_WIDTH}
          r={circle.radius}
          fill={circle.fill ?? "transparent"}
          stroke={circle.color}
          strokeWidth={circle.strokeWidth}
          strokeDasharray={circle.dashed ? "4 2" : undefined}
        />
      ))}
    </svg>
  );
}

function GraphLaneExtend({ row }: { readonly row: GraphRow }) {
  const rendered = renderGraphThroughLanes(row);
  if (rendered.paths.length === 0) return <div className="git-graph-lane-extend" />;
  return (
    <svg
      className="git-graph-lane-extend"
      width={rendered.width}
      viewBox={`0 0 ${rendered.width} 1`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {rendered.paths.map((path, index) => (
        <path key={`${path.d}-${index}`} d={path.d} fill="none" stroke={path.color} strokeWidth={path.strokeWidth} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

function patchLines(patch: string) {
  return patch.split(/\r?\n/u).map((line, index) => {
    const tone = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
    return <div key={`${index}-${line}`} className={`dl ${tone}`}><span className="dm">{tone === "add" ? "+" : tone === "del" ? "−" : " "}</span><span className="lc">{line}</span></div>;
  });
}

export function GitCommitGraph({
  model,
  loading,
  error,
  preview,
  busy,
  selectedOid,
  changes,
  changesLoading,
  selectedPath,
  diff,
  onRefresh,
  onSelectCommit,
  onSelectFile,
  onLoadMore,
  onCherryPick,
  onRevert,
  onCheckout,
  onCreateBranch,
}: {
  readonly model?: GitLogListReadModel;
  readonly loading?: boolean;
  readonly error?: string;
  readonly preview?: boolean;
  readonly busy?: boolean;
  readonly selectedOid?: string;
  readonly changes?: GitCommitChangesReadModel;
  readonly changesLoading?: boolean;
  readonly selectedPath?: string;
  readonly diff?: GitCommitDiffReadModel;
  readonly onRefresh?: () => void;
  readonly onSelectCommit: (oid: string | undefined) => void;
  readonly onSelectFile: (path: string | undefined) => void;
  readonly onLoadMore?: () => void;
  readonly onCherryPick?: (oid: string) => void;
  readonly onRevert?: (oid: string) => void;
  readonly onCheckout?: (oid: string) => void;
  readonly onCreateBranch?: (oid: string, name: string) => void;
}) {
  const rows = useMemo(() => (model ? buildGitGraphRows(model) : []), [model]);
  const [menuOid, setMenuOid] = useState<string>();
  const { t } = useI18n();
  const [branchOid, setBranchOid] = useState<string>();
  const [branchName, setBranchName] = useState("");
  const [rootRef, wide] = useWideLayout<HTMLDivElement>(GIT_GRAPH_WIDE_MIN);

  const copyOid = async (oid: string) => {
    try { await navigator.clipboard.writeText(oid); } catch { /* clipboard blocked */ }
    setMenuOid(undefined);
  };

  const fileLabel = (file: GitCommitChangeRecord) => {
    if (file.status === "renamed" && file.originalPath) return `${file.originalPath} → ${file.path}`;
    return file.path;
  };

  if (loading && model === undefined) return <div className="empty" style={{ padding: 12 }}>{t("git.readingCommitHistory")}</div>;
  if (error) return <div className="empty" style={{ padding: 12 }}><p>{error}</p>{onRefresh ? <button type="button" className="btn small outline" onClick={onRefresh}>{t("common.retry")}</button> : null}</div>;
  if (!model || rows.length === 0) return <div className="empty" style={{ padding: 12 }}>{t("git.noCommitHistory")}</div>;

  return (
    <div className={`git-graph${wide ? " is-wide" : ""}`} ref={rootRef}>
    <div className="git-graph-list">
      {rows.map((row) => {
        const synthetic = row.kind === "incoming-changes" || row.kind === "outgoing-changes";
        const selected = selectedOid === row.id;
        const pills = row.refs.filter((ref) => ref.kind !== "head");
        return (
          <div key={row.id} className={`git-graph-block${selected ? " selected" : ""}`}>
            <div className="git-graph-lane">
              <GitGraphSvg row={row} />
              <GraphLaneExtend row={row} />
            </div>
            <div className="git-graph-col">
            <div className={`git-graph-row${menuOid === row.id ? " is-menu" : ""}`} style={{ minHeight: SWIMLANE_HEIGHT }}>
              <button
                type="button"
                className={`git-graph-subject${synthetic ? " synthetic" : ""}`}
                disabled={synthetic}
                onClick={() => {
                  if (synthetic) return;
                  onSelectCommit(selected ? undefined : row.id);
                  onSelectFile(undefined);
                  setMenuOid(undefined);
                }}
              >
                <span className="git-graph-subject-scroll">
                  {row.kind === "outgoing-changes"
                    ? t("git.outgoingChanges")
                    : row.kind === "incoming-changes"
                      ? t("git.incomingChanges")
                      : row.subject}
                </span>
              </button>
              {pills.length > 0 ? (
                <div className="git-graph-refs">
                  {pills.map((ref) => (
                    <span key={`${ref.kind}-${ref.name}`} className={gitRefClass(ref)} style={ref.kind === "remote" ? { background: GRAPH_COLORS.remote } : ref.current ? { background: GRAPH_COLORS.local } : undefined}>
                      <span className="git-ref-sizer" aria-hidden="true">{ref.name}</span>
                      <span className="git-ref-clip"><span className="git-ref-scroll">{ref.name}</span></span>
                    </span>
                  ))}
                </div>
              ) : null}
              {!synthetic ? (
                <button
                  type="button"
                  className="icon-btn small git-graph-op"
                  data-tip={t("common.actions")}
                  aria-label={t("git.commitActions")}
                  disabled={busy || preview}
                  onClick={() => setMenuOid(menuOid === row.id ? undefined : row.id)}
                >
                  <Icon name="more" extra="sm" />
                </button>
              ) : null}
            </div>
            {menuOid === row.id && row.commit ? (
              <div className="git-graph-menu" role="menu">
                <button type="button" role="menuitem" disabled={busy} onClick={() => { onCheckout?.(row.id); setMenuOid(undefined); }}>{t("git.checkoutCommit")}</button>
                <button type="button" role="menuitem" disabled={busy} onClick={() => { setBranchOid(row.id); setBranchName(""); setMenuOid(undefined); }}>{t("git.branchFromCommit")}</button>
                <button type="button" role="menuitem" disabled={busy} onClick={() => { onCherryPick?.(row.id); setMenuOid(undefined); }}>Cherry-pick</button>
                <button type="button" role="menuitem" disabled={busy} onClick={() => { onRevert?.(row.id); setMenuOid(undefined); }}>Revert</button>
                <button type="button" role="menuitem" onClick={() => void copyOid(row.id)}>{t("git.copyHash")}</button>
              </div>
            ) : null}
            {branchOid === row.id ? (
              <form
                className="git-graph-branch-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = branchName.trim();
                  if (!name) return;
                  onCreateBranch?.(row.id, name);
                  setBranchOid(undefined);
                  setBranchName("");
                }}
              >
                <input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder={t("git.newBranchPlaceholder")} autoFocus />
                <button type="submit" className="btn small primary" disabled={busy || !branchName.trim()}>{t("common.create")}</button>
                <button type="button" className="btn small outline" onClick={() => setBranchOid(undefined)}>{t("common.cancel")}</button>
              </form>
            ) : null}
            {selected && !synthetic && !wide ? (
              <div className="git-graph-details">
                {row.commit ? <div className="tiny muted">{row.commit.authorName} · {row.commit.oid.slice(0, 7)}</div> : null}
                {changesLoading ? <div className="empty" style={{ padding: 8 }}>{t("git.readingFileList")}</div> : null}
                {changes && changes.oid === row.id ? (
                  <div className="git-graph-files">
                    {changes.files.map((file) => (
                      <button
                        type="button"
                        key={file.path}
                        className={`git-graph-file${selectedPath === file.path ? " selected" : ""}`}
                        onClick={() => onSelectFile(selectedPath === file.path ? undefined : file.path)}
                      >
                        <span className="ch-note">{file.status}</span>
                        <span className="ellipsis">{fileLabel(file)}</span>
                      </button>
                    ))}
                    {changes.files.length === 0 ? <div className="empty" style={{ padding: 8 }}>{t("git.noFileChanges")}</div> : null}
                  </div>
                ) : null}
                {selectedPath && diff && diff.oid === row.id && diff.path === selectedPath ? (
                  <div className="git-graph-diff">
                    {diff.binary ? <div className="empty">Binary diff</div> : diff.patch.length === 0 ? <div className="empty">{t("git.noDiff")}</div> : patchLines(diff.patch)}
                    {diff.truncated ? <div className="tiny muted">{t("common.truncated")}</div> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            </div>
          </div>
        );
      })}
      {model.truncated && onLoadMore ? (
        <button type="button" className="btn small outline git-graph-more" disabled={loading || preview} onClick={onLoadMore}>加载更多</button>
      ) : null}
    </div>
    {wide ? <CommitDetail row={rows.find((row) => row.id === selectedOid && row.commit !== undefined)} changes={changes} changesLoading={changesLoading}
      selectedPath={selectedPath} diff={diff} onSelectFile={onSelectFile} onCopy={(oid) => void copyOid(oid)} fileLabel={fileLabel} /> : null}
    </div>
  );
}

/**
 * Wide history: the selected commit as a page — subject, author and refs, the
 * files it touched, and the chosen file's diff with line numbers. The same
 * reads as the inline details (`git.commit.changes` / `git.commit.diff`).
 */
function CommitDetail({ row, changes, changesLoading, selectedPath, diff, onSelectFile, onCopy, fileLabel }: {
  readonly row: GraphRow | undefined;
  readonly changes: GitCommitChangesReadModel | undefined;
  readonly changesLoading: boolean | undefined;
  readonly selectedPath: string | undefined;
  readonly diff: GitCommitDiffReadModel | undefined;
  readonly onSelectFile: (path: string | undefined) => void;
  readonly onCopy: (oid: string) => void;
  readonly fileLabel: (file: GitCommitChangeRecord) => string;
}) {
  const { t, resolvedLanguage } = useI18n();
  const [split, setSplit] = useState(false);
  const commit = row?.commit;
  if (!row || !commit) {
    return <section className="git-commit-detail is-empty"><div className="git-commit-placeholder"><Icon name="history" /><p>{t("git.pickCommit")}</p></div></section>;
  }
  const files = changes?.oid === row.id ? changes.files : undefined;
  const shownDiff = selectedPath && diff && diff.oid === row.id && diff.path === selectedPath ? diff : undefined;
  const date = new Date(commit.authorDate);
  const pills = row.refs.filter((ref) => ref.kind !== "head");
  return (
    <section className="git-commit-detail" aria-label={commit.subject}>
      <header className="git-commit-head">
        <h3 title={commit.subject}>{commit.subject}</h3>
        <div className="git-commit-meta">
          <span className="git-commit-author"><Icon name="user" extra="sm" />{commit.authorName}</span>
          {Number.isNaN(date.getTime()) ? null : <time dateTime={commit.authorDate}>{date.toLocaleString(resolvedLanguage, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>}
          <button type="button" className="git-commit-oid" data-tip={t("git.copyHash")} aria-label={`${t("git.copyHash")} ${commit.oid}`} onClick={() => onCopy(commit.oid)}>
            <Icon name="copy" extra="sm" />{commit.oid.slice(0, 7)}
          </button>
          {commit.insertions !== undefined || commit.deletions !== undefined ? <span className="ch-delta">
            {commit.insertions ? <span className="ch-add">+{commit.insertions}</span> : null}
            {commit.deletions ? <span className="ch-del">−{commit.deletions}</span> : null}
          </span> : null}
          {pills.length ? <span className="git-commit-refs">{pills.map((ref) => <span key={`${ref.kind}-${ref.name}`} className={gitRefClass(ref)} style={ref.kind === "remote" ? { background: GRAPH_COLORS.remote } : ref.current ? { background: GRAPH_COLORS.local } : undefined}>
            <span className="git-ref-sizer" aria-hidden="true">{ref.name}</span>
            <span className="git-ref-clip"><span className="git-ref-scroll">{ref.name}</span></span>
          </span>)}</span> : null}
        </div>
      </header>
      <div className="git-commit-files">
        <div className="git-commit-files-head">{t("git.commitFiles")}{files ? <span className="ch-count">{files.length}</span> : null}</div>
        {changesLoading && !files ? <div className="git-commit-note">{t("git.readingFileList")}</div> : null}
        {files?.length === 0 ? <div className="git-commit-note">{t("git.noFileChanges")}</div> : null}
        {files?.length ? <div className="git-commit-file-list" role="listbox" aria-label={t("git.commitFiles")}>
          {files.map((file) => {
            const display = splitDisplayPath(file.path);
            const ftype = fileTypeOf(display.name);
            const active = selectedPath === file.path;
            return <button type="button" role="option" aria-selected={active} key={file.path} className={`git-commit-file${active ? " is-active" : ""}`}
              data-ftype={ftype ?? undefined} data-tip={fileLabel(file)} onClick={() => onSelectFile(active ? undefined : file.path)}>
              <span className={`git-commit-file-status is-${file.status}`} aria-label={file.status}>{FILE_STATUS[file.status]}</span>
              <span className="ch-row-icon" aria-hidden="true"><Icon name={iconNameFor(ftype, display.name)} extra="sm" /></span>
              <span className="git-commit-file-name">{display.name}</span>
              <span className="git-commit-file-dir">{file.status === "renamed" && file.originalPath ? `${file.originalPath} →` : display.dir}</span>
            </button>;
          })}
        </div> : null}
      </div>
      <div className="git-commit-diff">
        {shownDiff ? <>
          <div className="diff-toolbar">
            <Icon name="file-code" extra="sm" /><span className="mono small ellipsis">{shownDiff.path}</span>
            {shownDiff.truncated ? <span className="chip gray xs">{t("common.truncated")}</span> : null}
            <span className="spacer" /><DiffDisplayMode split={split} onSplit={setSplit} />
          </div>
          <div className={`diff-scroll${split ? " diff-split" : ""}`}>
            {shownDiff.binary ? <div className="empty">Binary diff</div> : shownDiff.patch.length === 0 ? <div className="empty">{t("git.noDiff")}</div> : <GitPatch patch={shownDiff.patch} split={split} />}
          </div>
        </> : <div className="git-commit-placeholder"><Icon name="diff" /><p>{selectedPath ? t("git.readingDiff") : t("git.pickCommitFile")}</p></div>}
      </div>
    </section>
  );
}
