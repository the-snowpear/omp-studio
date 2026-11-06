import { useEffect, useState } from "react";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { formatSubagentDuration, metricsFromUsage, subagentDurationMs } from "../conversation/SubagentMetrics";
import { useAppSettings, type AgentRosterDensity } from "../settings/appSettings";
import { agentPresentation } from "./agentPresentation";
import type { AgentRosterSource } from "./AgentRosterMeter";

/** Stable parent-first ordering; lifecycle/usage updates never reorder siblings. */
export function agentRosterRows(agents: readonly StudioAgentSnapshot[]) {
  const byId = new Map(agents.map(agent => [String(agent.agentId), agent]));
  const children = new Map<string, StudioAgentSnapshot[]>();
  for (const agent of agents) {
    const parent = agent.parentAgentId !== undefined && byId.has(agent.parentAgentId) ? String(agent.parentAgentId) : "";
    const list = children.get(parent) ?? [];
    list.push(agent); children.set(parent, list);
  }
  const result: { agent: StudioAgentSnapshot; depth: number }[] = [];
  const seen = new Set<string>();
  function visit(agent: StudioAgentSnapshot, depth: number) {
    if (seen.has(agent.agentId)) return;
    seen.add(agent.agentId); result.push({ agent, depth });
    for (const child of children.get(agent.agentId) ?? []) visit(child, depth + 1);
  }
  for (const agent of children.get("") ?? []) visit(agent, 0);
  for (const agent of agents) visit(agent, 0);
  return result;
}

export function AgentRosterPanel({ agents, selectedId, openedIds = [], visible, ready, source = "live", onOpen, onMain }: {
  agents: readonly StudioAgentSnapshot[];
  selectedId?: string;
  openedIds?: readonly string[];
  visible: boolean;
  ready: boolean;
  source?: AgentRosterSource;
  onOpen: (agent: StudioAgentSnapshot) => void;
  onMain: () => void;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { settings, update } = useAppSettings();
  const [demoDensity, setDemoDensity] = useState<AgentRosterDensity>("standard");
  const density = preview ? demoDensity : settings.agentRosterDensity;
  const minimal = density === "minimal";
  const setDensity = (next: AgentRosterDensity) => preview ? setDemoDensity(next) : update({ agentRosterDensity: next });
  const [now, setNow] = useState(Date.now);
  const ticking = !preview && !minimal && source === "live" && visible && agents.some(agent => ["starting", "running", "reviving"].includes(agent.status));
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return <section className="agent-roster" data-density={density} data-live={visible && (preview || source === "live") || undefined} aria-label={zh ? "Agent 名册" : "Agent roster"}>
    <div className="agent-roster-summary"><span>{!preview && source === "history" ? zh ? "历史会话" : "History" : !preview && source === "offline" ? zh ? "上次状态" : "Last received" : zh ? "当前会话" : "Current session"}</span><span className="agent-roster-count">{agents.length}</span>
      {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
      <span className="agent-roster-density" role="group" aria-label={zh ? "Agent 列表密度" : "Agent list density"}>
        <button type="button" aria-label={zh ? "标准" : "Standard"} data-tip={zh ? "标准显示：任务、活动与用量" : "Standard: task, activity and usage"} aria-pressed={!minimal} onClick={() => setDensity("standard")}><Icon name="rows" extra="sm" /></button>
        <button type="button" aria-label={zh ? "极简" : "Minimal"} data-tip={zh ? "极简显示：单行名称、模型与状态" : "Minimal: name, model and status in one row"} aria-pressed={minimal} onClick={() => setDensity("minimal")}><Icon name="menu" extra="sm" /></button>
      </span>
    </div>
    {agents.length === 0 ? <div className="empty"><Icon name="bot" /><p>{!ready ? (zh ? "正在读取 Agent…" : "Loading agents…") : (zh ? "当前会话还没有 Agent" : "No agents in this session")}</p></div>
      : <div className="agent-roster-list">{agentRosterRows(agents).map(({ agent, depth }) => {
        const { demo, status, compactStatus, tone, model, modelLabel } = agentPresentation(agent, preview, zh);
        const duration = subagentDurationMs(agent, now);
        const time = demo?.duration ?? (duration === undefined ? undefined : formatSubagentDuration(duration));
        const tokens = demo?.tokens ?? (agent.usage === undefined ? undefined : metricsFromUsage(agent.usage).tokens);
        const activity = agent.stage ?? agent.summary;
        const main = agent.kind === "main";
        const detail = [agent.displayName, status, `${zh ? "模型" : "Model"}: ${model ?? modelLabel}${agent.modelIsFallback ? zh ? "（回退模型）" : " (fallback)" : ""}`,
          agent.modelRole, agent.assignment, activity, time, tokens ? `${tokens} tokens` : undefined].filter(Boolean).join("\n");
        return <button key={agent.agentId} type="button" className={`agent-roster-row${selectedId === agent.agentId ? " is-selected" : ""}${openedIds.includes(agent.agentId) ? " is-opened" : ""}${depth ? " is-child" : ""}`}
          title={detail}
          style={{ marginLeft: Math.min(depth, 3) * 12 }} aria-pressed={!main && selectedId === agent.agentId}
          aria-label={main ? (zh ? "返回主 Agent 对话" : "Return to main conversation") : `${zh ? "打开子 Agent" : "Open agent"} ${agent.displayName}`}
          onClick={() => main ? onMain() : onOpen(agent)}>
          <span className={`agent-avatar${main ? " is-main" : ""}`}><Icon name={main ? "network" : "bot"} extra="sm" /></span>
          {minimal ? <>
            <strong className="agent-roster-name">{agent.displayName}</strong>
            <span className="agent-roster-model" title={`${zh ? "实际模型" : "Actual model"}: ${model ?? modelLabel}`}><span>{modelLabel}</span>{agent.modelIsFallback ? <Icon name="undo" extra="sm" /> : null}</span>
            <span className={`agent-status is-${tone}`} title={status}><span>{compactStatus}</span></span>
          </> : <>
          <span className="agent-roster-copy"><span className="agent-roster-title"><strong title={agent.displayName}>{agent.displayName}</strong>
            <span className={`agent-status is-${tone}`} title={status}><span>{status}</span></span></span>
            {agent.assignment ? <span className="agent-roster-task" title={agent.assignment}>{agent.assignment}</span> : null}
            {activity || time || tokens ? <span className="agent-roster-meta">
              {activity ? <span className="agent-roster-activity" title={activity}><Icon name="terminal" extra="sm" /><span>{activity}</span></span> : null}
              {time || tokens ? <span className="agent-roster-usage">{time ? <span>{time}</span> : null}{tokens ? <span>{tokens} tok</span> : null}</span> : null}
            </span> : null}
          </span>
          </>}
        </button>;
      })}</div>}
  </section>;
}
