import { useI18n } from "../../i18n";
import type { ReactNode } from "react";
import { CompletionRing } from "../../conversation/JobWidget";
import { Icon, type IconName } from "../../icons";
import { type HubAgent, type HubStatus } from "./types";
import { activityPill, fmtAge, fmtCost, fmtDur, fmtHM, fmtNum, hubDurationMs, hubWord, sparkLevel } from "./projection";

export function KbdHint() {
  const zh = useI18n().resolvedLanguage === "zh";
  return (
    <div className="hub-kbd-hint">
      {zh
        ? "j/k 选择 · Enter 打开 · r 恢复 · x 停止 · t 切换视图"
        : "j/k Select · Enter Open · r Revive · x Stop · t Switch view"}
    </div>
  );
}

function StatusDot({ status }: { status: HubStatus }) {
  return (
    <span
      className={`hub-sd ${status}${status === "running" ? " pulse" : ""}`}
      aria-hidden="true"
    />
  );
}

function FlagChips({ agent, kids }: { agent: HubAgent; kids?: number }) {
  return (
    <>
      {agent.unread > 0 ? (
        <span className="hub-unread" data-tip={`${agent.unread} 未读`}>
          <Icon name="message" extra="sm" />
          {agent.unread}
        </span>
      ) : null}
      {agent.readOnly ? <span className="hub-ro-tag">read-only</span> : null}
      {kids ? (
        <span className="hub-ro-tag" data-tip="子 Agent">
          ↳ {kids} 子
        </span>
      ) : null}
    </>
  );
}

function Spark({ tokens }: { tokens: number }) {
  const hot = sparkLevel(tokens);
  return (
    <svg
      className="hc-spark"
      width="13"
      height="8"
      viewBox="0 0 13 8"
      aria-hidden="true"
    >
      {[1, 2, 3].map((index) => (
        <rect
          key={index}
          className={`hb-bar${index <= hot ? " hot" : ""}`}
          x={(index - 1) * 5}
          y={8 - index * 2}
          width="3"
          height={index * 2}
          rx="1"
        />
      ))}
    </svg>
  );
}

function ArtChips({ agent }: { agent: HubAgent }) {
  const chips = [
    agent.outputPath ? "out" : null,
    agent.patchPath ? "patch" : null,
    agent.branchName ? "branch" : null,
  ].filter((chip): chip is string => Boolean(chip));
  if (!chips.length) return null;
  return (
    <span className="hc-art">
      {chips.map((chip) => (
        <span className="hub-art" key={chip}>
          {chip}
        </span>
      ))}
    </span>
  );
}

function ModelLine({ agent }: { agent: HubAgent }) {
  const zh = useI18n().resolvedLanguage === "zh";
  if (agent.fallback)
    return (
      <span className="hub-model hub-fallback">
        {zh ? "回退模型" : "Fallback"} → {agent.fallback}
      </span>
    );
  if (agent.resolvedModel)
    return <span className="hub-model">{agent.resolvedModel}</span>;
  return null;
}

export function AgentCard({
  agent,
  selected,
  kids,
  now,
  onSelect,
}: {
  agent: HubAgent;
  selected: boolean;
  kids: number;
  now: number;
  onSelect: (id: string) => void;
}) {
  const zh = useI18n().resolvedLanguage === "zh";
  const pill = activityPill(agent, zh);
  const metrics = agent.metrics;
  const durationMs = hubDurationMs(agent, now);
  return (
    <button
      className={`hub-card${selected ? " sel" : ""}`}
      type="button"
      role="option"
      aria-selected={selected}
      data-hub-id={agent.id}
      onClick={() => onSelect(agent.id)}
    >
      <span className="hc-main">
        <span className="hc-top">
          <span className={`hub-act ${pill.cls}`}>{pill.label}</span>
          <span className="hc-name">
            <StatusDot status={agent.status} />
            <span>{agent.name}</span>
          </span>
          {agent.unread > 0 || agent.readOnly || kids > 0 ? (
            <span className="hc-flags">
              <FlagChips agent={agent} kids={kids} />
            </span>
          ) : null}
        </span>
        <span className="hc-task">{agent.task}</span>
        <AgentStage agent={agent} />
        <span className="hc-foot">
          {agent.modelRole ? (
            <span className="hub-role">{agent.modelRole}</span>
          ) : null}
          <ModelLine agent={agent} />
          <ArtChips agent={agent} />
        </span>
      </span>
      <span className="hc-side">
        {agent.startedAt ? (
          <span
            className="hc-start"
            data-tip={`已运行 ${durationMs === undefined ? "—" : fmtDur(durationMs)}`}
          >
            <Icon name="clock" extra="sm" />
            {fmtHM(agent.startedAt)}
          </span>
        ) : null}
        {metrics ? (
          <span className="hc-tokens">
            <b>{fmtNum(metrics.tokens)}</b>
            <i>tok</i>
            <Spark tokens={metrics.tokens} />
          </span>
        ) : null}
        {metrics ? (
          <span className="hc-pace">
            <span className="hub-num">
              <i>req</i>
              <b>{metrics.requests}</b>
            </span>
            <span className="hub-num">
              <i>tools</i>
              <b>{metrics.tools}</b>
            </span>
          </span>
        ) : null}
        <span className="hc-cost">
          {metrics ? fmtCost(metrics.cost) : "usage —"}
        </span>
      </span>
    </button>
  );
}

/** The subagent's current step: its running task's stage and completion estimate. */
function AgentStage({ agent }: { agent: HubAgent }) {
  if (!agent.stage && agent.completionPercent === undefined) return null;
  return (
    <span className="hub-agent-stage">
      {agent.completionPercent !== undefined ? <CompletionRing percent={agent.completionPercent} size={16} /> : null}
      {agent.stage ? <span className="ellipsis" title={agent.stage}>{agent.stage}</span> : null}
    </span>
  );
}

function AgentNode({
  agent,
  selected,
  now,
  onSelect,
}: {
  agent: HubAgent;
  selected: boolean;
  now: number;
  onSelect: (id: string) => void;
}) {
  const zh = useI18n().resolvedLanguage === "zh";
  const pill = activityPill(agent, zh);
  return (
    <button
      className={`hub-node st-${agent.status}${selected ? " sel" : ""}`}
      type="button"
      role="option"
      aria-selected={selected}
      data-hub-id={agent.id}
      onClick={() => onSelect(agent.id)}
    >
      <span className="hn-top">
        <span className={`hub-act ${pill.cls}`}>{pill.label}</span>
        <span className="hn-name">
          <StatusDot status={agent.status} />
          <span>{agent.name}</span>
        </span>
        {agent.unread > 0 || agent.readOnly ? (
          <span className="hn-flags">
            <FlagChips agent={agent} />
          </span>
        ) : null}
        {agent.metrics ? (
          <span className="hn-cost">{fmtCost(agent.metrics.cost)}</span>
        ) : null}
      </span>
      <span className="hn-task">{agent.task}</span>
      <AgentStage agent={agent} />
      <span className="hn-foot">
        {agent.modelRole ? (
          <span className="hub-role">{agent.modelRole}</span>
        ) : null}
        <span className="mono">
          {agent.fallback
            ? `${zh ? "回退模型" : "Fallback"} → ${agent.fallback}`
            : (agent.resolvedModel ?? "")}
        </span>
        <span>{fmtAge(agent.lastActivity, now, zh)}</span>
        <span className="hn-art">
          <ArtChips agent={agent} />
        </span>
      </span>
    </button>
  );
}

export function TreeGroup({
  head,
  kids,
  selected,
  now,
  onSelect,
}: {
  head: HubAgent;
  kids: HubAgent[];
  selected: string | null;
  now: number;
  onSelect: (id: string) => void;
}) {
  const zh = useI18n().resolvedLanguage === "zh";
  const pill = activityPill(head, zh);
  const cost = [head, ...kids].reduce(
    (sum, agent) => sum + (agent.metrics?.cost ?? 0),
    0,
  );
  return (
    <div className="hub-tgroup">
      <button
        className={`hub-tg-head${selected === head.id ? " sel" : ""}`}
        type="button"
        role="option"
        aria-selected={selected === head.id}
        data-hub-id={head.id}
        onClick={() => onSelect(head.id)}
      >
        <span className="tg-ic">
          <Icon name="bot" extra="sm" />
        </span>
        <span className={`hub-act ${pill.cls}`}>{pill.label}</span>
        <span className="tg-name">
          <StatusDot status={head.status} />
          <span>{head.name}</span>
        </span>
        <span className="tg-task">{head.task}</span>
        <span className="tg-right">
          <FlagChips agent={head} kids={kids.length} />
          <span className="tg-cost">{fmtCost(cost)}</span>
          <span className="tg-caret">
            <Icon name="chevron-d" extra="sm" />
          </span>
        </span>
      </button>
      <div className="hub-tchildren">
        <span className="hub-trail" aria-hidden="true" />
        <div className="hub-tleaves">
          {kids.map((kid) => (
            <AgentNode
              key={kid.id}
              agent={kid}
              selected={selected === kid.id}
              now={now}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function Kv({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  const zh = useI18n().resolvedLanguage === "zh";
  return (
    <div className="kv">
      <div className="k">{hubWord(label, zh)}</div>
      <div className={`v${mono ? " mono" : ""}`}>{children}</div>
    </div>
  );
}

export function EmptyBlock({
  icon,
  title,
  detail,
}: {
  icon: IconName;
  title?: string;
  detail: string;
}) {
  return (
    <div
      className="hub-empty-list"
      style={{ border: "none", padding: "var(--sp-24)" }}
    >
      <Icon name={icon} />
      {title ? <b>{title}</b> : null}
      <span>{detail}</span>
    </div>
  );
}
