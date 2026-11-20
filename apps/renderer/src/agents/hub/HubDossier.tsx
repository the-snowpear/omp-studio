import type { ReactNode } from "react";
import { Icon } from "../../icons";
import { AgentAvatar } from "../AgentAvatar";
import { type Caps, type HubAgent } from "./types";
import { activityPill, fmtAge, fmtDur, hubDurationMs, hubTone, isAdvisor } from "./projection";

/** A Hub agent's avatar: its tone and task progress fed into the shared {@link AgentAvatar}. */
export function HubSigil({ agent, size, ring = false }: { agent: HubAgent; size: number; ring?: boolean }) {
  const progress = agent.completionPercent === undefined
    ? undefined
    : Math.max(0, Math.min(1, agent.completionPercent / 100));
  return <AgentAvatar agentId={agent.id} name={agent.name} tone={hubTone(agent)} size={size} progress={progress} ring={ring} />;
}

/** Status pill: the one place the dossier says what state the agent is in. */
export function HubStatusPill({ agent, zh }: { agent: HubAgent; zh: boolean }) {
  const pill = activityPill(agent, zh);
  return <span className={`hub-act ${pill.cls}`}>{pill.label}</span>;
}

/**
 * The dossier head: who the agent is, what state it is in, which model serves
 * it, and the actions that make sense for that state. It stays put while the
 * tab body below it scrolls.
 */
export function HubDossierHead({
  agent,
  parentName,
  now,
  zh,
  caps,
  busy,
  scrolled,
  onBack,
  onParent,
  onOpen,
  onRevive,
  onKill,
  onRelease,
}: {
  agent: HubAgent;
  parentName: string | null;
  now: number;
  zh: boolean;
  caps: Caps;
  busy: boolean;
  scrolled: boolean;
  onBack: () => void;
  onParent: () => void;
  onOpen: () => void;
  onRevive: () => void;
  onKill: () => void;
  onRelease: () => void;
}) {
  const duration = hubDurationMs(agent, now);
  const model = agent.fallback ?? agent.resolvedModel;
  const parked = agent.status === "parked";
  const ended = agent.status === "aborted" || agent.status === "released";
  return (
    <header className="hub-dossier-head" data-scrolled={scrolled || undefined}>
      <div className="hub-dossier-top">
        <button
          className="icon-btn small hub-drawer-back"
          type="button"
          data-tip={zh ? "返回" : "Back"}
          aria-label={zh ? "返回" : "Back"}
          onClick={onBack}
        >
          <Icon name="arrow-l" extra="sm" />
        </button>
        <button
          className="hub-dossier-crumb"
          type="button"
          aria-label={`${zh ? "父代理" : "Parent"}: ${parentName ?? (zh ? "主对话" : "Main conversation")}`}
          data-tip={zh ? "查看父代理" : "View parent"}
          onClick={onParent}
        >
          <Icon name="arrow-u" extra="sm" />
          <span>{parentName ?? (zh ? "主对话" : "Main conversation")}</span>
        </button>
        <span className="hub-dossier-kind">
          {isAdvisor(agent) ? (zh ? "顾问" : "Advisor") : zh ? "子代理" : "Subagent"}
        </span>
      </div>
      <div className="hub-dossier-id" key={agent.id}>
        <HubSigil agent={agent} size={44} ring />
        <div className="hub-dossier-name">
          <h3 title={agent.name}>{agent.name}</h3>{agent.peer && <code>agent://peers</code>}
          {!!agent.waitingOn?.length && <p>{zh ? "正在等待" : "Waiting for"} · {agent.waitingOn.join(" → ")}</p>}
          {!!agent.waiters?.length && <p>{zh ? "等待此代理" : "Waiters"} · {agent.waiters.map(waiter => [waiter.waiter, ...waiter.via].join(" → ")).join(", ")}</p>}
          <div className="hub-dossier-line">
            <HubStatusPill agent={agent} zh={zh} />
            <span className="hub-dossier-meta">
              <span data-tip={zh ? "运行时长" : "Run time"}>
                <Icon name="clock" extra="sm" />
                {duration === undefined ? "—" : fmtDur(duration)}
              </span>
              <span>
                {zh ? "最近活动" : "Active"} {fmtAge(agent.lastActivity, now, zh)}
              </span>
            </span>
            {agent.readOnly && !isAdvisor(agent) ? (
              <span className="hub-ro-tag">{zh ? "只读" : "Read-only"}</span>
            ) : null}
          </div>
          {agent.modelRole || model ? (
            <div className="hub-dossier-model">
              {agent.modelRole ? <span className="hub-role">{agent.modelRole}</span> : null}
              {agent.fallback ? (
                <span
                  className="hub-dossier-fallback"
                  data-tip={zh ? "正在使用回退模型" : "Using a fallback model"}
                  aria-label={zh ? "回退模型" : "Fallback model"}
                >
                  <Icon name="undo" extra="sm" />
                </span>
              ) : null}
              {model ? (
                <span className="hub-dossier-model-name" title={model}>
                  {model}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="hub-dossier-actions">
        <button
          className="btn small primary"
          type="button"
          disabled={!caps.open}
          data-tip={caps.openWhy ?? undefined}
          onClick={onOpen}
        >
          <Icon name="message" extra="sm" />
          {zh ? "打开对话" : "Open conversation"}
        </button>
        {parked ? (
          <button
            className="btn small outline"
            type="button"
            disabled={!caps.revive || busy}
            data-tip={caps.reviveWhy ?? undefined}
            onClick={onRevive}
          >
            <Icon name="refresh" extra="sm" />
            {zh ? "恢复" : "Revive"}
          </button>
        ) : null}
        {ended ? (
          <button
            className="btn small outline"
            type="button"
            disabled={!caps.release || busy}
            data-tip={caps.releaseWhy ?? undefined}
            onClick={onRelease}
          >
            <Icon name="x" extra="sm" />
            {zh ? "释放" : "Release"}
          </button>
        ) : (
          <button
            className="btn small danger hub-dossier-stop"
            type="button"
            disabled={!caps.kill || busy}
            data-tip={caps.killWhy ?? undefined}
            onClick={onKill}
          >
            <Icon name="stop" extra="sm" />
            {zh ? "停止" : "Stop"}
          </button>
        )}
      </div>
    </header>
  );
}

/** A titled block of the overview, in the deck inspector's language: label, hairline, content. */
export function DossierSection({ title, count, children }: { title: string; count?: number | undefined; children: ReactNode }) {
  return (
    <section className="hub-dossier-sec">
      <h4>
        {title}
        {count !== undefined ? <span>{count}</span> : null}
      </h4>
      {children}
    </section>
  );
}

/** A collapsible overview section (technical facts). The body unfolds each time it opens. */
export function DossierDisclosure({ title, icon, children }: { title: ReactNode; icon: "cpu" | "info"; children: ReactNode }) {
  return (
    <details className="hub-dossier-fold">
      <summary>
        <Icon name={icon} extra="sm" />
        <span>{title}</span>
        <Icon name="chevron-r" extra="sm" />
      </summary>
      <div className="hub-dossier-fold-body">{children}</div>
    </details>
  );
}
