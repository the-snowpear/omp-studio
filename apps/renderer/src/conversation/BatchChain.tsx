import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { ToolBody, TruncationMark } from "./ToolBody";
import { ToolCardScroll } from "./useToolCardFollowScroll";
import { ChunkedText } from "./textChunks";
import { jsonString, type ToolView } from "./conversationViewModel";
import { applyLiveSubagentRoster, resolveSubagentMetrics, SubagentMetrics } from "./SubagentMetrics";
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
  liveAgents,
  onInspectSubagent,
}: {
  tools: readonly ToolView[];
  liveAgents?: readonly StudioAgentSnapshot[];
  onInspectSubagent?: (target: SubagentHubTarget) => void;
}) {
  const agents = collectAgents(tools).map((agent) => applyLiveSubagentRoster(agent, liveAgents ?? []));
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
            <SubagentMetrics {...resolveSubagentMetrics(undefined, agent)} />
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

/** 收起过渡跑完之后再卸载正文的等待时间（略大于 `--dur-slow` 250ms）。 */
const COLLAPSE_UNMOUNT_MS = 320;

/**
 * 卡片展开/收起的三件事：正文按需挂载、首次展开推迟一帧起跳、收起过渡结束后卸载。
 *
 * 折叠的卡片是 CSS 隐藏而不是卸载的，所以「一挂就挂全部正文」意味着视口里每张卡都
 * 要构建自己的完整载荷；更糟的是流式期间它们每帧都要重建一遍——一张在跑的 bash 卡
 * 被收起后仍在按帧重渲染上千行输出，屏幕上什么都看不见。
 *
 * `open` 类还要再等一帧。一张工具卡的正文可以是 1500 行代码，把它和一个基于时间的
 * CSS 过渡放在同一帧提交，挂载就吃掉 250ms 过渡里的头 100ms——观感是卡片先瞬间跳到
 * 大半开，再慢慢补完剩下的。等布局落定后再起跳，整段过渡才跑得完整。
 *
 * `instant` 只留给「仍在运行」的卡片：它的正文每个发布帧都在变，跟着过渡再多重渲染
 * 320ms 才是真正的帧预算杀手；已完成的卡片正文已冻结，走完整过渡没有这笔开销。
 *
 * 代价是收起后再展开会丢掉卡内滚动位置，与从没打开过的卡一致。
 */
function useLazyExpand(open: boolean, instant = false): { readonly mounted: boolean; readonly expanded: boolean } {
  const [state, setState] = useState<{ readonly mounted: boolean; readonly expanded: boolean }>(() => ({ mounted: open, expanded: open }));
  useLayoutEffect(() => {
    // 运行中的卡片同步挂载/卸载：它没有动画可看（正文刚开始输出时高度本来就接近 0），
    // 而收起后若为过渡多挂 320ms，这个还在每帧发布的正文就要在看不见的卡里多重渲染
    // 二十来帧。
    if (instant) {
      if (state.mounted !== open || state.expanded !== open) setState({ mounted: open, expanded: open });
      return;
    }
    if (open) {
      if (state.expanded) return;
      // 这一帧只把正文挂进去；下一帧才加 `open` 类，过渡因此从已排好的布局起跳。
      if (!state.mounted) {
        setState({ mounted: true, expanded: false });
        return;
      }
      if (typeof requestAnimationFrame !== "function") {
        setState({ mounted: true, expanded: true });
        return;
      }
      const frame = requestAnimationFrame(() => setState({ mounted: true, expanded: true }));
      return () => cancelAnimationFrame(frame);
    }
    if (state.expanded) {
      setState({ mounted: true, expanded: false });
      return;
    }
    if (!state.mounted) return;
    const timer = window.setTimeout(() => setState({ mounted: false, expanded: false }), COLLAPSE_UNMOUNT_MS);
    return () => window.clearTimeout(timer);
  }, [instant, open, state]);
  return state;
}

/**
 * 一张思考卡。`memo` 是必需的而不是优化：流式期间链尾那条 assistant 行每帧换对
 * 象，整条链会跟着重渲染，而卡片自己的 `think` 在绝大多数帧里没变。
 */
const ThinkCard = memo(function ThinkCard({ preview, full, truncated, open, follow = false, instant = false, onToggle, slot, itemKey }: {
  preview?: string;
  full: string;
  truncated?: boolean;
  open: boolean;
  follow?: boolean;
  instant?: boolean;
  onToggle: (slot: string) => void;
  slot: string;
  itemKey: string;
}) {
  const { mounted, expanded } = useLazyExpand(open, instant);
  // 摘要行是整段思考压成的一行。`trim().replace(/\s+/g, " ")` 要扫一遍全文，放在父
  // 组件里算意味着每次链重渲染都对每张卡重扫一次。
  const summary = useMemo(() => preview ?? full.trim().replace(/\s+/g, " "), [full, preview]);
  const aria = `Think${summary ? ` · ${summary.slice(0, 48)}` : ""}，${open ? "收起" : "展开"}详情`;
  // `.think-scroll.convo-plain` 是 `white-space: pre-wrap`：短正文仍是单个文本节点
  // （此前那套 `split("\n")` + `<span><br/>` 只是同样换行铺成几千个 DOM 节点）；长正文
  // 经 `ChunkedText` 按 64 行分块、块上 `content-visibility: auto`，流式期间每帧只为
  // 尾部一两个块付布局，而不是整段思考。
  const body = mounted ? <ChunkedText text={full} /> : null;
  return (
    <div className={`tl-item${expanded ? " open" : ""}`} data-kind="think" data-item-key={itemKey}>
      <button type="button" className="tl-row" aria-expanded={open} aria-label={aria} onClick={() => onToggle(slot)}>
        <span className="tl-icon"><Icon name="brain" extra="sm" /></span>
        <span className="tl-name">Think</span>
        {summary ? (
          <>
            <span className="tl-sep">·</span>
            <span className="tl-detail">{summary}</span>
          </>
        ) : null}
        <Icon name="chevron-d" extra="sm tl-chev" />
      </button>
      <div className="tl-card think-card">
        <div className="tl-card-motion-inner">
          <ToolCardScroll follow={follow} className="think-scroll convo-plain">
            {truncated === true ? <TruncationMark /> : null}
            {body}
          </ToolCardScroll>
        </div>
      </div>
    </div>
  );
});

/**
 * 一张工具卡。同样 `memo`：`toolLabel` / `chainItemDetail` / `toolDiffStats` 都要走
 * 一遍参数与 diff（编辑卡是逐行正则），没有它，链里每张卡每帧都要重算一次。
 */
const ToolItem = memo(function ToolItem({ tool, open, onToggle, slot, showDetail = true }: { tool: ToolView; open: boolean; onToggle: (slot: string) => void; slot: string; showDetail?: boolean }) {
  // 只有「仍在运行」的卡片放弃动画：正文还在逐帧变化，收起过渡期间的重渲染才是开销
  // 大头。流式期间已完成的卡照样走 250ms 过渡，不再像链级 instant 那样整链硬切。
  const instant = tool.status === "running";
  const { mounted, expanded } = useLazyExpand(open, instant);
  const kind = toolKind(tool);
  if (kind === "think") {
    const fields = toolFields(tool);
    const full = jsonString(fields.full) ?? tool.output ?? "";
    const preview = jsonString(fields.preview);
    return (
      <ThinkCard
        itemKey={tool.toolCallId}
        slot={slot}
        {...(preview === undefined ? {} : { preview })}
        full={full}
        {...(tool.truncated === true ? { truncated: true } : {})}
        open={open}
        follow={open && tool.status === "running"}
        instant={instant}
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
    <div className={`tl-item${expanded ? " open" : ""}${running ? " is-running" : ""}`} data-kind={kind} data-status={tool.status} data-tool-call-id={tool.toolCallId}>
      <button
        type="button"
        className={`tl-row${failed ? " is-error" : ""}${running ? " is-running" : ""}`}
        aria-expanded={open}
        aria-label={aria}
        onClick={() => onToggle(slot)}
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
            {mounted ? <ToolBody tool={tool} follow={open && running} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
});

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
  liveAgents,
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
  liveAgents?: readonly StudioAgentSnapshot[];
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
  // 流式跟随：最后一个运行中的工具 → 下一个待跑的工具 → 链尾仍在输出的思考 / 等待模型回复中刚完成的末尾工具。
  // 链尾之前的思考已经被后面的工具接管，不该再跟着它。
  const tail = chain[chain.length - 1];
  const tailSlot = tail !== undefined ? tail.slot : undefined;
  const activeKey = lastRunId ?? nextQueuedId ?? (liveTail ? tailSlot : undefined);
  // 用户手动切换过的项/链记入 override，之后不再被自动展开/折叠覆盖。
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined);
  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const open = manualOpen ?? (running || liveTail || askOnly || expandAll);
  const itemOpen = (slot: string) => overrides[slot] ?? (slot === activeKey || expandAll || askOnly);
  const bodyId = useId();
  // 默认展开态取决于「点击那一刻」的 activeKey/expandAll/askOnly，但 handler 必须保
  // 持同一身份，否则每帧新建的 `() => toggleItem(slot)` 会让每张卡的 memo 全部失效。
  const itemDefaults = useRef({ activeKey, expandAll, askOnly });
  itemDefaults.current = { activeKey, expandAll, askOnly };
  const toggleItem = useCallback((slot: string) => {
    const defaults = itemDefaults.current;
    setOverrides((previous) => ({
      ...previous,
      [slot]: !(previous[slot] ?? (slot === defaults.activeKey || defaults.expandAll || defaults.askOnly)),
    }));
  }, []);
  const toggleOpen = () => setManualOpen(!open);
  if (chain.length === 0) return null;
  const cards: ReactNode[] = chain.map(({ slot, item }) =>
    item.kind === "think" ? (
      <ThinkCard
        key={slot}
        slot={slot}
        itemKey={item.think.key}
        full={item.think.text}
        {...(item.think.truncated === true ? { truncated: true } : {})}
        open={itemOpen(slot)}
        follow={itemOpen(slot) && liveTail && slot === activeKey}
        onToggle={toggleItem}
      />
    ) : (
      <ToolItem
        key={slot}
        slot={slot}
        tool={item.tool}
        open={itemOpen(slot)}
        onToggle={toggleItem}
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
        <SubagentStrip
          tools={visible}
          {...(liveAgents === undefined ? {} : { liveAgents })}
          {...(onInspectSubagent === undefined ? {} : { onInspectSubagent })}
        />
        {cards}
      </div>
    );
  }
  const summary = batchSummary(thinking, visible);
  return (
    <div
      className={`${standalone ? "ev " : ""}ev-batch${open ? " open" : ""}${running ? " is-running" : ""}`}
      data-batch-key={batchKey}
    >
      <SubagentStrip
        tools={visible}
        {...(liveAgents === undefined ? {} : { liveAgents })}
        {...(onInspectSubagent === undefined ? {} : { onInspectSubagent })}
      />
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
        {/* 仍在跑的链被手动收起时同步卸载全部卡片：链里的运行卡每帧都在发布，动画
            320ms 只是让看不见的重渲染多烧一段时间。轮次结束的整链折叠不在此列——那时
            所有工具已完成，正文冻结，链条与卡片都走完整的收起过渡。 */}
        <div className="batch-chain-inner">{running && !open ? null : cards}</div>
      </div>
    </div>
  );
}
