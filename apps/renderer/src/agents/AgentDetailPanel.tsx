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
import { agentStatusText } from "./agentPresentation";

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
  return <section className="agent-detail" data-live={visible && (preview || runtimeConnected && !historical) || undefined} aria-label={zh ? `子 Agent ${target.agentId}` : `Agent ${target.agentId}`} onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
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
        {([['chat', zh ? '对话' : 'Conversation'], ['details', zh ? '详情' : 'Details'], ...(preview || canBtw ? [['btw', 'BTW']] : [])] as const).map(([id, label]) =>
          <button type="button" key={id} role="tab" aria-selected={tab === id} onClick={() => { const next = id as typeof tab; setTab(next); if (viewState) viewState.contentTab = next; if (id === "btw") { setBtwVisited(true); if (viewState) viewState.btwVisited = true; } }}>{label}</button>)}
      </div>
      <div className="agent-detail-actions">
        {target.toolCallId && contextAvailable ? <button type="button" className="btn small ghost" aria-label={zh ? "定位委派" : "Show delegation"} title={zh ? "定位委派" : "Show delegation"} onClick={() => { void onRevealSource(target).then(found => setSourceMissing(!found)); }}><Icon name="undo" extra="sm" /><span>{zh ? "定位委派" : "Show delegation"}</span></button> : null}
        <button type="button" className="btn small ghost" aria-label="Agent Hub" title={zh ? "前往 Agent Hub" : "Open Agent Hub"} onClick={() => onOpenHub(target.agentId)}><Icon name="external" extra="sm" /><span>Agent Hub</span></button>
      </div>
    </div>
    <div className="agent-detail-conversation" hidden={tab !== "chat"}>
      <SubagentConversationPane target={target} preview={preview} previewComposer visible={visible && tab === "chat"}
        client={preview ? null : conversationClient} sendClient={preview ? null : client} agents={agents}
        canSend={canSend && !historical} runtimeConnected={runtimeConnected}
        {...(parentSessionId === undefined ? {} : { parentSessionId })} {...(liveSessionId === undefined ? {} : { liveSessionId })}
        {...(viewState === undefined ? {} : { viewState })} {...(workspaceId === undefined ? {} : { workspaceId })}
        {...(loadMentions === undefined ? {} : { loadMentions })} {...(pendingInteractionSessionId === undefined ? {} : { pendingInteractionSessionId })} />
    </div>
    {tab === "details" ? <div className="agent-detail-metadata"><dl>{metrics.filter(([, value]) => value !== undefined && value !== "").map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div> : null}
    {btwVisited ? <div className="agent-detail-btw" hidden={tab !== "btw"}><AgentBtwPane client={preview ? undefined : client} sessionId={parentSessionId} agentId={target.agentId} {...(viewState ? { viewState: viewState.btw } : {})}
      available={visible && tab === "btw" && canBtw && runtimeConnected && !historical && agent?.hasLiveSession === true} /></div> : null}
  </section>;
}
