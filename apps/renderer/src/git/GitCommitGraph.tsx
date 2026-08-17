import { useMemo, useState } from "react";

import type { GitCommitChangeRecord, GitCommitChangesReadModel, GitCommitDiffReadModel, GitLogListReadModel, GitLogRef } from "@omp-studio/client-contract";

import { Icon } from "../icons";

import { buildGitGraphRows, GRAPH_COLORS, renderGraphRow, renderGraphThroughLanes, SWIMLANE_HEIGHT, SWIMLANE_WIDTH, type GraphRow } from "./gitGraphLayout";

function refClass(ref: GitLogRef): string {
  if (ref.kind === "head" || (ref.kind === "local" && ref.current)) return "git-ref local";
  if (ref.kind === "remote") return "git-ref remote";
  if (ref.kind === "tag") return "git-ref tag";
  return "git-ref";
}

function GraphSvg({ row }: { readonly row: GraphRow }) {
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
  const [branchOid, setBranchOid] = useState<string>();
  const [branchName, setBranchName] = useState("");

  const copyOid = async (oid: string) => {
    try { await navigator.clipboard.writeText(oid); } catch { /* clipboard blocked */ }
    setMenuOid(undefined);
  };

  const fileLabel = (file: GitCommitChangeRecord) => {
    if (file.status === "renamed" && file.originalPath) return `${file.originalPath} → ${file.path}`;
    return file.path;
  };

  if (loading && model === undefined) return <div className="empty" style={{ padding: 12 }}>正在读取提交历史…</div>;
  if (error) return <div className="empty" style={{ padding: 12 }}><p>{error}</p>{onRefresh ? <button type="button" className="btn small outline" onClick={onRefresh}>重试</button> : null}</div>;
  if (!model || rows.length === 0) return <div className="empty" style={{ padding: 12 }}>还没有提交历史</div>;

  return (
    <div className="git-graph-list">
      {rows.map((row) => {
        const synthetic = row.kind === "incoming-changes" || row.kind === "outgoing-changes";
        const selected = selectedOid === row.id;
        const pills = row.refs.filter((ref) => ref.kind !== "head");
        return (
          <div key={row.id} className={`git-graph-block${selected ? " selected" : ""}`}>
            <div className="git-graph-lane">
              <GraphSvg row={row} />
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
                <span className="git-graph-subject-scroll">{row.subject}</span>
              </button>
              {pills.length > 0 ? (
                <div className="git-graph-refs">
                  {pills.map((ref) => (
                    <span key={`${ref.kind}-${ref.name}`} className={refClass(ref)} style={ref.kind === "remote" ? { background: GRAPH_COLORS.remote } : ref.current ? { background: GRAPH_COLORS.local } : undefined}>
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
                  data-tip="提交操作"
                  aria-label="提交操作"
                  disabled={busy || preview}
                  onClick={() => setMenuOid(menuOid === row.id ? undefined : row.id)}
                >
                  <Icon name="more" extra="sm" />
                </button>
              ) : null}
            </div>
            {menuOid === row.id && row.commit ? (
              <div className="git-graph-menu" role="menu">
                <button type="button" role="menuitem" disabled={busy} onClick={() => { onCheckout?.(row.id); setMenuOid(undefined); }}>检出此提交</button>
                <button type="button" role="menuitem" disabled={busy} onClick={() => { setBranchOid(row.id); setBranchName(""); setMenuOid(undefined); }}>从此创建分支</button>
                <button type="button" role="menuitem" disabled={busy} onClick={() => { onCherryPick?.(row.id); setMenuOid(undefined); }}>Cherry-pick</button>
                <button type="button" role="menuitem" disabled={busy} onClick={() => { onRevert?.(row.id); setMenuOid(undefined); }}>Revert</button>
                <button type="button" role="menuitem" onClick={() => void copyOid(row.id)}>复制哈希</button>
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
                <input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="新分支名称" autoFocus />
                <button type="submit" className="btn small primary" disabled={busy || !branchName.trim()}>创建</button>
                <button type="button" className="btn small outline" onClick={() => setBranchOid(undefined)}>取消</button>
              </form>
            ) : null}
            {selected && !synthetic ? (
              <div className="git-graph-details">
                {row.commit ? <div className="tiny muted">{row.commit.authorName} · {row.commit.oid.slice(0, 7)}</div> : null}
                {changesLoading ? <div className="empty" style={{ padding: 8 }}>读取文件列表…</div> : null}
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
                    {changes.files.length === 0 ? <div className="empty" style={{ padding: 8 }}>没有文件变更</div> : null}
                  </div>
                ) : null}
                {selectedPath && diff && diff.oid === row.id && diff.path === selectedPath ? (
                  <div className="git-graph-diff">
                    {diff.binary ? <div className="empty">Binary diff</div> : diff.patch.length === 0 ? <div className="empty">没有 Diff</div> : patchLines(diff.patch)}
                    {diff.truncated ? <div className="tiny muted">已截断</div> : null}
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
  );
}
