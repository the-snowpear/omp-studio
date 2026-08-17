import { useId, useState, type ReactNode } from "react";
import { Icon } from "../icons";
import { ToolBody, TruncationMark } from "./ToolBody";
import { jsonString, type ToolView } from "./conversationViewModel";
import {
  batchSummary,
  chainItemDetail,
  collectAgents,
  resolveSubagentHubTarget,
  subagentCardKey,
  isAskPending,
  isPathKind,
  saPill,
  statusLabel,
  toolDiffStats,
  toolFields,
  toolIcon,
  toolKind,
  toolLabel,
  type SubagentHubTarget,
  type ThinkView,
} from "./toolMeta";

function SubagentStrip({
  tools,
  onInspectSubagent,
}: {
  tools: readonly ToolView[];
  onInspectSubagent?: (target: SubagentHubTarget) => void;
}) {
  const agents = collectAgents(tools);
  if (agents.length === 0) return null;
  return (
    <div className="subagent-strip">
      {agents.map((agent) => {
        const pill = saPill(agent);
        const target = resolveSubagentHubTarget(agent);
        const inspectable = onInspectSubagent !== undefined && target !== undefined;
        const aria = [agent.name, pill.label, agent.dur, agent.tokens ? `${agent.tokens} tok` : ""]
          .filter(Boolean)
          .join("，");
        const body = (
          <>
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
          </>
        );
        if (inspectable) {
          return (
            <button
              key={subagentCardKey(agent)}
              type="button"
              className={`sa-card is-inspectable ${agent.status}`}
              aria-label={`${aria}，打开对话`}
              onClick={(event) => {
                event.stopPropagation();
                onInspectSubagent(target);
              }}
            >
              {body}
            </button>
          );
        }
        return (
          <div
            key={subagentCardKey(agent)}
            className={`sa-card ${agent.status}`}
            role="group"
            aria-label={target === undefined ? `${aria}，无法打开对话：缺少 Agent 身份` : aria}
          >
            {body}
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
        <div className="tl-card-motion-inner">
          <div className="think-scroll convo-plain">
            {truncated === true ? <TruncationMark /> : null}
            {full.split("\n").map((line, index) => (
              <span key={index}>{index > 0 ? <br /> : null}{line}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolItem({ tool, open, onToggle, showDetail = true }: { tool: ToolView; open: boolean; onToggle: () => void; showDetail?: boolean }) {
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
  const detail = showDetail ? chainItemDetail(tool) : undefined;
  const running = tool.status === "running";
  const queued = tool.status === "queued";
  const failed = tool.status === "failed";
  const diff = toolDiffStats(tool);
  const diffLabel = [diff.add ? `新增 ${diff.add} 行` : "", diff.del ? `删除 ${diff.del} 行` : ""].filter(Boolean).join("，");
  const aria = `${label}${detail ? ` · ${detail}` : ""}${diffLabel ? `，${diffLabel}` : ""}，${statusLabel(tool.status)}，${open ? "收起" : "展开"}详情`;
  return (
    <div className={`tl-item${open ? " open" : ""}${running ? " is-running" : ""}`} data-kind={kind} data-status={tool.status} data-tool-call-id={tool.toolCallId}>
      <button
        type="button"
        className={`tl-row${failed ? " is-error" : ""}${running ? " is-running" : ""}`}
        aria-expanded={open}
        aria-label={aria}
        onClick={onToggle}
      >
        <span className="tl-icon">
          {running ? <span className="spinner" /> : <Icon name={queued ? "clock" : toolIcon(kind)} extra="sm" />}
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
        <div className="tl-card-motion-inner">
          <div className="tc-body">
            <ToolBody tool={tool} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** 一条工具链里的单个条目，顺序即模型产出顺序。 */
export type ChainItem =
  | { readonly kind: "think"; readonly think: ThinkView }
  | { readonly kind: "tool"; readonly tool: ToolView };

export function BatchChain({
  items,
  batchKey,
  expandAll = false,
  standalone = false,
  liveTail = false,
  showDetail = true,
  onInspectSubagent,
}: {
  /** 已按模型产出顺序排好的链条目；相邻思考应在上游合并后再传进来。 */
  items: readonly ChainItem[];
  batchKey: string;
  expandAll?: boolean;
  standalone?: boolean;
  /** 该链是流式 assistant 输出的尾部（其后还没有新的文本段）时为 true。 */
  liveTail?: boolean;
  /** 工具行上的意图摘要行（设置 → 对话与交互 → 显示工具调用意图）。 */
  showDetail?: boolean;
  onInspectSubagent?: (target: SubagentHubTarget) => void;
}) {
  // 展开状态按「槽位」寻址而不是按 segment key：同一条链在 live → 落盘之间会换 key
  // （`m1:thinking:0` → `thinking-0`），按槽位寻址才不会在落盘那一刻丢掉展开状态。
  const chain: { readonly slot: string; readonly item: ChainItem }[] = [];
  const visible: ToolView[] = [];
  const thinking: ThinkView[] = [];
  for (const item of items) {
    if (item.kind === "think") {
      chain.push({ slot: `think-${thinking.length}`, item });
      thinking.push(item.think);
      continue;
    }
    if (isAskPending(item.tool)) continue;
    chain.push({ slot: item.tool.toolCallId, item });
    visible.push(item.tool);
  }
  const running = visible.some((tool) => tool.status === "running" || tool.status === "queued");
  const askOnly = visible.length > 0 && visible.every((tool) => {
    const kind = toolKind(tool);
    return kind === "ask" || kind === "askuser";
  });
  // 真实事件顺序里 message.completed 先于第一个 tool.started，整条链会先全部落成
  // queued，所以只有 running 才算「正在跑」；否则倒序扫描会跟到链尾那个还没启动的调用。
  let lastRunId: string | undefined;
  let nextQueuedId: string | undefined;
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const tool = visible[index];
    if (tool === undefined) continue;
    if (tool.status === "running") {
      lastRunId = tool.toolCallId;
      break;
    }
    if (tool.status === "queued") nextQueuedId = tool.toolCallId;
  }
  // 流式跟随：最后一个运行中的工具 → 下一个待跑的工具 → 链尾仍在输出的思考。
  // 链尾之前的思考已经被后面的工具接管，不该再跟着它。
  const tail = chain[chain.length - 1];
  const tailThinkSlot = tail !== undefined && tail.item.kind === "think" ? tail.slot : undefined;
  const activeKey = lastRunId ?? nextQueuedId ?? (liveTail ? tailThinkSlot : undefined);
  // 用户手动切换过的项/链记入 override，之后不再被自动展开/折叠覆盖。
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined);
  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const open = manualOpen ?? (running || liveTail || askOnly || expandAll);
  const itemOpen = (slot: string) => overrides[slot] ?? (slot === activeKey || expandAll || askOnly);
  const bodyId = useId();
  const toggleItem = (slot: string) => {
    setOverrides((previous) => ({ ...previous, [slot]: !(previous[slot] ?? (slot === activeKey || expandAll || askOnly)) }));
  };
  const toggleOpen = () => setManualOpen(!open);
  if (chain.length === 0) return null;
  const cards: ReactNode[] = chain.map(({ slot, item }) =>
    item.kind === "think" ? (
      <ThinkCard
        key={slot}
        itemKey={item.think.key}
        preview={item.think.text.trim().replace(/\s+/g, " ")}
        full={item.think.text}
        {...(item.think.truncated === true ? { truncated: true } : {})}
        open={itemOpen(slot)}
        onToggle={() => toggleItem(slot)}
      />
    ) : (
      <ToolItem
        key={slot}
        tool={item.tool}
        open={itemOpen(slot)}
        onToggle={() => toggleItem(slot)}
        showDetail={showDetail}
      />
    ),
  );
  // 单卡（只有一段思考，或只用了一个工具）没有可归纳的批次：摘要行只会把「Read ·
  // a.ts」重述成「阅读 1 个文件」，还多要一次点击才看得到内容。直接把那张卡摆出来。
  if (cards.length === 1) {
    return (
      <div
        className={`${standalone ? "ev " : ""}ev-batch is-single${running ? " is-running" : ""}`}
        data-batch-key={batchKey}
      >
        <SubagentStrip tools={visible} {...(onInspectSubagent === undefined ? {} : { onInspectSubagent })} />
        {cards}
      </div>
    );
  }
  const summary = batchSummary(thinking, visible);
  return (
    <div
      className={`${standalone ? "ev " : ""}ev-batch${open ? " open" : ""}${running ? " is-running" : ""}${expandAll || askOnly ? " is-pinned-open" : ""}`}
      data-batch-key={batchKey}
    >
      <SubagentStrip tools={visible} {...(onInspectSubagent === undefined ? {} : { onInspectSubagent })} />
      <button
        type="button"
        className="batch-sum"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggleOpen}
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
        <div className="batch-chain-inner">{cards}</div>
      </div>
    </div>
  );
}
