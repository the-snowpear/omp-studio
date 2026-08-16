import { useId, useState } from "react";
import { Icon } from "../icons";
import { ToolBody, TruncationMark } from "./ToolBody";
import { jsonString, type ToolView } from "./conversationViewModel";
import {
  batchSummary,
  chainItemDetail,
  collectAgents,
  isAskPending,
  isPathKind,
  saPill,
  statusLabel,
  toolDiffStats,
  toolFields,
  toolIcon,
  toolKind,
  toolLabel,
  type ThinkView,
} from "./toolMeta";

function SubagentStrip({ tools }: { tools: readonly ToolView[] }) {
  const agents = collectAgents(tools);
  if (agents.length === 0) return null;
  return (
    <div className="subagent-strip">
      {agents.map((agent) => {
        const pill = saPill(agent);
        const aria = [agent.name, pill.label, agent.dur, agent.tokens ? `${agent.tokens} tok` : ""]
          .filter(Boolean)
          .join("，");
        return (
          <div key={agent.name} className={`sa-card ${agent.status}`} role="group" aria-label={aria}>
            <div className="sa-top">
              <span className={`hub-act ${pill.cls}`}>{pill.label}</span>
              <span className="sa-name">{agent.name}</span>
              {agent.dur ? <span className="sa-dur">{agent.dur}</span> : null}
            </div>
            <div className="sa-metrics">
              {agent.tokens !== undefined ? <span className="sa-tok"><b>{agent.tokens}</b><i>tok</i></span> : null}
              {agent.tools !== undefined ? <span className="hub-num"><i>tools</i><b>{agent.tools}</b></span> : null}
              {agent.requests !== undefined ? <span className="hub-num"><i>req</i><b>{agent.requests}</b></span> : null}
              {agent.files !== undefined ? <span className="hub-num"><i>files</i><b>{agent.files}</b></span> : null}
              {agent.cost ? <span className="sa-cost">{agent.cost}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ThinkCard({ preview, full, truncated, open, onToggle, itemKey }: {
  preview: string;
  full: string;
  truncated?: boolean;
  open: boolean;
  onToggle: () => void;
  itemKey: string;
}) {
  const aria = `Think${preview ? ` · ${preview.slice(0, 48)}` : ""}，${open ? "收起" : "展开"}详情`;
  return (
    <div className={`tl-item${open ? " open" : ""}`} data-kind="think" data-item-key={itemKey}>
      <button type="button" className="tl-row" aria-expanded={open} aria-label={aria} onClick={onToggle}>
        <span className="tl-icon"><Icon name="brain" extra="sm" /></span>
        <span className="tl-name">Think</span>
        {preview ? (
          <>
            <span className="tl-sep">·</span>
            <span className="tl-detail">{preview}</span>
          </>
        ) : null}
        <Icon name="chevron-d" extra="sm tl-chev" />
      </button>
      <div className="tl-card think-card">
        <div className="think-scroll convo-plain">
          {truncated === true ? <TruncationMark /> : null}
          {full.split("\n").map((line, index) => (
            <span key={index}>{index > 0 ? <br /> : null}{line}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ToolItem({ tool, open, onToggle }: { tool: ToolView; open: boolean; onToggle: () => void }) {
  const kind = toolKind(tool);
  if (kind === "think") {
    const fields = toolFields(tool);
    const full = jsonString(fields.full) ?? tool.output ?? "";
    const preview = jsonString(fields.preview) ?? full.trim().replace(/\s+/g, " ");
    return (
      <ThinkCard
        itemKey={tool.toolCallId}
        preview={preview}
        full={full}
        {...(tool.truncated === true ? { truncated: true } : {})}
        open={open}
        onToggle={onToggle}
      />
    );
  }
  const label = toolLabel(tool);
  const detail = chainItemDetail(tool);
  const running = tool.status === "running" || tool.status === "queued";
  const failed = tool.status === "failed";
  const diff = toolDiffStats(tool);
  const diffLabel = [diff.add ? `新增 ${diff.add} 行` : "", diff.del ? `删除 ${diff.del} 行` : ""].filter(Boolean).join("，");
  const aria = `${label}${detail ? ` · ${detail}` : ""}${diffLabel ? `，${diffLabel}` : ""}，${statusLabel(tool.status)}，${open ? "收起" : "展开"}详情`;
  return (
    <div className={`tl-item${open ? " open" : ""}${running ? " is-running" : ""}`} data-kind={kind} data-status={tool.status}>
      <button
        type="button"
        className={`tl-row${failed ? " is-error" : ""}${running ? " is-running" : ""}`}
        aria-expanded={open}
        aria-label={aria}
        onClick={onToggle}
      >
        <span className="tl-icon">
          {running ? <span className="spinner" /> : <Icon name={toolIcon(kind)} extra="sm" />}
        </span>
        <span className="tl-name">{label}</span>
        {detail ? (
          <>
            <span className="tl-sep">·</span>
            <span className={`tl-detail${isPathKind(kind) ? " is-path" : ""}`}>{detail}</span>
          </>
        ) : null}
        {diff.add || diff.del ? (
          <span className="tl-diff" aria-hidden="true">
            {diff.add ? <span className="add">+{diff.add}</span> : null}
            {diff.del ? <span className="del">−{diff.del}</span> : null}
          </span>
        ) : null}
        <Icon name="chevron-d" extra="sm tl-chev" />
      </button>
      <div className="tl-card">
        <div className="tc-body">
          <ToolBody tool={tool} />
        </div>
      </div>
    </div>
  );
}

export function BatchChain({
  tools,
  thinking = [],
  batchKey,
  expandAll = false,
  standalone = false,
}: {
  tools: readonly ToolView[];
  thinking?: readonly ThinkView[];
  batchKey: string;
  expandAll?: boolean;
  standalone?: boolean;
}) {
  const visible = tools.filter((tool) => !isAskPending(tool));
  const running = visible.some((tool) => tool.status === "running" || tool.status === "queued");
  const askOnly = visible.length > 0 && visible.every((tool) => {
    const kind = toolKind(tool);
    return kind === "ask" || kind === "askuser";
  });
  const [open, setOpen] = useState(running || expandAll || askOnly);
  const lastRun = visible.reduce((index, tool, current) => (
    tool.status === "running" || tool.status === "queued" ? current : index
  ), -1);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => {
    const keys = new Set<string>();
    if (expandAll) {
      for (const think of thinking) keys.add(think.key);
      for (const tool of visible) keys.add(tool.toolCallId);
      return keys;
    }
    if (lastRun >= 0) keys.add(visible[lastRun]!.toolCallId);
    if (askOnly) for (const tool of visible) keys.add(tool.toolCallId);
    return keys;
  });
  const summary = batchSummary(thinking, visible);
  const bodyId = useId();
  const toggleItem = (key: string) => {
    setOpenKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  if (thinking.length === 0 && visible.length === 0) return null;
  return (
    <div
      className={`${standalone ? "ev " : ""}ev-batch${open ? " open" : ""}${running ? " is-running" : ""}${expandAll || askOnly ? " is-pinned-open" : ""}`}
      data-batch-key={batchKey}
    >
      <SubagentStrip tools={visible} />
      <button
        type="button"
        className="batch-sum"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="batch-text">{summary.text}</span>
        {summary.add || summary.del ? (
          <span className="batch-diff">
            {summary.add ? <span className="add">+{summary.add}</span> : null}
            {summary.del ? <span className="del">−{summary.del}</span> : null}
          </span>
        ) : null}
      </button>
      <div className="batch-chain" id={bodyId}>
        <div className="batch-chain-inner">
          {thinking.map((think) => (
            <ThinkCard
              key={think.key}
              itemKey={think.key}
              preview={think.text.trim().replace(/\s+/g, " ")}
              full={think.text}
              {...(think.truncated === true ? { truncated: true } : {})}
              open={openKeys.has(think.key)}
              onToggle={() => toggleItem(think.key)}
            />
          ))}
          {visible.map((tool) => (
            <ToolItem
              key={tool.toolCallId}
              tool={tool}
              open={openKeys.has(tool.toolCallId)}
              onToggle={() => toggleItem(tool.toolCallId)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
