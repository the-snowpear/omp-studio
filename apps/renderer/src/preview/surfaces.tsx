import { useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../icons";
import { setHubIntent } from "../AgentHub";
import {
  PREVIEW_CHANGES,
  PREVIEW_CTX_PARTS,
  PREVIEW_DIFF,
  PREVIEW_EVENTS,
  PREVIEW_FILE_TREE,
  PREVIEW_MINIMAP,
  PREVIEW_PREVIEW,
  PREVIEW_PROBLEMS,
  PREVIEW_PV_LOGS,
  PREVIEW_SIDE_AGENTS,
  PREVIEW_TELEMETRY,
  PREVIEW_TESTS,
  type PreviewChangeRow,
  type PreviewEvent,
  type PreviewFileNode,
  type PreviewSideAgent,
  type PreviewTool,
} from "./fixtures";

const GIT_ICON = { M: "pencil", A: "plus", D: "trash", "?": "file-plus" } as const;
const GIT_CLASS = { M: "m", A: "a", D: "d", "?": "u" } as const;
const GIT_LABEL = { M: "已修改", A: "新增", D: "已删除", "?": "未跟踪" } as const;

function collectOpen(nodes: PreviewFileNode[], prefix: string, into: Set<string>): void {
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type !== "dir") continue;
    if (node.open) into.add(path);
    if (node.children) collectOpen(node.children, path, into);
  }
}

function FileStat({ status }: { status?: PreviewFileNode["status"] }) {
  if (!status) return null;
  return (
    <span className={`fstat ${GIT_CLASS[status]}`}>
      <Icon name={GIT_ICON[status]} />
      <span className="sr-only"> {GIT_LABEL[status]}</span>
    </span>
  );
}

function TreeNodes({ nodes, depth, prefix, expanded, onToggle }: {
  nodes: PreviewFileNode[];
  depth: number;
  prefix: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
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
              </div>
              <div className="tree-children" role="group">
                {node.children ? <TreeNodes nodes={node.children} depth={depth + 1} prefix={path} expanded={expanded} onToggle={onToggle} /> : null}
              </div>
            </div>
          );
        }
        const code = node.name.endsWith(".tsx") || node.name.endsWith(".ts");
        return (
          <div key={path} className={`tree-row${node.turn ? " turn-file" : ""}`} data-file={path} role="treeitem" tabIndex={0} style={pad}>
            <span className="tw" />
            <span className="fi"><Icon name={code ? "file-code" : "file"} /></span>
            <span className="fname ellipsis">{node.name}</span>
            {node.writing ? <span className="live" role="img" aria-label="OMP 正在写入"><span className="dot blue pulse" /></span> : null}
            {node.reading ? <span className="live" role="img" aria-label="OMP 正在读取"><span className="dot purple pulse" /></span> : null}
            {node.diagnostic ? <span className={`diag ${node.diagnostic === "error" ? "err" : "warn"}`} role="img" aria-label={node.diagnostic === "error" ? "存在诊断错误" : "存在诊断警告"} /> : null}
            <FileStat status={node.status} />
          </div>
        );
      })}
    </>
  );
}

export function PreviewFileTree({ label }: { label: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const next = new Set<string>();
    collectOpen(PREVIEW_FILE_TREE, "", next);
    return next;
  });
  const onToggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  return (
    <div className="tree" role="tree" aria-label={`${label} 文件树`}>
      <TreeNodes nodes={PREVIEW_FILE_TREE} depth={0} prefix="" expanded={expanded} onToggle={onToggle} />
    </div>
  );
}

function FixtureHtml({ html, className }: { html: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolCard({ tool, running }: { tool: PreviewTool; running?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool-card${open ? " open" : ""}${running || tool.status === "running" ? " running" : ""}`}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="wrench" extra="sm" />
        <span><b>{tool.name}</b> · {tool.target}</span>
        <span className="spacer" />
        <span className="tiny muted">{tool.dur}</span>
        <Icon name="chevron-d" extra="sm" />
      </button>
      {open && (tool.summary || tool.output) ? (
        <div className="tool-body">
          {tool.summary ? <p className="muted small">{tool.summary}</p> : null}
          {tool.output ? <pre>{tool.output}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function PreviewEventView({ event }: { event: PreviewEvent }) {
  switch (event.type) {
    case "user":
      return (
        <div className="ev ev-user" id={`ev-${event.id}`}>
          <div className="ev-head"><span className="who"><span className="role-badge u">S</span>snowpear</span><span>{event.time}</span></div>
          <FixtureHtml className="ev-body" html={event.html} />
          {event.refs?.length ? (
            <div className="ev-refs">
              {event.refs.map((ref) => (
                <span key={ref} className="chip-file"><Icon name="file" extra="sm" /> {ref}</span>
              ))}
            </div>
          ) : null}
        </div>
      );
    case "assistant":
      return (
        <div className="ev ev-assistant" id={`ev-${event.id}`}>
          <div className="ev-head">
            <span className="who"><span className="role-badge a">π</span>OMP</span>
            <span className="muted">gemini-3.6-flash · {event.time}</span>
            {event.streaming ? <span className="chip blue xs">流式输出中</span> : null}
          </div>
          <FixtureHtml className="ev-body" html={`${event.html}${event.streaming ? "<span class=\"stream-caret\"></span>" : ""}`} />
        </div>
      );
    case "thinking":
      return (
        <details className="ev ev-thinking" id={`ev-${event.id}`}>
          <summary>
            <Icon name="sparkles" extra="sm" /><span>Thinking</span>
            <span className="muted">· {event.dur}</span>
            <span className="ellipsis muted" style={{ flex: 1 }}>{event.preview.slice(0, 42)}…</span>
            <Icon name="chevron-d" extra="sm" />
          </summary>
          <div className="think-body">{event.preview}</div>
        </details>
      );
    case "plan":
      return (
        <div className="ev" id={`ev-${event.id}`}>
          <div className="plan-card">
            <div className="plan-title"><Icon name="layers" extra="sm" />{event.title}</div>
            <ol>{event.items.map((item, index) => <li key={item} className={index < 3 ? "done" : undefined}>{item}</li>)}</ol>
          </div>
        </div>
      );
    case "tool":
      return <div className="ev" id={`ev-${event.id}`}><ToolCard tool={event.tool} running={event.tool.status === "running"} /></div>;
    case "toolgroup":
      return (
        <details className="ev" id={`ev-${event.id}`}>
          <div className="tool-group">
            <div className="tg-head">
              <Icon name="wrench" extra="sm" />
              <span><b>{event.count} 个工具调用</b> · {event.summary}</span>
              <span className="spacer" />
              <span className="chip green sm">全部完成</span>
            </div>
            <div className="tg-body">{event.tools.map((tool, index) => <ToolCard key={`${tool.name}-${index}`} tool={tool} />)}</div>
          </div>
        </details>
      );
    case "approval":
      return (
        <div className="ev" id={`ev-${event.id}`}>
          <div className="approval-card">
            <div className="approval-head">
              <Icon name="shield" extra="sm" /><span>{event.title}</span>
              <span className={`chip ${event.risk === "medium" ? "amber" : "red"}`}>风险：{event.risk === "medium" ? "中" : "高"}</span>
            </div>
            <div className="approval-body">
              <div className="cmd"><Icon name="terminal" extra="sm" /><span>{event.cmd}</span></div>
              <div>{event.reason}</div>
              <div className="tiny muted" style={{ marginTop: 4 }}>影响范围：{event.scope}</div>
            </div>
            <div className="approval-foot">
              <button type="button" className="btn primary lg" disabled title="演示审批，不会发给 Host">允许一次</button>
              <button type="button" className="btn outline lg" disabled title="演示审批，不会发给 Host">始终允许此类操作</button>
              <button type="button" className="btn lg danger" disabled title="演示审批，不会发给 Host">拒绝</button>
            </div>
          </div>
        </div>
      );
    case "askuser":
      return (
        <div className="ev" id={`ev-${event.id}`}>
          <div className="ask-card">
            <div className="ask-head"><Icon name="message" extra="sm" /><span>{event.title}</span></div>
            <div className="ask-body">
              <div className="small muted">{event.desc}</div>
              {event.options.map((option, index) => (
                <button key={option} type="button" className={`ask-opt${index === 0 ? " sel" : ""}`} disabled title="演示选项，不会发给 Host">{option}</button>
              ))}
            </div>
          </div>
        </div>
      );
    case "error":
      return (
        <div className="ev" id={`ev-${event.id}`}>
          <div className="error-card">
            <div className="err-title"><Icon name="alert" extra="sm" />{event.title}</div>
            <FixtureHtml html={event.html} />
          </div>
        </div>
      );
    case "checkpoint":
      return (
        <div className="ev" id={`ev-${event.id}`}>
          <div className="checkpoint-card">
            <div className="cp-head">
              <Icon name="commit" extra="sm" />
              <span>Checkpoint #{event.no}</span>
              <span className="muted small" style={{ fontWeight: 400 }}>{event.desc}</span>
              <span className="spacer" />
              <span className="tiny muted mono">{event.time}</span>
            </div>
            <div className="cp-stats">
              <span><b>{event.files}</b> 个文件</span>
              <span style={{ color: "var(--green)" }}>+{event.add}</span>
              <span style={{ color: "var(--red)" }}>-{event.del}</span>
              <span>构建 <b>{event.build}</b></span>
              <span>测试 <b>{event.tests}</b></span>
              <span>Preview <b>{event.preview}</b></span>
            </div>
          </div>
        </div>
      );
    case "compact":
      return (
        <div className="ev" id={`ev-${event.id}`}>
          <div className="compact-bar">
            <Icon name="minimize" extra="sm" />
            <span><b>Compact</b> · {event.summary}</span>
            <span className="spacer" />
            <div className="meter" style={{ width: 80 }}><i style={{ width: `${event.pct}%` }} /></div>
          </div>
        </div>
      );
  }
}

export function PreviewTranscript() {
  return (
    <>
      {PREVIEW_EVENTS.map((event) => <PreviewEventView key={event.id} event={event} />)}
    </>
  );
}

export function PreviewMinimap() {
  return (
    <>
      {PREVIEW_MINIMAP.map((mark) => (
        <button
          key={mark.evId}
          type="button"
          className={`mm-mark ${mark.type}`}
          style={{ top: `${14 + mark.at * 0.72}%` }}
          aria-label={`跳到 ${mark.type}`}
          onClick={() => document.getElementById(`ev-${mark.evId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
        />
      ))}
    </>
  );
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
          <span><i className="tb-cache" />缓存 {t.cacheTokens}</span>
        </div>
      </div>
      <div className="tok-rows">
        <div className="tr-row">本轮输入 / 输出<span className="tr-v">{t.turnIn} / {t.turnOut}</span></div>
        <div className="tr-row">本轮耗时<span className="tr-v">{t.turnTime}</span></div>
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

function ChangeGroup({ title, id, rows, selected, onSelect }: {
  title: string;
  id: string;
  rows: PreviewChangeRow[];
  selected: string | null;
  onSelect: (file: string) => void;
}) {
  return (
    <div className="ch-group" role="group" aria-labelledby={id}>
      <div className="ch-group-title" id={id}>
        <span>{title}</span><span className="ch-count" aria-label={`${rows.length} 个文件`}>{rows.length}</span>
      </div>
      {rows.map((row) => (
        <button
          key={row.file}
          type="button"
          className={`ch-row${selected === row.file ? " sel" : ""}`}
          aria-current={selected === row.file}
          onClick={() => onSelect(row.file)}
        >
          <FileStat status={row.status} />
          <span className="ch-file ellipsis">{row.file}</span>
          <span className="ch-note">{row.agent ?? row.note ?? ""}</span>
          <span className="ch-delta">
            <span className="ch-add">+{row.add}<span className="sr-only"> 行新增</span></span>
            <span className="ch-del">-{row.del}<span className="sr-only"> 行删除</span></span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function PreviewChanges() {
  const [selected, setSelected] = useState<string | null>(PREVIEW_DIFF.file);
  const [split, setSplit] = useState(false);
  const d = PREVIEW_DIFF;
  return (
    <>
      <div className="ch-toolbar">
        <span className="chip gray xs">演示</span>
        <span className="spacer" />
        <button type="button" className="btn small outline" disabled title="演示 Diff，不会发给 Host">查看全部 Diff</button>
        <button type="button" className="btn small primary" disabled title="创建 Commit 不在公共 contract 中">创建 Commit</button>
      </div>
      <div className="ch-list">
        <ChangeGroup title="当前 Turn" id="chgTurn" rows={PREVIEW_CHANGES.turn} selected={selected} onSelect={setSelected} />
        <ChangeGroup title="本 Thread 累积" id="chgThread" rows={PREVIEW_CHANGES.thread} selected={selected} onSelect={setSelected} />
        <ChangeGroup title="Agent 开始前已存在" id="chgPre" rows={PREVIEW_CHANGES.preexisting} selected={selected} onSelect={setSelected} />
      </div>
      {selected ? (
        <div className="ch-diff-slot" style={{ height: 220 }}>
          <div className="diff-toolbar">
            <Icon name="file-code" extra="sm" />
            <span className="mono small ellipsis">{selected}</span>
            <span className="ch-add">+{d.add}</span>
            <span className="ch-del">-{d.del}</span>
            <span className="spacer" />
            <span className="seg" role="radiogroup" aria-label="Diff 显示模式">
              <button type="button" role="radio" aria-checked={!split} className={split ? "" : "active"} onClick={() => setSplit(false)}>Inline</button>
              <button type="button" role="radio" aria-checked={split} className={split ? "active" : ""} onClick={() => setSplit(true)}>Split</button>
            </span>
          </div>
          <div className={`diff-scroll${split ? " diff-split" : ""}`}>
            <div className="diff-head-row">@@ {d.file} · hunk 1/2 @@</div>
            {d.lines.map((line, index) => {
              if (line[0] === "collapse") {
                return <div key={`c-${index}`} className="dl collapse"><Icon name="chevron-ud" extra="sm" /> {line[1]}</div>;
              }
              const cls = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "";
              const mark = line[0] === "+" ? "+" : line[0] === "-" ? "−" : " ";
              if (split) {
                const left = line[0] !== "+"
                  ? <div className="half"><span className="ln">{line[1]}</span><span className="lc">{line[3]}</span></div>
                  : <div className="half"><span className="ln" /><span className="lc" /></div>;
                const right = line[0] !== "-"
                  ? <div className="half"><span className="ln">{line[2]}</span><span className="lc">{line[3]}</span></div>
                  : <div className="half"><span className="ln" /><span className="lc" /></div>;
                return <div key={`${index}-${line[3]}`} className={`dl ${cls}`}>{left}{right}</div>;
              }
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
      ) : null}
    </>
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
