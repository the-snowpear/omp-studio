import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../icons";
import { type HubAgent } from "./types";
import { fmtCost, fmtDur, fmtNum, hubDurationMs, hubTone, isAdvisor } from "./projection";
import { DossierDisclosure, DossierSection, HubSigil } from "./HubDossier";

interface HubAgentOverviewProps {
  zh: boolean;
  agent: HubAgent;
  roster: readonly HubAgent[];
  now: number;
  select: (id: string, opts?: { scroll?: boolean }) => void;
  onOpenMain: () => void;
  onJobs: () => void;
  /** The task's step list, when the runtime reports one. */
  steps?: ReactNode;
  /** The models and thinking fold; it reads the runtime only while open. */
  models?: ReactNode;
}

const TASK_CLAMP = 220;

function nowLine(agent: HubAgent, zh: boolean): { icon: IconName; text: ReactNode } {
  const tone = hubTone(agent);
  const icon: IconName = tone === "failed" ? "alert" : tone === "waiting" ? "clock" : tone === "running" ? "pulse" : "pause";
  if (agent.currentTool) {
    return {
      icon,
      text: (
        <>
          <span className="chip blue xs">{agent.currentTool.name}</span>
          {agent.currentTool.args ? <span className="hub-dossier-args">{agent.currentTool.args}</span> : null}
        </>
      ),
    };
  }
  if (agent.lastIntent) return { icon, text: agent.lastIntent };
  if (agent.status === "running" && agent.task !== "—") return { icon, text: agent.task };
  if (tone === "waiting") return { icon, text: zh ? "等待输入" : "Waiting for input" };
  if (agent.status === "parked") return { icon, text: zh ? "已停驻，发消息或恢复后继续" : "Parked; message or revive it to continue" };
  if (agent.status === "released" || agent.rawStatus === "released") return { icon, text: zh ? "已释放" : "Released" };
  if (agent.status === "aborted") return { icon, text: zh ? "已结束" : "Ended" };
  return { icon, text: zh ? "无进行中的工具调用" : "No tool is running" };
}

function AgentChip({ agent, onClick }: { agent: HubAgent; onClick: () => void }) {
  return (
    <button type="button" className="hub-dossier-agent" onClick={onClick}>
      <HubSigil agent={agent} size={16} />
      <span>{agent.name}</span>
      <i className="hub-dossier-dot" data-tone={hubTone(agent)} aria-hidden="true" />
    </button>
  );
}

function CopyId({ id, zh }: { id: string; zh: boolean }) {
  const [copied, setCopied] = useState(false);
  const label = copied ? (zh ? "已复制" : "Copied") : zh ? "复制 ID" : "Copy ID";
  return (
    <button
      type="button"
      className="icon-btn small"
      data-tip={label}
      aria-label={label}
      onMouseLeave={() => setCopied(false)}
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => setCopied(true), () => undefined);
      }}
    >
      <Icon name={copied ? "check" : "copy"} extra="sm" />
    </button>
  );
}

/** The overview tab of an agent's dossier: now, task, usage, lineage, outputs, then the folds. */
export function HubAgentOverview({ zh, agent, roster, now, select, onOpenMain, onJobs, steps, models }: HubAgentOverviewProps) {
  const [taskOpen, setTaskOpen] = useState(false);
  const metrics = agent.metrics;
  const duration = hubDurationMs(agent, now);
  const context = metrics?.contextWindow
    ? Math.max(0, Math.min(1, (metrics.contextTokens ?? 0) / metrics.contextWindow))
    : undefined;
  const line = nowLine(agent, zh);
  const parent = agent.parentId ? roster.find((row) => row.id === agent.parentId) : undefined;
  const longTask = agent.task.length > TASK_CLAMP;
  const tiles: [string, string][] = [
    [zh ? "时长" : "Duration", duration === undefined ? "—" : fmtDur(duration)],
    ["Tokens", metrics ? fmtNum(metrics.tokens) : "—"],
    [zh ? "请求" : "Requests", metrics ? String(metrics.requests) : "—"],
    [zh ? "工具" : "Tools", metrics ? String(metrics.tools) : "—"],
    [zh ? "成本" : "Cost", metrics ? fmtCost(metrics.cost) : "—"],
    [zh ? "上下文" : "Context", context === undefined ? "—" : `${Math.round(context * 100)}%`],
  ];
  const factRows: Array<readonly [string, string | null | undefined]> = [
    [zh ? "输出" : "Output", agent.outputPath],
    [zh ? "补丁" : "Patch", agent.patchPath],
    ...(agent.nestedPatchPaths ?? []).map((path) => [zh ? "嵌套补丁" : "Nested patch", path] as const),
    [zh ? "工作区分支" : "Worktree branch", agent.branchName],
  ];
  const facts = factRows.filter((fact): fact is readonly [string, string] => typeof fact[1] === "string" && fact[1] !== "");
  const progress = agent.completionPercent;

  return (
    <div className="hub-dossier-overview">
      <DossierSection title={zh ? "当前" : "Now"}>
        <div className="hub-dossier-now" data-tone={hubTone(agent)}>
          <Icon name={line.icon} extra="sm" />
          <span>{line.text}</span>
        </div>
        {agent.retryState ? (
          <div className="hub-dossier-retry">
            <Icon name="refresh" extra="sm" />
            <span>
              {zh ? "重试" : "Retry"} {agent.retryState.attempt}/{agent.retryState.maxAttempts}
              {agent.retryState.errorMessage ? ` · ${agent.retryState.errorMessage}` : ""}
            </span>
          </div>
        ) : null}
        {progress !== undefined || agent.stage ? (
          <div className="hub-dossier-progress">
            {progress !== undefined ? (
              <span className="hub-dossier-bar">
                <i style={{ inlineSize: `${Math.max(0, Math.min(100, progress)).toFixed(1)}%` }} />
              </span>
            ) : null}
            {agent.stage ? <span className="hub-dossier-stage" title={agent.stage}>{agent.stage}</span> : null}
            {progress !== undefined ? <span className="hub-dossier-pct">{Math.round(progress)}%</span> : null}
          </div>
        ) : null}
        {steps}
        {agent.activeJobIds.length ? (
          <div className="hub-dossier-chips">
            {agent.activeJobIds.map((id) => (
              <button key={id} type="button" className="hub-dossier-job" onClick={onJobs} data-tip={zh ? "查看后台任务" : "View background jobs"}>
                <Icon name="terminal" extra="sm" />
                <span>{id}</span>
              </button>
            ))}
          </div>
        ) : null}
      </DossierSection>

      <DossierSection title={zh ? "任务" : "Task"}>
        <p className="hub-dossier-task" data-clamped={(longTask && !taskOpen) || undefined}>
          {agent.task}
        </p>
        {longTask ? (
          <button type="button" className="hub-dossier-link" onClick={() => setTaskOpen((open) => !open)}>
            {taskOpen ? (zh ? "收起" : "Show less") : zh ? "展开全文" : "Show all"}
          </button>
        ) : null}
      </DossierSection>

      <DossierSection title={zh ? "用量" : "Usage"}>
        <dl className="hub-dossier-tiles">
          {tiles.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {context !== undefined && metrics?.contextWindow ? (
          <div className="hub-dossier-context" data-high={context > 0.8 || undefined}>
            <span>{zh ? "上下文" : "Context"}</span>
            <span className="hub-dossier-bar">
              <i style={{ inlineSize: `${(context * 100).toFixed(1)}%` }} />
            </span>
            <span className="hub-dossier-pct">
              {fmtNum(metrics.contextTokens ?? 0)} / {fmtNum(metrics.contextWindow)}
            </span>
          </div>
        ) : null}
      </DossierSection>

      <DossierSection title={zh ? "谱系" : "Lineage"} count={agent.children.length || undefined}>
        <div className="hub-dossier-lineage">
          <span className="hub-dossier-label">{zh ? "父代理" : "Parent"}</span>
          <div className="hub-dossier-chips">
            {parent ? (
              <AgentChip agent={parent} onClick={() => select(parent.id, { scroll: true })} />
            ) : (
              <button type="button" className="hub-dossier-agent" onClick={onOpenMain}>
                <Icon name="message" extra="sm" />
                <span>{zh ? "主对话" : "Main conversation"}</span>
              </button>
            )}
          </div>
          <span className="hub-dossier-label">{zh ? "子代理" : "Children"}</span>
          <div className="hub-dossier-chips">
            {agent.children.length ? (
              agent.children.map((id) => {
                const child = roster.find((row) => row.id === id);
                return child ? (
                  <AgentChip key={id} agent={child} onClick={() => select(id, { scroll: true })} />
                ) : (
                  <button key={id} type="button" className="hub-dossier-agent" onClick={() => select(id, { scroll: true })}>
                    <Icon name="bot" extra="sm" />
                    <span>{id}</span>
                  </button>
                );
              })
            ) : (
              <span className="hub-dossier-none">{zh ? "无" : "None"}</span>
            )}
          </div>
        </div>
      </DossierSection>

      <DossierSection title={zh ? "产物与变更" : "Outputs and changes"}>
        <div className="hub-dossier-mode">
          <Icon name={isAdvisor(agent) || agent.readOnly ? "lock" : agent.isolated ? "shield" : "folder"} extra="sm" />
          <span>
            {isAdvisor(agent) || agent.readOnly
              ? zh ? "只读 · 不改动代码" : "Read-only · no code changes"
              : agent.isolated
                ? zh
                  ? `隔离工作区 · ${agent.hasLiveSession ? "会话在线" : "仅保留记录"}`
                  : `Isolated workspace · ${agent.hasLiveSession ? "live session" : "records only"}`
                : zh ? "共享工作区 · 不按代理拆分代码行数" : "Shared workspace · changes are not attributed per agent"}
          </span>
        </div>
        {facts.length ? (
          <dl className="hub-dossier-facts">
            {facts.map(([label, value]) => (
              <div key={`${label}:${value}`}>
                <dt>{label}</dt>
                <dd><code title={value}>{value}</code></dd>
              </div>
            ))}
          </dl>
        ) : null}
      </DossierSection>

      <div className="hub-dossier-folds">
        {models}
        <DossierDisclosure icon="info" title={zh ? "技术信息" : "Technical details"}>
          <dl className="hub-dossier-facts">
            <div>
              <dt>ID</dt>
              <dd className="hub-dossier-copy"><code title={agent.id}>{agent.id}</code><CopyId id={agent.id} zh={zh} /></dd>
            </div>
            <div>
              <dt>{zh ? "原生状态" : "Native status"}</dt>
              <dd><code>{agent.rawStatus}</code></dd>
            </div>
            <div>
              <dt>{zh ? "类型" : "Kind"}</dt>
              <dd><code>{agent.kind}</code></dd>
            </div>
            <div>
              <dt>{zh ? "代数" : "Generation"}</dt>
              <dd><code>{agent.generation}</code></dd>
            </div>
            <div>
              <dt>{zh ? "会话" : "Session"}</dt>
              <dd>{agent.hasLiveSession ? (zh ? "在线" : "Live") : zh ? "仅记录" : "Records only"}</dd>
            </div>
            <div>
              <dt>{zh ? "创建时间" : "Registered"}</dt>
              <dd>{agent.startedAt ? new Date(agent.startedAt).toLocaleString(zh ? "zh-CN" : "en-US") : "—"}</dd>
            </div>
          </dl>
        </DossierDisclosure>
      </div>
    </div>
  );
}
