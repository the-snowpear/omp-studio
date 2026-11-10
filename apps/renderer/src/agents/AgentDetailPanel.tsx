import { useState } from "react";
import type { SessionId, StudioClient } from "@omp-studio/client-contract";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import type { MentionCandidate } from "../composer/types";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewAgentDisplay } from "../preview/agentDockPreview";
import { SubagentConversationPane } from "../conversation/SubagentConversationPane";
import { formatAgentCost, formatSubagentDuration, subagentDurationMs } from "../conversation/SubagentMetrics";
import type { SubagentHubTarget } from "../conversation/toolMeta";
import type { SubagentConversationClient } from "../conversation/subagentConversationEngine";
import type { SubagentViewState } from "../conversation/subagentViewState";
import { AgentBtwPane } from "../btw/AgentBtwPane";
import { useWideLayout } from "../layout/useWideLayout";
import { agentStatusText } from "./agentPresentation";

/** From this body width the details move out of their tab into a column beside the conversation. */
const AGENT_DETAIL_WIDE_MIN = 1080;

export function AgentDetailPanel({ target, ...props }: AgentDetailProps) {
  const { resolvedLanguage } = useI18n();
  if (target === null) return <div className="agent-detail-empty empty"><Icon name="bot" /><p>{resolvedLanguage === "zh" ? "选择一个子 Agent，查看任务和执行对话。" : "Select an agent to view its task and conversation."}</p></div>;
  return <AgentDetailContent key={`${props.scope}:${target.agentId}`} {...props} target={target} />;
}

type AgentDetailProps = {
  target: SubagentHubTarget | null;
  scope: string;
  viewState?: SubagentViewState;
  agents: readonly StudioAgentSnapshot[];
  visible: boolean;
  client: StudioClient;
  conversationClient: SubagentConversationClient | null;
  runtimeConnected: boolean;
  canSend: boolean;
  canBtw: boolean;
  parentSessionId?: SessionId;
  liveSessionId?: SessionId;
  pendingInteractionSessionId?: string;
  workspaceId?: string;
  loadMentions?: (trigger: "@" | "/" | "^", query: string) => Promise<readonly MentionCandidate[]>;
  onMain: () => void;
  onOpenHub: (agentId: string) => void;
  onRevealSource: (target: SubagentHubTarget) => Promise<boolean>;
  onActivate?: () => void;
  contextAvailable?: boolean;
};

function AgentDetailContent({ target, agents, visible, client, conversationClient, canSend, canBtw, runtimeConnected,
  parentSessionId, liveSessionId, pendingInteractionSessionId, workspaceId, loadMentions, viewState, onMain, onOpenHub, onRevealSource, onActivate, contextAvailable = true,
}: Omit<AgentDetailProps, "target"> & { target: SubagentHubTarget }) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [tab, setTab] = useState<"chat" | "details" | "btw">(viewState?.contentTab ?? "chat");
  const [btwVisited, setBtwVisited] = useState(viewState?.btwVisited ?? false);
  const [sourceMissing, setSourceMissing] = useState(false);
  const [rootRef, wide] = useWideLayout<HTMLElement>(AGENT_DETAIL_WIDE_MIN);
  // Wide: the details column is always beside the conversation, so its tab goes away.
  const shown = wide && tab === "details" ? "chat" : tab;
  const agent = agents.find(row => row.agentId === target.agentId);
  const parent = agents.find(row => row.agentId === agent?.parentAgentId);
  const demo = preview ? previewAgentDisplay(target.agentId) : undefined;
  const historical = !preview && parentSessionId !== liveSessionId;
  const duration = agent ? subagentDurationMs(agent) : undefined;
  const name = agent?.displayName ?? target.displayName ?? target.agentId;
  const model = agent?.resolvedModel ?? target.resolvedModel;
  const task = agent?.assignment ?? target.task;
  const status = agent ? demo?.status ?? agentStatusText(agent.status, zh) : undefined;
  const metrics = [
    [zh ? "Agent" : "Agent", target.agentId],
    [zh ? "父 Agent" : "Parent agent", parent?.displayName ?? agent?.parentAgentId],
    [zh ? "任务" : "Task", task],
    [zh ? "模型" : "Model", model ?? (agent ? (zh ? "模型未知" : "Unknown model") : undefined)],
    [zh ? "运行时间" : "Duration", demo?.duration ?? (duration === undefined ? undefined : formatSubagentDuration(duration))],
    ["Tokens", demo?.tokens ?? agent?.usage?.tokens.toLocaleString()],
    [zh ? "费用" : "Cost", demo?.cost ?? (agent?.usage === undefined ? target.cost : formatAgentCost(agent.usage.cost))],
    [zh ? "产出" : "Output", agent?.outputPath],
    [zh ? "补丁" : "Patch", agent?.patchPath],
    [zh ? "分支" : "Branch", agent?.branchName],
  ];
  const metric = (index: number) => metrics[index]![1];
  const present = (rows: readonly (readonly [string, string | undefined])[]) => rows.filter((row): row is readonly [string, string] => row[1] !== undefined && row[1] !== "");
  const runRows = present([
    [zh ? "状态" : "Status", status],
    [zh ? "模型" : "Model", metric(3)],
    [zh ? "模型角色" : "Role", agent?.modelRole],
    [zh ? "父 Agent" : "Parent", metric(1)],
    [zh ? "请求" : "Requests", agent?.usage?.requests.toLocaleString()],
    [zh ? "工具调用" : "Tool calls", agent?.usage?.tools.toLocaleString()],
    ["ID", target.agentId],
  ]);
  const outputRows = present([[zh ? "产出" : "Output", metric(7)], [zh ? "补丁" : "Patch", metric(8)], [zh ? "分支" : "Branch", metric(9)]]);
  const chooseTab = (next: typeof tab) => {
    setTab(next);
    if (viewState) viewState.contentTab = next;
    if (next === "btw") { setBtwVisited(true); if (viewState) viewState.btwVisited = true; }
  };
  // The conversation keeps one stable position in the tree in both layouts, so a
  // resize across the threshold never remounts it (no lost scroll or subscription).
  return <section className={`agent-detail${wide ? " is-wide" : ""}`} ref={rootRef} data-live={visible && (preview || runtimeConnected && !historical) || undefined} aria-label={zh ? `子 Agent ${target.agentId}` : `Agent ${target.agentId}`} onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
    <header className="agent-detail-head">
      <div className="agent-detail-identity">
        <span className="agent-avatar"><Icon name="bot" extra="sm" /></span>
        <div className="agent-detail-breadcrumb"><button type="button" onClick={onMain} disabled={!contextAvailable} title={!contextAvailable ? (zh ? "请先返回所属会话" : "Return to the parent session first") : undefined}>{zh ? "主 Agent" : "Main agent"}</button>
          {parent && parent.kind !== "main" ? <><Icon name="chevron-r" extra="sm" /><span title={parent.displayName}>{parent.displayName}</span></> : null}
          <Icon name="chevron-r" extra="sm" />
        </div>
        <h2 title={name}>{name}</h2>
        <span className="agent-detail-model" title={`${!contextAvailable ? (zh ? "最近记录模型" : "Last recorded model") : (zh ? "实际模型" : "Model")}: ${model ?? (zh ? "模型未知" : "Unknown model")}`}>{model ?? (zh ? "模型未知" : "Unknown model")}</span>
        {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
        {agent ? <span className={`agent-status is-${!preview && (historical || !runtimeConnected) ? "inactive" : demo?.tone ?? agent.status}`} title={status}><span>{status}</span></span> : null}
      </div>
      {task ? <p className="agent-detail-task" title={task}>{task}</p> : null}
      {!contextAvailable ? <div className="agent-detail-notice small muted" role="status">{zh ? "所属会话未激活 · 只读" : "Parent session inactive · read only"}</div> : null}
      {historical ? <div className="agent-detail-notice small muted">{zh ? "历史对话 · 只读" : "History · read only"}</div> : null}
      {sourceMissing ? <p className="agent-detail-notice small muted" role="status">{zh ? "来源不在已加载的主对话中，请加载更早消息后再定位。" : "Load earlier messages in the main conversation to locate the source."}</p> : null}
    </header>
    <div className="agent-detail-nav">
      <div className="agent-detail-tabs" role="tablist" aria-label={zh ? "子 Agent 内容" : "Agent content"}>
        {([['chat', zh ? '对话' : 'Conversation'], ...(wide ? [] : [['details', zh ? '详情' : 'Details']] as const), ...(preview || canBtw ? [['btw', 'BTW']] : [])] as const).map(([id, label]) =>
          <button type="button" key={id} role="tab" aria-selected={shown === id} onClick={() => chooseTab(id as typeof tab)}>{label}</button>)}
      </div>
      <div className="agent-detail-actions">
        {target.toolCallId && contextAvailable ? <button type="button" className="btn small ghost" aria-label={zh ? "定位委派" : "Show delegation"} title={zh ? "定位委派" : "Show delegation"} onClick={() => { void onRevealSource(target).then(found => setSourceMissing(!found)); }}><Icon name="undo" extra="sm" /><span>{zh ? "定位委派" : "Show delegation"}</span></button> : null}
        <button type="button" className="btn small ghost" aria-label="Agent Hub" title={zh ? "前往 Agent Hub" : "Open Agent Hub"} onClick={() => onOpenHub(target.agentId)}><Icon name="external" extra="sm" /><span>Agent Hub</span></button>
      </div>
    </div>
    <div className="agent-detail-conversation" hidden={shown !== "chat"}>
      <SubagentConversationPane target={target} preview={preview} previewComposer visible={visible && shown === "chat"}
        client={preview ? null : conversationClient} sendClient={preview ? null : client} agents={agents}
        canSend={canSend && !historical} runtimeConnected={runtimeConnected}
        {...(parentSessionId === undefined ? {} : { parentSessionId })} {...(liveSessionId === undefined ? {} : { liveSessionId })}
        {...(viewState === undefined ? {} : { viewState })} {...(workspaceId === undefined ? {} : { workspaceId })}
        {...(loadMentions === undefined ? {} : { loadMentions })} {...(pendingInteractionSessionId === undefined ? {} : { pendingInteractionSessionId })} />
    </div>
    {shown === "details" ? <div className="agent-detail-metadata"><dl>{metrics.filter(([, value]) => value !== undefined && value !== "").map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div> : null}
    {btwVisited ? <div className="agent-detail-btw" hidden={shown !== "btw"}><AgentBtwPane client={preview ? undefined : client} sessionId={parentSessionId} agentId={target.agentId} {...(viewState ? { viewState: viewState.btw } : {})}
      available={visible && shown === "btw" && canBtw && runtimeConnected && !historical && agent?.hasLiveSession === true} /></div> : null}
    {wide ? <aside className="agent-detail-aside" aria-label={zh ? "子 Agent 详情" : "Agent details"}>
      <div className="agent-detail-stats">
        {([[zh ? "运行时间" : "Duration", metric(4)], ["Tokens", metric(5)], [zh ? "费用" : "Cost", metric(6)]] as const).map(([label, stat]) =>
          <div key={label} className="agent-detail-stat"><span>{label}</span><strong>{stat || "—"}</strong></div>)}
      </div>
      {task ? <section className="agent-detail-section"><h3>{zh ? "任务" : "Task"}</h3><p className="agent-detail-assignment">{task}</p></section> : null}
      {runRows.length ? <section className="agent-detail-section"><h3>{zh ? "运行" : "Run"}</h3>
        <dl className="agent-detail-props">{runRows.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>
      </section> : null}
      {outputRows.length ? <section className="agent-detail-section"><h3>{zh ? "产出" : "Outputs"}</h3>
        <dl className="agent-detail-props is-paths">{outputRows.map(([label, text]) => <div key={label}><dt>{label}</dt><dd title={text}>{text}</dd></div>)}</dl>
      </section> : null}
    </aside> : null}
  </section>;
}
