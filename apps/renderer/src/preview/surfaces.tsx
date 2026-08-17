import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { GitCommitChangesReadModel, GitCommitDiffReadModel, GitLogListReadModel, WorkspaceId } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { setHubIntent } from "../AgentHub";
import { GitCommitGraph } from "../git/GitCommitGraph";
import { GitDiffResizer, useGitDiffHeight } from "../git/GitDiffResizer";
import { GitMoreActionsMenu } from "../git/GitMoreActionsMenu";
import { GitPanelSplit } from "../git/GitPanelSplit";
import { GitTip } from "../git/GitTip";
import { readGitGraphLayout, writeGitGraphLayout } from "../git/gitGraphMemory";
import {
  PREVIEW_CHANGES,
  PREVIEW_CTX_PARTS,
  PREVIEW_DIFF,
  PREVIEW_FILE_TREE,
  PREVIEW_GIT,
  PREVIEW_GIT_LOG,
  PREVIEW_PREVIEW,
  PREVIEW_PROBLEMS,
  PREVIEW_PV_LOGS,
  PREVIEW_SIDE_AGENTS,
  PREVIEW_TELEMETRY,
  PREVIEW_TESTS,
  type PreviewFileNode,
  type PreviewSideAgent,
} from "./fixtures";
import { ChangesPanel, FileStat, type ChangesDiffFile } from "../conversation/ChangesPanel";
import { ConvoTranscript } from "../conversation/ConvoTranscript";
import { GIT_STATUS_META } from "../git/treeStatus";
import { previewConversationRows } from "./conversationFixtures";

function collectOpen(nodes: PreviewFileNode[], prefix: string, into: Set<string>): void {
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type !== "dir") continue;
    if (node.open) into.add(path);
    if (node.children) collectOpen(node.children, path, into);
  }
}

function TreeNodes({ nodes, depth, prefix, expanded, onToggle, onFile, onAction }: {
  nodes: PreviewFileNode[];
  depth: number;
  prefix: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onFile: (path: string) => void;
  onAction: (path: string, action: "context" | "context-dir" | "more") => void;
}) {
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
                role="treeitem"
                tabIndex={0}
                aria-expanded={open}
                aria-label={`${node.name} 文件夹`}
                style={pad}
                onClick={() => onToggle(path)}
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
                  <button type="button" className="icon-btn" data-tip="加入上下文" aria-label={`加入上下文 ${path}`} onClick={(event) => { event.stopPropagation(); onAction(path, "context-dir"); }}><Icon name="at" /></button>
                  <button type="button" className="icon-btn" data-tip="更多" aria-label={`更多操作 ${path}`} onClick={(event) => { event.stopPropagation(); onAction(path, "more"); }}><Icon name="more" /></button>
                </span>
              </div>
              <div className="tree-children" role="group">
                {node.children ? <TreeNodes nodes={node.children} depth={depth + 1} prefix={path} expanded={expanded} onToggle={onToggle} onFile={onFile} onAction={onAction} /> : null}
              </div>
            </div>
          );
        }
        const code = node.name.endsWith(".tsx") || node.name.endsWith(".ts");
        return (
          <div key={path} className={`tree-row${node.turn ? " turn-file" : ""}`} data-file={path} data-git={node.status ? GIT_STATUS_META[node.status].className : undefined} role="treeitem" tabIndex={0} style={pad} onClick={() => onFile(path)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onFile(path); } }}>
            <span className="tw" />
            <span className="fi"><Icon name={code ? "file-code" : "file"} /></span>
            <span className="fname ellipsis">{node.name}</span>
            {node.writing ? <span className="live" role="img" aria-label="OMP 正在写入"><span className="dot blue pulse" /></span> : null}
            {node.reading ? <span className="live" role="img" aria-label="OMP 正在读取"><span className="dot purple pulse" /></span> : null}
            {node.diagnostic ? <span className={`diag ${node.diagnostic === "error" ? "err" : "warn"}`} role="img" aria-label={node.diagnostic === "error" ? "存在诊断错误" : "存在诊断警告"} /> : null}
            <FileStat status={node.status} />
            <span className="fop">
              <button type="button" className="icon-btn" data-tip="加入上下文" aria-label={`加入上下文 ${path}`} onClick={(event) => { event.stopPropagation(); onAction(path, "context"); }}><Icon name="at" /></button>
              <button type="button" className="icon-btn" data-tip="更多" aria-label={`更多操作 ${path}`} onClick={(event) => { event.stopPropagation(); onAction(path, "more"); }}><Icon name="more" /></button>
            </span>
          </div>
        );
      })}
    </>
  );
}

export function PreviewFileTree({ label, search, onContext }: { label: string; search?: string; onContext?: (path: string, kind: "file" | "dir") => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const next = new Set<string>();
    collectOpen(PREVIEW_FILE_TREE, "", next);
    return next;
  });
  const [message, setMessage] = useState<string | undefined>(undefined);
  const onToggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const visible = search?.trim()
    ? filterPreviewNodes(PREVIEW_FILE_TREE, search)
    : PREVIEW_FILE_TREE;
  return (
    <>
      {message ? <div className="muted tiny" role="status" style={{ padding: "2px 12px 6px" }}>{message}</div> : null}
      <div className="tree" role="tree" aria-label={`${label} 文件树`}>
        <TreeNodes nodes={visible} depth={0} prefix="" expanded={expanded} onToggle={onToggle} onFile={(path) => setMessage(`打开 ${path}`)} onAction={(path, action) => {
          if (action === "context" || action === "context-dir") {
            onContext?.(path, action === "context-dir" ? "dir" : "file");
            setMessage(`已加入上下文：${path}`);
          }
        }} />
      </div>
    </>
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
      <span className="t-item"><Icon name="arrow-u" extra="sm" /><b>{t.inputTokens}</b></span>
      <span className="t-item"><Icon name="arrow-d" extra="sm" /><b>{t.outputTokens}</b></span>
      <span className="t-sep" aria-hidden="true" />
      <span className="t-item"><b>{t.cacheTokens}</b>&nbsp;cache</span>
    </>
  );
}

export function PreviewTokenPanel() {
  const t = PREVIEW_TELEMETRY;
  return (
    <>
      <div className="tp-head"><Icon name="zap" extra="sm" />Token 用量<span className="spacer" /><span className="chip blue xs">演示</span></div>
      <div className="tok-hero">
        <div className="th-cell">
          <div className="th-k">总消耗</div>
          <div className="th-v">{t.totalBurn}</div>
          <div className="th-sub">本轮 {t.turnBurn}</div>
        </div>
        <div className="th-cell">
          <div className="th-k">Cost</div>
          <div className="th-v">{t.cost}</div>
          <div className="th-sub">缓存已省 <b>{t.cacheSaved}</b></div>
        </div>
      </div>
      <div className="tok-split">
        <div className="ts-top"><span>构成</span><b>{t.inputTokens} 入 / {t.outputTokens} 出</b></div>
        <div className="tok-bar">
          <i className="tb-in" style={{ width: `${t.inPct}%` }} />
          <i className="tb-out" style={{ width: `${t.outPct}%` }} />
          <i className="tb-cache" style={{ width: `${t.cachePct}%` }} />
        </div>
        <div className="tok-keys">
          <span><i className="tb-in" />输入</span>
          <span><i className="tb-out" />输出</span>
          <span><i className="tb-cache" />缓存 {t.cacheTokens} · 命中 <b>{t.cacheHitRate}</b></span>
        </div>
      </div>
      <div className="tok-rows">
        <div className="tr-row">本轮输入 / 输出<span className="tr-v">{t.turnIn} / {t.turnOut}</span></div>
        <div className="tr-row">本轮耗时<span className="tr-v">{t.turnTime}</span></div>
        <div className="tr-row">TPS<span className="tr-v">{t.tps}</span></div>
        <div className="tr-row">会话总耗时<span className="tr-v">{t.sessionTime}</span></div>
        <div className="tr-row">子 Agent 消耗<span className="tr-v">{t.subagentCost}</span></div>
        <div className="tr-row">重试 / Fallback<span className={`tr-v${t.retries ? "" : " ok"}`}>{t.retries} 次 / 无</span></div>
      </div>
      <div className="tp-ctx">
        <div className="tiny muted">当前模型 {t.model} · Thinking {t.thinking} · Fast {t.fastMode ? "on" : "off"} · Service Tier {t.serviceTier}</div>
      </div>
    </>
  );
}

export function PreviewContextTrigger() {
  const t = PREVIEW_TELEMETRY;
  return (
    <>
      <span className="ctx-ring" style={{ ["--p" as string]: t.ctxPct }} aria-hidden="true" />
      <span className="t-item"><b>{t.ctxPct}%</b></span>
    </>
  );
}

export function PreviewContextPanel() {
  const t = PREVIEW_TELEMETRY;
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
            <i key={part.name} style={{ width: `${part.pct}%`, background: part.color }} title={`${part.name} ${part.v}`} />
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
          Compact：{t.compact} · 上次 Compact：3 天前 · 阈值 80% · 演示数据
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

export function PreviewChanges({ focusPath }: { focusPath?: string }) {
  const last = previewDelta(PREVIEW_CHANGES.turn);
  const session = previewDelta(PREVIEW_CHANGES.thread);
  const [turnId, setTurnId] = useState(PREVIEW_TURN_LAST);
  const [split, setSplit] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const files = previewDiffFiles(turnId === PREVIEW_TURN_SESSION ? PREVIEW_CHANGES.thread : PREVIEW_CHANGES.turn);
  useEffect(() => {
    if (focusPath === undefined) return;
    const inLast = PREVIEW_CHANGES.turn.some((row) => row.file === focusPath);
    const inSession = PREVIEW_CHANGES.thread.some((row) => row.file === focusPath);
    if (!inLast && !inSession) return;
    setTurnId(inLast ? PREVIEW_TURN_LAST : PREVIEW_TURN_SESSION);
    setExpanded(new Set([focusPath]));
  }, [focusPath]);
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
          <p>演示会话还没有文件改动。</p>
        </div>
      )}
    />
  );
}

/** Git 管理页演示面：与 GitStatusPanel 同一视觉，但所有操作 disabled、不调 Host。 */
export function PreviewGitPanel() {
  const [selected, setSelected] = useState<string | null>(PREVIEW_DIFF.file);
  const [graphLayout, setGraphLayout] = useState(readGitGraphLayout);
  const [diffHeight, setDiffHeight] = useGitDiffHeight();
  const [selectedCommit, setSelectedCommit] = useState<string>();
  const [selectedCommitPath, setSelectedCommitPath] = useState<string>();
  const known = [...PREVIEW_GIT.staged, ...PREVIEW_GIT.working].some((row) => row.path === selected);
  const active = known ? selected : null;
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
  const group = (title: string, rows: readonly { readonly path: string; readonly status: string }[], extra?: ReactNode) => (
    <div className="ch-group">
      <div className="ch-group-title">
        {title}
        <span className="ch-count">{rows.length}</span>
        {extra ? <span className="spacer" /> : null}
        {extra}
      </div>
      {rows.map((row) => (
        <div className={`git-change-line${active === row.path ? " selected" : ""}`} key={row.path}>
          <button type="button" className="ch-row" aria-label={`演示：查看 ${row.path}`} onClick={() => setSelected(row.path)}>
            <span className="ch-file ellipsis">{row.path}</span>
            <span className="ch-note">{row.status}</span>
          </button>
        </div>
      ))}
    </div>
  );
  return (
    <GitPanelSplit
      top={(
        <>
      <div className="ch-toolbar git-toolbar">
        <span className="chip gray xs">演示</span>
        <span className="git-branch-label ellipsis"><Icon name="branch" extra="sm" />{PREVIEW_GIT.branch}</span>
        <span className="chip gray xs">↑{PREVIEW_GIT.ahead} ↓{PREVIEW_GIT.behind}</span>
        <span className="spacer" />
        <GitTip text="演示仓库，不会发给 Host"><button type="button" className="btn small outline" disabled>Fetch</button></GitTip>
        <GitTip text="演示仓库，不会发给 Host"><button type="button" className="btn small outline" disabled>Pull</button></GitTip>
        <GitTip text="演示仓库，不会发给 Host"><button type="button" className="btn small outline" disabled>Push</button></GitTip>
      </div>
      <div className="git-notice" role="status">演示仓库状态（omp-web / main）。预览模式下不执行任何 Git 操作。</div>
      <div className="git-actions">
        <GitMoreActionsMenu />
        <span className="tiny muted">演示</span>
      </div>
      <div className="ch-list">
        {group("已暂存", PREVIEW_GIT.staged, (
          <GitTip text="演示：取消暂存全部，不会发给 Host">
            <button type="button" className="icon-btn small" aria-label="取消暂存全部" disabled>
              <Icon name="minus" extra="sm" />
            </button>
          </GitTip>
        ))}
        {group("工作区", PREVIEW_GIT.working, (
          <GitTip text="演示：暂存全部，不会发给 Host">
            <button type="button" className="icon-btn small" aria-label="暂存全部" disabled>
              <Icon name="plus" extra="sm" />
            </button>
          </GitTip>
        ))}
      </div>
      <div className="git-commit-box">
        <textarea disabled placeholder="Commit message（演示）" rows={1} readOnly value="" onChange={() => undefined} />
        <GitTip text="演示仓库，不会创建 Commit"><button type="button" className="btn small primary" disabled>Commit</button></GitTip>
      </div>
      {active !== null ? (
        <>
        <GitDiffResizer height={diffHeight} onHeight={setDiffHeight} />
        <div className="ch-diff-slot git-diff-slot" style={{ height: diffHeight }}>
          <div className="diff-toolbar">
            <Icon name="file-code" extra="sm" />
            <span className="mono small ellipsis">{active}</span>
            <span className="chip gray xs">演示 diff</span>
            <span className="ch-add">+{d.add}</span>
            <span className="ch-del">-{d.del}</span>
          </div>
          <div className="diff-scroll">
            {d.lines.map((line, index) => {
              if (line[0] === "collapse") {
                return <div key={`c-${index}`} className="dl collapse"><Icon name="chevron-ud" extra="sm" /> {line[1]}</div>;
              }
              const cls = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "";
              const mark = line[0] === "+" ? "+" : line[0] === "-" ? "−" : " ";
              return (
                <div key={`${index}-${line[3]}`} className={`dl ${cls}`}>
                  <span className="ln">{line[1]}</span>
                  <span className="ln">{line[2]}</span>
                  <span className="dm" aria-hidden="true">{mark}</span>
                  <span className="lc">{line[3]}</span>
                </div>
              );
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

export function PreviewSidePreview() {
  const p = PREVIEW_PREVIEW;
  const [vp, setVp] = useState<"desktop" | "tablet" | "phone">("desktop");
  return (
    <>
      <div className="pv-toolbar">
        <button type="button" className="icon-btn small" disabled><Icon name="arrow-l" extra="sm" /></button>
        <button type="button" className="icon-btn small" disabled><Icon name="arrow-r" extra="sm" /></button>
        <button type="button" className="icon-btn small" disabled><Icon name="refresh" extra="sm" /></button>
        <div className="pv-url ellipsis"><Icon name="lock" extra="sm" /><span className="ellipsis">{p.url}{p.path}</span></div>
        <span className="seg">
          {(["desktop", "tablet", "phone"] as const).map((id) => (
            <button key={id} type="button" className={vp === id ? "active" : undefined} onClick={() => setVp(id)}>
              <Icon name={id === "desktop" ? "monitor" : id === "tablet" ? "tablet" : "phone"} extra="sm" />
            </button>
          ))}
        </span>
        <span className="chip gray xs">演示</span>
      </div>
      <div className="pv-statusbar">
        <span className="dot green" />
        <span>页面正常 · 热更新已连接</span>
        <span className="spacer" />
        <span className="tiny muted mono">vite v5.4.11 · 演示</span>
      </div>
      <div className="pv-view">
        <div className={`pv-frame${vp === "desktop" ? "" : ` ${vp}`}`}>
          <div className="mock-page">
            <div className="mp-nav"><span style={{ color: "var(--accent)" }}>OMP Web</span><span className="muted">Docs</span><span className="muted">Sessions</span><span className="muted">Settings</span></div>
            <div className="mp-hero">
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Upstream Sync v0.8.1</div>
              <div className="muted small" style={{ marginBottom: 12 }}>Mermaid 全屏缩放拖拽 · IDE 风格 Directory Picker · Loopback 安全增强</div>
              <span className="mp-btn">提交订单</span>
            </div>
            <div className="card" style={{ padding: 14, marginBottom: 12 }}>
              <b>MermaidBlock</b><div className="muted small">全屏缩放 · 拖拽平移 · 主题选择器</div>
            </div>
            <div className="card" style={{ padding: 14 }}>
              <b>DirectoryPicker</b><div className="muted small">IDE 风格目录选择 · 最近路径</div>
            </div>
          </div>
        </div>
      </div>
      <div className="pv-console">
        {p.logs.map((line) => <div key={line}>{line}</div>)}
      </div>
    </>
  );
}

const AGENT_TONE: Record<PreviewSideAgent["status"], string> = {
  running: "blue",
  waiting: "amber",
  failed: "red",
  done: "green",
};

export function PreviewSideAgents({ onOpenHub }: { onOpenHub: (id: string) => void }) {
  return (
    <>
      {PREVIEW_SIDE_AGENTS.map((agent) => (
        <div className="agent-row" key={agent.id}>
          <span className="ag-tree" aria-hidden="true">{agent.parent ? "└" : ""}</span>
          <span className="ag-ic" aria-hidden="true"><Icon name="bot" extra="sm" /></span>
          <div className="ag-main">
            <button className="ag-open" type="button" onClick={() => { setHubIntent(agent.hubId); onOpenHub(agent.hubId); }}>
              <span className="ag-name">
                {agent.name}
                <span className={`chip ${AGENT_TONE[agent.status]} xs`}>{agent.statusText}</span>
              </span>
              <span className="ag-task">{agent.role} · {agent.task}</span>
              <span className="ag-meta"><span>{agent.time}</span><span>{agent.tokens} tok · {agent.cost}</span><span>{agent.files} 文件</span></span>
              <span className="ag-last tiny muted ellipsis">最近工具：{agent.lastTool}</span>
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

const SEV = {
  error: { icon: "alert-c", tone: "red", label: "错误" },
  warn: { icon: "alert", tone: "amber", label: "警告" },
  info: { icon: "info", tone: "blue", label: "信息" },
} as const;

export function PreviewProblems() {
  return (
    <>
      {PREVIEW_PROBLEMS.map((problem) => {
        const sev = SEV[problem.sev];
        return (
          <div className="prob-row" key={`${problem.src}-${problem.msg}`}>
            <button type="button" className="prob-open" disabled title="演示 Problems，不会打开文件">
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
              <button type="button" className="btn small outline" disabled title="演示 Tests，不会真正运行">重新运行</button>
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
      data-tip={preview ? "预览模式：演示数据。点击退出，使用真实数据。" : "进入预览模式，显示演示数据。"}
      aria-label={preview ? "退出预览模式" : "进入预览模式"}
      onClick={onToggle}
    >
      预览
    </button>
  );
}
