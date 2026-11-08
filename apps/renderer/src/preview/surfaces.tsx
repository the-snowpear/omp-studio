import { useOpenFile } from "../files/fileLinks";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { GitCommitChangesReadModel, GitCommitDiffReadModel, GitLogListReadModel, WorkspaceId } from "@omp-studio/client-contract";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { fileTypeOf, iconNameFor, isNoiseDir, isSensitive } from "../explorer-types";
import { FileRowMenu, type FileMenuAction, type FileMenuController, type FileMenuTarget } from "../menus";
import { GitCommitGraph } from "../git/GitCommitGraph";
import { GitDiffResizer, useGitDiffHeight } from "../git/GitDiffResizer";
import { GitMoreActionsMenu } from "../git/GitMoreActionsMenu";
import { GitPanelSplit } from "../git/GitPanelSplit";
import { GitTip } from "../git/GitTip";
import { readGitGraphLayout, writeGitGraphLayout } from "../git/gitGraphMemory";
import { useGitWorkspace } from "../git/GitWorkspaceContext";
import {
  PREVIEW_CHANGES,
  PREVIEW_CTX_PARTS,
  PREVIEW_DIFF,
  PREVIEW_FILE_TREE,
  PREVIEW_GIT_LOG,
  PREVIEW_PROBLEMS,
  PREVIEW_PV_LOGS,
  PREVIEW_TELEMETRY,
  PREVIEW_TESTS,
  type PreviewFileNode,
} from "./fixtures";
import { ChangesPanel, DiffDisplayMode, DiffLine, FileStat, type ChangesDiffFile } from "../conversation/ChangesPanel";
import { splitDisplayPath } from "../conversation/toolMeta";
import { ConvoTranscript } from "../conversation/ConvoTranscript";
import { GIT_STATUS_META } from "../git/treeStatus";
import { previewConversationRows } from "./conversationFixtures";
import { usePreviewMode } from "./PreviewContext";

function collectOpen(nodes: PreviewFileNode[], prefix: string, into: Set<string>): void {
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type !== "dir") continue;
    if (node.open) into.add(path);
    if (node.children) collectOpen(node.children, path, into);
  }
}

function TreeNodes({ nodes, depth, prefix, expanded, onToggle, onFile, onAction, fileMenu }: {
  nodes: PreviewFileNode[];
  depth: number;
  prefix: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onFile: (path: string) => void;
  onAction: (path: string, action: "context" | "context-dir") => void;
  fileMenu: FileMenuController;
}) {
  const { t } = useI18n();
  return (
    <>
      {nodes.map((node) => {
        const path = prefix ? `${prefix}/${node.name}` : node.name;
        const pad = { ["--depth-pad" as string]: `${depth * 14 + 6}px` } as CSSProperties;
        if (node.type === "dir") {
          const open = expanded.has(path);
          return (
            <div key={path}>
              <div
                className={`tree-row${open ? " open" : ""}`}
                data-dir={path}
                data-git={node.status ? GIT_STATUS_META[node.status].className : undefined}
                data-noise={isNoiseDir(node.name) || undefined}
                role="treeitem"
                tabIndex={0}
                aria-expanded={open}
                aria-label={`${node.name} 文件夹`}
                style={pad}
                onClick={() => onToggle(path)}
                onContextMenu={(event) => fileMenu.onContext(event, path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onToggle(path);
                  }
                }}
              >
                <span className="tw"><Icon name="chevron-r" extra="sm" /></span>
                <span className="fi"><Icon name={open ? "folder-open" : "folder"} /></span>
                <span className="fname ellipsis">{node.name}</span>
                <FileStat status={node.status} />
                <span className="fop">
                  <button type="button" className="icon-btn" data-tip={t("shell.addContext")} aria-label={`${t("shell.addContext")} ${path}`} onClick={(event) => { event.stopPropagation(); onAction(path, "context-dir"); }}><Icon name="at" /></button>
                  <FileRowMenu
                    id={path}
                    openId={fileMenu.openId}
                    onToggle={fileMenu.onToggle}
                    contextPoint={fileMenu.openId === path ? fileMenu.point : null}
                    target={{ path, name: node.name, kind: "dir" }}
                    openers={fileMenu.openers}
                    desktopActionsReason={fileMenu.desktopReason}
                    onAction={fileMenu.onAction}
                  />
                </span>
              </div>
              <div className="tree-children" role="group">
                {node.children ? <TreeNodes nodes={node.children} depth={depth + 1} prefix={path} expanded={expanded} onToggle={onToggle} onFile={onFile} onAction={onAction} fileMenu={fileMenu} /> : null}
              </div>
            </div>
          );
        }
        const ftype = fileTypeOf(node.name);
        return (
          <div key={path} className={`tree-row${node.turn ? " turn-file" : ""}`} data-file={path} data-git={node.status ? GIT_STATUS_META[node.status].className : undefined} data-ftype={ftype ?? undefined} data-secret={isSensitive(node.name) || undefined} data-noise={isNoiseDir(node.name) || undefined} role="treeitem" tabIndex={0} style={pad} onClick={() => onFile(path)} onContextMenu={(event) => fileMenu.onContext(event, path)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onFile(path); } }}>
            <span className="tw" />
            <span className="fi"><Icon name={iconNameFor(ftype, node.name)} /></span>
            <span className="fname ellipsis">{node.name}</span>
            {node.writing || node.reading ? (
              <span className="live">
                {node.reading ? <span className="dot red pulse" role="img" aria-label="读取中" data-tip="读取中" /> : null}
                {node.writing ? <span className="dot green pulse" role="img" aria-label="写入中" data-tip="写入中" /> : null}
              </span>
            ) : null}
            {node.diagnostic ? <span className={`diag ${node.diagnostic === "error" ? "err" : "warn"}`} role="img" aria-label={node.diagnostic === "error" ? "存在诊断错误" : "存在诊断警告"} /> : null}
            <FileStat status={node.status} />
            <span className="fop">
              <button type="button" className="icon-btn" data-tip={t("shell.addContext")} aria-label={`${t("shell.addContext")} ${path}`} onClick={(event) => { event.stopPropagation(); onAction(path, "context"); }}><Icon name="at" /></button>
              <FileRowMenu
                id={path}
                openId={fileMenu.openId}
                onToggle={fileMenu.onToggle}
                contextPoint={fileMenu.openId === path ? fileMenu.point : null}
                target={{ path, name: node.name, kind: "file" }}
                openers={fileMenu.openers}
                desktopActionsReason={fileMenu.desktopReason}
                onAction={fileMenu.onAction}
              />
            </span>
          </div>
        );
      })}
    </>
  );
}

export function PreviewFileTree({ label, search, onContext, onFileAction, workspaceId = "preview-workspace" }: { workspaceId?: string; label: string; search?: string; onContext?: (path: string, kind: "file" | "dir") => void; onFileAction?: (action: FileMenuAction, target: FileMenuTarget) => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const next = new Set<string>();
    collectOpen(PREVIEW_FILE_TREE, "", next);
    return next;
  });
  const openInViewer = useOpenFile();
  // 行「⋯ 更多」菜单：与真实树同一 FileRowMenu；演示路径不执行桌面动作
  // （打开/打开方式/资源管理器/绝对路径禁用），仅保留复制相对路径与添加上下文。
  const [fileMenuOpenId, setFileMenuOpenId] = useState<string | null>(null);
  const [fileMenuPoint, setFileMenuPoint] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (fileMenuOpenId === null) return;
    const close = () => setFileMenuOpenId(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [fileMenuOpenId]);
  const onToggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const fileMenu: FileMenuController = {
    openId: fileMenuOpenId,
    point: fileMenuPoint,
    openers: [],
    desktopReason: t("shell.fileDesktopOnly"),
    onToggle: (id) => {
      setFileMenuPoint(null);
      setFileMenuOpenId(id);
    },
    onContext: (event, path) => {
      event.preventDefault();
      setFileMenuPoint({ x: event.clientX, y: event.clientY });
      setFileMenuOpenId(path);
    },
    onAction: (action, target) => {
      if (action.type === "addContext") {
        onContext?.(target.path, target.kind);
        return;
      }
      if (action.type === "open" && target.kind === "dir") {
        onToggle(target.path);
        return;
      }
      if (action.type === "open") { openInViewer({ workspaceId, path: target.path }); return; }
      onFileAction?.(action, target);
    },
  };
  const visible = search?.trim()
    ? filterPreviewNodes(PREVIEW_FILE_TREE, search)
    : PREVIEW_FILE_TREE;
  return (
    <div className="tree" role="tree" aria-label={`${label} 文件树`}>
      <TreeNodes nodes={visible} depth={0} prefix="" expanded={expanded} onToggle={onToggle} onFile={path => { openInViewer({ workspaceId, path }); }} onAction={(path, action) => {
        if (action === "context" || action === "context-dir") {
          onContext?.(path, action === "context-dir" ? "dir" : "file");
        }
      }} fileMenu={fileMenu} />
    </div>
  );
}

function filterPreviewNodes(nodes: PreviewFileNode[], query: string): PreviewFileNode[] {
  const needle = query.trim().toLowerCase();
  return nodes.flatMap((node) => {
    const children = node.children ? filterPreviewNodes(node.children, query) : [];
    return node.name.toLowerCase().includes(needle) || children.length > 0
      ? [{ ...node, ...(node.type === "dir" ? { children } : {}) }]
      : [];
  });
}

export function PreviewTranscript() {
  return <ConvoTranscript rows={previewConversationRows()} demo />;
}

export function PreviewTokenTrigger() {
  const t = PREVIEW_TELEMETRY;
  return (
    <>
      <span className="t-tok-icon" data-tip={`Token ↑${t.inputTokens} ↓${t.outputTokens} · ${t.cacheTokens} cache`}><Icon name="chart" /></span>
      <span className="t-item"><Icon name="arrow-u" extra="sm" /><b>{t.inputTokens}</b></span>
      <span className="t-item"><Icon name="arrow-d" extra="sm" /><b>{t.outputTokens}</b></span>
      <span className="t-sep" aria-hidden="true" />
      <span className="t-item"><b>{t.cacheTokens}</b>&nbsp;cache</span>
    </>
  );
}

export function PreviewContextTrigger() {
  const t = PREVIEW_TELEMETRY;
  return (
    <>
      <span className="ctx-ring" style={{ ["--p" as string]: t.ctxPct }} aria-hidden="true" data-tip={`Context ${t.ctxPct}%`} />
      <span className="t-item"><b>{t.ctxPct}%</b></span>
    </>
  );
}

export function PreviewContextPanel() {
  const t = PREVIEW_TELEMETRY;
  const { marks } = usePreviewMode();
  const tone = t.ctxPct > 80 ? "red" : t.ctxPct > 60 ? "amber" : "green";
  return (
    <>
      <div className="tp-head"><Icon name="layers" extra="sm" />CONTEXT 构成<span className="spacer" /><span className={`chip ${tone} xs`}>{t.ctxPct}%</span></div>
      <div className="tp-ctx" style={{ paddingTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span>已使用</span>
          <b className="mono" style={{ fontSize: 13 }}>{t.usedExact} / {t.totalExact}（{t.ctxPct}.0%）</b>
        </div>
        <div className="ctxbar">
          {PREVIEW_CTX_PARTS.map((part) => (
            <i key={part.name} style={{ width: `${part.pct}%`, background: part.color }} data-tip={part.name} />
          ))}
        </div>
        <div className="ctx-legend">
          {PREVIEW_CTX_PARTS.map((part) => (
            <div key={part.name} className="cl-row">
              <span className="cl-dot" style={{ background: part.color }} />
              <span>{part.name}</span>
              <span className="cl-v">{part.v}</span>
            </div>
          ))}
        </div>
        <div className="tiny muted" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          Compact：{t.compact} · 上次 Compact：3 天前 · 阈值 80%{marks ? " · 演示数据" : ""}
        </div>
      </div>
    </>
  );
}

function previewDelta(rows: readonly { add: number; del: number }[]): { add: number; del: number } {
  return rows.reduce((sum, row) => ({ add: sum.add + row.add, del: sum.del + row.del }), { add: 0, del: 0 });
}

function previewDiffFiles(rows: readonly { file: string; add: number; del: number }[]): ChangesDiffFile[] {
  const d = PREVIEW_DIFF;
  return rows.map((row) => ({
    file: row.file,
    add: row.add,
    del: row.del,
    hunks: row.file === d.file ? [{
      hunkLabel: "hunk 1/2",
      lines: d.lines.map((line) => (
        line[0] === "collapse"
          ? { kind: "collapse" as const, label: line[1] }
          : {
            kind: "row" as const,
            mark: line[0] === "+" || line[0] === "-" ? line[0] : " ",
            oldLn: line[1],
            newLn: line[2],
            text: line[3],
          }
      )),
    }] : [],
  }));
}

const PREVIEW_TURN_LAST = "last";
const PREVIEW_TURN_SESSION = "session";

export function PreviewChanges({
  focusPath,
  focusTurnId,
  focusKey,
}: {
  focusPath?: string;
  focusTurnId?: string;
  focusKey?: number;
}) {
  const last = previewDelta(PREVIEW_CHANGES.turn);
  const session = previewDelta(PREVIEW_CHANGES.thread);
  const { marks } = usePreviewMode();
  const [turnId, setTurnId] = useState(PREVIEW_TURN_LAST);
  const [split, setSplit] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const files = previewDiffFiles(turnId === PREVIEW_TURN_SESSION ? PREVIEW_CHANGES.thread : PREVIEW_CHANGES.turn);
  useEffect(() => {
    if (focusTurnId === undefined) return;
    if (focusTurnId === PREVIEW_TURN_SESSION || focusTurnId === PREVIEW_TURN_LAST) {
      setTurnId(focusTurnId);
      setExpanded(new Set());
    }
  }, [focusTurnId, focusKey]);
  useEffect(() => {
    if (focusTurnId !== undefined) return;
    if (focusPath === undefined) return;
    const inLast = PREVIEW_CHANGES.turn.some((row) => row.file === focusPath);
    const inSession = PREVIEW_CHANGES.thread.some((row) => row.file === focusPath);
    if (!inLast && !inSession) return;
    setTurnId(inLast ? PREVIEW_TURN_LAST : PREVIEW_TURN_SESSION);
    setExpanded(new Set([focusPath]));
  }, [focusPath, focusTurnId]);
  return (
    <ChangesPanel
      demo
      turns={[
        { id: PREVIEW_TURN_LAST, label: "最近一轮", add: last.add, del: last.del },
        { id: PREVIEW_TURN_SESSION, label: "本会话", add: session.add, del: session.del },
      ]}
      turnId={turnId}
      onTurnChange={(id) => {
        setTurnId(id);
        setExpanded(new Set());
      }}
      files={files}
      expanded={expanded}
      onToggle={(file) => {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(file)) next.delete(file);
          else next.add(file);
          return next;
        });
      }}
      split={split}
      onSplit={setSplit}
      empty={(
        <div className="empty" style={{ padding: 18 }}>
          <p>{marks ? "演示会话还没有文件改动。" : "这个会话还没有文件改动。"}</p>
        </div>
      )}
    />
  );
}

/** Git 演示面与快捷卡共享本地演示状态，不调用 Host。 */
export function PreviewGitPanel({ view, focusPath, focusKey }: { view?: "changes" | "history"; focusPath?: string; focusKey?: number } = {}) {
  const { marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const shared = useGitWorkspace();
  const [selected, setSelected] = useState<string | null>(PREVIEW_DIFF.file);
  const [graphLayout, setGraphLayout] = useState(readGitGraphLayout);
  const [diffHeight, setDiffHeight] = useGitDiffHeight();
  const [splitDiff, setSplitDiff] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<string>();
  const [selectedCommitPath, setSelectedCommitPath] = useState<string>();
  const staged = shared.repository?.changes.filter(row => row.index !== "unmodified") ?? [];
  const working = shared.repository?.changes.filter(row => row.worktree !== "unmodified") ?? [];
  const known = shared.repository?.changes.some((row) => row.path === selected);
  const active = known ? selected : null;
  useEffect(() => { if (focusPath) setSelected(focusPath); }, [focusPath, focusKey]);
  const d = PREVIEW_DIFF;
  const previewLog = useMemo<GitLogListReadModel>(() => ({
    workspaceId: "preview-git" as WorkspaceId,
    commits: PREVIEW_GIT_LOG.commits.map(({ files: _files, patch: _patch, ...commit }) => commit),
    truncated: false,
    headOid: PREVIEW_GIT_LOG.headOid,
    upstream: PREVIEW_GIT_LOG.upstream,
    mergeBaseOid: PREVIEW_GIT_LOG.mergeBaseOid,
    ahead: PREVIEW_GIT_LOG.ahead,
    behind: PREVIEW_GIT_LOG.behind,
  }), []);
  const previewChanges = useMemo<GitCommitChangesReadModel | undefined>(() => {
    const hit = PREVIEW_GIT_LOG.commits.find((commit) => commit.oid === selectedCommit);
    if (!hit) return undefined;
    return { workspaceId: "preview-git" as WorkspaceId, oid: hit.oid, subject: hit.subject, files: hit.files };
  }, [selectedCommit]);
  const previewDiff = useMemo<GitCommitDiffReadModel | undefined>(() => {
    const hit = PREVIEW_GIT_LOG.commits.find((commit) => commit.oid === selectedCommit);
    if (!hit || selectedCommitPath === undefined) return undefined;
    const file = hit.files.find((item) => item.path === selectedCommitPath);
    if (!file) return undefined;
    return { workspaceId: "preview-git" as WorkspaceId, oid: hit.oid, path: file.path, patch: hit.patch, binary: false, truncated: false };
  }, [selectedCommit, selectedCommitPath]);
  const persistGraphLayout = (next: typeof graphLayout) => {
    setGraphLayout(next);
    writeGitGraphLayout(next);
  };
  const group = (title: string, rows: typeof staged, target: "staged" | "working", extra?: ReactNode) => (
    <div className="ch-group">
      <div className="ch-group-title">
        {title}
        <span className="ch-count">{rows.length}</span>
        {extra ? <span className="spacer" /> : null}
        {extra}
      </div>
      {rows.map((row) => {
        const name = splitDisplayPath(row.path).name;
        const ftype = fileTypeOf(name);
        return (
        <div
          className={`git-change-line${active === row.path ? " selected" : ""}`}
          key={row.path}
          data-ftype={ftype ?? undefined}
          data-secret={isSensitive(name) || undefined}
        >
          <button type="button" className="ch-row" aria-label={marks ? `演示：查看 ${row.path}` : `查看 ${row.path}`} onClick={() => setSelected(row.path)}>
            <span className="ch-row-icon" aria-hidden="true"><Icon name={iconNameFor(ftype, name)} extra="sm" /></span>
            <span className="ch-file ellipsis">{row.path}</span>
            <span className="ch-note">{row[target === "staged" ? "index" : "worktree"] === "untracked" ? resolvedLanguage === "zh" ? "未跟踪" : "Untracked" : row[target === "staged" ? "index" : "worktree"] === "added" ? resolvedLanguage === "zh" ? "新增" : "Added" : resolvedLanguage === "zh" ? "修改" : "Modified"}</span>
          </button>
          <button type="button" className="icon-btn small" aria-label={target === "working" ? `Stage ${row.path}` : `Unstage ${row.path}`} disabled={shared.busy} onClick={() => void shared.execute({ kind: target === "working" ? "stage" : "unstage", paths: [row.path] })}><Icon name={target === "working" ? "plus" : "minimize"} extra="sm" /></button>
        </div>
        );
      })}
    </div>
  );
  return (
    <GitPanelSplit
      {...(view ? { view } : {})}
      top={(
        <>
      <div className="ch-toolbar git-toolbar">
        {marks ? <span className="chip gray xs">演示</span> : null}
        <span className="git-branch-label ellipsis"><Icon name="branch" extra="sm" />{shared.repository?.branch}</span>
        <span className="chip gray xs">↑{shared.repository?.ahead} ↓{shared.repository?.behind}</span>
        <span className="spacer" />
        <button type="button" className="btn small outline" disabled={shared.busy} onClick={() => void shared.execute({ kind: "fetch", prune: true })}>Fetch</button>
        <button type="button" className="btn small outline" disabled={shared.busy} onClick={() => void shared.execute({ kind: "pull", strategy: "ff-only" })}>Pull</button>
        <button type="button" className="btn small outline" disabled={shared.busy} onClick={() => void shared.execute({ kind: "push" })}>Push</button>
      </div>
      {marks ? <div className="git-notice" role="status">演示仓库状态（omp-web / main）。预览模式下不执行任何 Git 操作。</div> : null}
      <div className="git-actions">
        <GitMoreActionsMenu />
        {marks ? <span className="tiny muted">演示</span> : null}
      </div>
      <div className="ch-list">
        {group("已暂存", staged, "staged", (
          <GitTip text={resolvedLanguage === "zh" ? "取消暂存全部" : "Unstage all"}>
            <button type="button" className="icon-btn small" aria-label="取消暂存全部" disabled={shared.busy || !staged.length} onClick={() => void shared.execute({ kind: "unstage", paths: staged.map(row => row.path) })}>
              <Icon name="minimize" extra="sm" />
            </button>
          </GitTip>
        ))}
        {group("工作区", working, "working", (
          <GitTip text={resolvedLanguage === "zh" ? "暂存全部" : "Stage all"}>
            <button type="button" className="icon-btn small" aria-label="暂存全部" disabled={shared.busy || !working.length} onClick={() => void shared.execute({ kind: "stage", paths: working.map(row => row.path) })}>
              <Icon name="plus" extra="sm" />
            </button>
          </GitTip>
        ))}
      </div>
      <div className="git-commit-box">
        <textarea placeholder={marks ? "Commit message（演示）" : "Commit message"} rows={1} value={shared.draft} onChange={event => shared.setDraft(event.target.value)} />
        <button type="button" className="btn small primary" disabled={shared.busy || !staged.length || !shared.draft.trim()} onClick={() => { const submitted = shared.draft; const message = submitted.trim(); if (message) void shared.execute({ kind: "commit", message }).then(ok => { if (ok) shared.setDraft(current => current === submitted ? "" : current); }); }}>Commit</button>
      </div>
      {active !== null ? (
        <>
        <GitDiffResizer height={diffHeight} onHeight={setDiffHeight} />
        <div className="ch-diff-slot git-diff-slot" style={{ height: diffHeight }}>
          <div className="diff-toolbar">
            <Icon name="file-code" extra="sm" />
            <span className="mono small ellipsis">{active}</span>
            {marks ? <span className="chip gray xs">演示 diff</span> : null}
            <span className="ch-add">+{d.add}</span>
            <span className="ch-del">-{d.del}</span>
            <span className="spacer" />
            <DiffDisplayMode split={splitDiff} onSplit={setSplitDiff} />
          </div>
          <div className={`diff-scroll${splitDiff ? " diff-split" : ""}`}>
            {d.lines.map((line, index) => {
              if (line[0] === "collapse") {
                return <DiffLine key={index} split={splitDiff} line={{ kind: "collapse", label: line[1] }} />;
              }
              const mark = line[0] === "+" || line[0] === "-" ? line[0] : " ";
              return <DiffLine key={index} split={splitDiff} line={{ kind: "row", mark, oldLn: line[1], newLn: line[2], text: line[3] }} />;
            })}
          </div>
        </div>
        </>
      ) : null}
        </>
      )}
      graphOpen={graphLayout.open}
      splitRatio={graphLayout.splitRatio}
      onToggle={() => persistGraphLayout({ ...graphLayout, open: !graphLayout.open })}
      onResizeSplit={(ratio) => persistGraphLayout({ ...graphLayout, splitRatio: ratio })}
      preview
      meta={<span className="chip gray xs">↑{PREVIEW_GIT_LOG.ahead} ↓{PREVIEW_GIT_LOG.behind}</span>}
    >
      <GitCommitGraph
        model={previewLog}
        preview
        {...(selectedCommit === undefined ? {} : { selectedOid: selectedCommit })}
        {...(previewChanges === undefined ? {} : { changes: previewChanges })}
        {...(selectedCommitPath === undefined ? {} : { selectedPath: selectedCommitPath })}
        {...(previewDiff === undefined ? {} : { diff: previewDiff })}
        onSelectCommit={setSelectedCommit}
        onSelectFile={setSelectedCommitPath}
      />
    </GitPanelSplit>
  );
}

const SEV = {
  error: { icon: "alert-c", tone: "red", label: "错误" },
  warn: { icon: "alert", tone: "amber", label: "警告" },
  info: { icon: "info", tone: "blue", label: "信息" },
} as const;

export function PreviewProblems() {
  const { marks } = usePreviewMode();
  return (
    <>
      {PREVIEW_PROBLEMS.map((problem) => {
        const sev = SEV[problem.sev];
        return (
          <div className="prob-row" key={`${problem.src}-${problem.msg}`}>
            <button type="button" className="prob-open" disabled data-tip={marks ? "打开（演示）" : "打开"}>
              <span className={`prob-sev sev-${sev.tone}`} role="img" aria-label={sev.label}><Icon name={sev.icon} extra="sm" /></span>
              <span className="chip gray xs">{problem.src}</span>
              <span className="ellipsis">{problem.msg}</span>
              <span className="pfile">{problem.file ? `${problem.file}${problem.line ? `:${problem.line}` : ""}` : ""}</span>
            </button>
          </div>
        );
      })}
    </>
  );
}

export function PreviewTests() {
  const { marks } = usePreviewMode();
  return (
    <>
      {PREVIEW_TESTS.map((test) => {
        const pass = test.status === "pass";
        return (
          <div key={test.suite}>
            <div className="test-row">
              <span className={`prob-sev sev-${pass ? "green" : "red"}`} role="img" aria-label={pass ? "通过" : "失败"}>
                <Icon name={pass ? "check" : "x"} extra="sm" />
              </span>
              <b className="mono test-suite">{test.suite}</b>
              <span className={`chip ${pass ? "green" : "red"} sm`}>{test.pass}/{test.total} 通过</span>
              <span className="tiny muted mono">{test.time}</span>
              <span className="spacer" />
              <button type="button" className="btn small outline" disabled data-tip={marks ? "重跑（演示）" : "重跑"}>重新运行</button>
            </div>
            {test.failDetail ? <pre className="test-fail">{test.failDetail}</pre> : null}
          </div>
        );
      })}
    </>
  );
}

export function PreviewLogs() {
  return (
    <div className="term">
      {PREVIEW_PV_LOGS.map((line) => (
        <div key={line.text} className={line.tone || undefined}>{line.text}</div>
      ))}
    </div>
  );
}

export function PreviewSwitch({ enabled, preview, onToggle }: {
  enabled: boolean;
  preview: boolean;
  onToggle: () => void;
}): ReactNode {
  if (!enabled) return null;
  return (
    <button
      type="button"
      className={`preview-switch${preview ? " on" : ""}`}
      aria-pressed={preview}
      data-tip={preview ? "退出预览" : "预览"}
      aria-label={preview ? "退出预览模式" : "进入预览模式"}
      onClick={onToggle}
    >
      预览
    </button>
  );
}
