import type { StudioAgentUsage } from "@omp-studio/studio-protocol";
import type { SubagentHubTarget } from "./toolMeta";

export type SubagentMetricValues = {
  readonly tokens?: string | undefined;
  readonly tools?: string | number | undefined;
  readonly requests?: string | number | undefined;
  readonly files?: string | number | undefined;
  readonly cost?: string | undefined;
};

function formatMetricTokens(count: number): string {
  if (!Number.isFinite(count)) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(count));
}

/** Host usage is USD; compact-card strings (e.g. `¥ 0.51`) pass through unchanged. */
export function formatAgentCost(cost: number): string {
  if (!Number.isFinite(cost)) return "";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function metricsFromUsage(usage: StudioAgentUsage): SubagentMetricValues {
  const cost = formatAgentCost(usage.cost);
  return {
    tokens: formatMetricTokens(usage.tokens),
    tools: usage.tools,
    requests: usage.requests,
    ...(cost === "" ? {} : { cost }),
  };
}

/** Live roster usage wins; card-click strings fill gaps (files, preview). */
export function resolveSubagentMetrics(
  usage: StudioAgentUsage | undefined,
  target: Pick<SubagentHubTarget, "tokens" | "tools" | "requests" | "files" | "cost">,
): SubagentMetricValues {
  const live = usage === undefined ? {} : metricsFromUsage(usage);
  return {
    ...(target.tokens === undefined ? {} : { tokens: target.tokens }),
    ...(target.tools === undefined ? {} : { tools: target.tools }),
    ...(target.requests === undefined ? {} : { requests: target.requests }),
    ...(target.files === undefined ? {} : { files: target.files }),
    ...(target.cost === undefined ? {} : { cost: target.cost }),
    ...live,
  };
}

export function SubagentMetrics({ tokens, tools, requests, files, cost }: SubagentMetricValues) {
  if (tokens === undefined && tools === undefined && requests === undefined && files === undefined && !cost) {
    return null;
  }
  const aria = [
    tokens !== undefined ? `${tokens} tok` : "",
    tools !== undefined ? `${tools} tools` : "",
    requests !== undefined ? `${requests} req` : "",
    files !== undefined ? `${files} files` : "",
    cost ?? "",
  ].filter(Boolean).join("，");
  return (
    <div className="sa-metrics" aria-label={aria}>
      {tokens !== undefined ? <span className="sa-tok"><b>{tokens}</b><i>tok</i></span> : null}
      {tools !== undefined ? <span className="hub-num"><i>tools</i><b>{tools}</b></span> : null}
      {requests !== undefined ? <span className="hub-num"><i>req</i><b>{requests}</b></span> : null}
      {files !== undefined ? <span className="hub-num"><i>files</i><b>{files}</b></span> : null}
      {cost ? <span className="sa-cost">{cost}</span> : null}
    </div>
  );
}
