import { Icon } from "../../icons";
import { type HubAgent } from "./types";
import { fmtMetrics, fmtNum, hubWord, isAdvisor } from "./projection";
import { Kv } from "./AgentCards";

interface HubAgentOverviewProps {
  zh: boolean;
  select: (id: string, opts?: { scroll?: boolean; }) => void;
  agent: HubAgent;
}

export function HubAgentOverview({ zh, select, agent }: HubAgentOverviewProps) {

    const metrics = agent.metrics;
    const ctxPct = metrics?.contextWindow
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              ((metrics.contextTokens ?? 0) / metrics.contextWindow) * 100,
            ),
          ),
        )
      : null;
    const currentEmpty =
      !agent.currentTool &&
      !agent.lastIntent &&
      !agent.retryState &&
      agent.activeJobIds.length === 0 &&
      !(agent.status === "running" && agent.task !== "—");
    return (
      <>
        <div className="hub-sec-title">{hubWord("Task", zh)}</div>
        <div className="hub-kv">
          <Kv label="Task">{agent.task}</Kv>
        </div>
        <div className="hub-sec-title">{hubWord("Current", zh)}</div>
        <div className="hub-kv">
          {agent.currentTool ? (
            <Kv label="Tool">
              <span className="chip blue xs">{agent.currentTool.name}</span>
              {agent.currentTool.args ? ` ${agent.currentTool.args}` : ""}
            </Kv>
          ) : null}
          {agent.lastIntent ? (
            <Kv label="Last intent">{agent.lastIntent}</Kv>
          ) : null}
          {agent.retryState ? (
            <Kv label="Retry">
              <span style={{ color: "var(--amber)" }}>
                retry {agent.retryState.attempt}/{agent.retryState.maxAttempts}
              </span>
              {agent.retryState.errorMessage
                ? ` · ${agent.retryState.errorMessage}`
                : ""}
            </Kv>
          ) : null}
          {agent.status === "running" && agent.task !== "—" ? (
            <Kv label="Activity">{agent.task}</Kv>
          ) : null}
          {agent.activeJobIds.length ? (
            <Kv label="Active jobs" mono>
              {agent.activeJobIds.join(" · ")}
            </Kv>
          ) : null}
          {currentEmpty ? (
            <Kv label="—">
              {zh ? "无进行中的工具调用" : "No tool is running"}
            </Kv>
          ) : null}
        </div>
        <div className="hub-sec-title">{hubWord("Usage", zh)}</div>
        <div className="hub-kv">
          <Kv label="Metrics" mono>
            {fmtMetrics(metrics)}
          </Kv>
          {ctxPct != null && metrics?.contextWindow != null ? (
            <div className="kv">
              <div className="k">{hubWord("Context", zh)}</div>
              <div className="v">
                <div className="hub-ctx">
                  <div
                    className={`meter${ctxPct > 80 ? " danger" : ctxPct > 60 ? " warn" : ""}`}
                  >
                    <i style={{ width: `${ctxPct}%` }} />
                  </div>
                  <span className="mono">
                    {fmtNum(metrics.contextTokens ?? 0)} /{" "}
                    {fmtNum(metrics.contextWindow)} · {ctxPct}%
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <div className="hub-sec-title">{hubWord("Lineage", zh)}</div>
        <div className="hub-kv">
          <Kv label="Spawned by">{agent.parentId ?? "main"}</Kv>
          <div className="kv">
            <div className="k">{hubWord("Children", zh)}</div>
            <div className="v">
              {agent.children.length ? (
                <span className="hub-lineage-row">
                  {agent.children.map((id) => (
                    <button
                      key={id}
                      className="hub-child-link"
                      type="button"
                      onClick={() => select(id, { scroll: true })}
                    >
                      <Icon name="bot" extra="sm" />
                      {id}
                    </button>
                  ))}
                </span>
              ) : zh ? (
                "无子代理"
              ) : (
                "No children"
              )}
            </div>
          </div>
          <Kv label="Registered" mono>
            {agent.startedAt ? new Date(agent.startedAt).toISOString() : "—"}
          </Kv>
        </div>
        <div className="hub-sec-title">{hubWord("Changes", zh)}</div>
        <div className="hub-kv">
          <Kv label="Mode">
            {isAdvisor(agent) || agent.readOnly
              ? zh
                ? "只读 · 无代码变更"
                : "Read-only · 0 LoC"
              : zh
                ? "共享工作区 · 不按代理推算代码行数"
                : "Shared workspace · per-agent LoC not attributable"}
          </Kv>
          {agent.outputPath ? (
            <Kv label="Output" mono>
              {agent.outputPath}{" "}
              <span className="tiny muted">agent://{agent.id}</span>
            </Kv>
          ) : null}
          {agent.patchPath ? (
            <Kv label="Patch" mono>
              {agent.patchPath}
            </Kv>
          ) : null}
          {agent.nestedPatchPaths?.map((patch) => (
            <Kv key={patch} label="Nested patch" mono>
              {patch}
            </Kv>
          ))}
          {agent.isolated ? (
            <Kv label="Isolation">
              Isolated · {agent.hasLiveSession ? "live" : "transcript only"}
            </Kv>
          ) : null}
          {agent.branchName ? (
            <Kv label="Worktree branch" mono>
              {agent.branchName}
            </Kv>
          ) : null}
        </div>
      </>
    );
  
}
