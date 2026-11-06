import type { SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewTokenUsage } from "../preview/tokenUsagePreview";
import type { ViewedSessionTelemetryState } from "../telemetry/useViewedSessionTelemetry";
import { fmtTokens } from "./tokenUsage";
import "./tokenUsagePanel.css";

type UsageRow = { label: string; value: string };
export interface TokenUsageData {
  total: string;
  turn: string;
  cost: string;
  cacheHit: string;
  parts: { kind: "input" | "output" | "cache"; value: string; weight: number }[];
  rows: UsageRow[];
  details: UsageRow[];
}

function formatCost(value: number): string {
  return Number.isFinite(value) && value > 0 ? `≈$${value.toFixed(4)}` : "—";
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function liveTokenUsage(telemetry: SessionTelemetrySnapshot, zh: boolean): TokenUsageData {
  const { tokens, lastCompletedTurn: turn } = telemetry;
  const cache = tokens.cacheRead + tokens.cacheWrite;
  const tps = telemetry.generationTps ?? turn?.tps;
  const completedAt = turn ? Date.parse(turn.completedAt) : NaN;
  const details: UsageRow[] = [
    { label: zh ? "推理 Token" : "Reasoning tokens", value: fmtTokens(tokens.reasoning) },
    { label: zh ? "缓存读取" : "Cache read", value: fmtTokens(tokens.cacheRead) },
    { label: zh ? "缓存写入" : "Cache write", value: fmtTokens(tokens.cacheWrite) },
  ];
  if (telemetry.advisorCost !== undefined) details.push({ label: zh ? "Advisor 费用" : "Advisor cost", value: formatCost(telemetry.advisorCost) });
  if (telemetry.treeCost !== undefined) details.push({ label: zh ? "会话树费用 (USD)" : "Session tree (USD)", value: `$${telemetry.treeCost.toFixed(4)}` });
  if (telemetry.budget) details.push({
    label: zh ? "费用预算" : "Budget",
    value: `${telemetry.budget.maxCost === null ? "—" : `$${telemetry.budget.maxCost}`} · ${telemetry.budget.limitReached ? (zh ? "已达上限" : "Cap reached") : (zh ? "未达上限" : "Below cap")}`,
  });
  for (const [kind, count] of Object.entries(telemetry.editRejections ?? {})) {
    details.push({ label: `${zh ? "编辑拒绝" : "Edit rejection"} · ${kind}`, value: String(count) });
  }
  if (telemetry.servedModel) details.push({ label: zh ? "实际服务模型" : "Served model", value: telemetry.servedModel });
  if (telemetry.requestedModel && telemetry.requestedModel !== telemetry.servedModel) {
    details.push({ label: zh ? "请求模型" : "Requested model", value: telemetry.requestedModel });
  }
  return {
    total: fmtTokens(tokens.total),
    turn: turn ? fmtTokens(turn.total) : "—",
    cost: formatCost(tokens.cost),
    cacheHit: `${tokens.cacheRead + tokens.input > 0 ? Math.round(tokens.cacheRead / (tokens.cacheRead + tokens.input) * 100) : 0}%`,
    parts: [
      { kind: "input", value: fmtTokens(tokens.input), weight: tokens.input },
      { kind: "output", value: fmtTokens(tokens.output), weight: tokens.output },
      { kind: "cache", value: fmtTokens(cache), weight: cache },
    ],
    rows: [
      { label: zh ? "本轮输入 / 输出" : "Turn input / output", value: turn ? `${fmtTokens(turn.input)} / ${fmtTokens(turn.output)}` : "—" },
      { label: zh ? "本轮耗时" : "Turn duration", value: turn?.durationMs !== undefined ? formatDuration(turn.durationMs) : "—" },
      { label: zh ? "生成速度" : "Generation speed", value: tps !== undefined ? `${tps.toFixed(1)} tok/s` : "—" },
      { label: zh ? "上轮完成于" : "Last completed", value: Number.isFinite(completedAt) ? new Date(completedAt).toLocaleTimeString() : "—" },
    ],
    details,
  };
}

function UsageRows({ rows }: { rows: UsageRow[] }) {
  return <dl className="usage-rows">{rows.map(row => <div className="usage-row" key={row.label}>
    <dt>{row.label}</dt><dd>{row.value}</dd>
  </div>)}</dl>;
}

export function TokenUsagePanel({ telemetry, view, onOpenCounter, onClose }: {
  telemetry: SessionTelemetrySnapshot | null;
  view: ViewedSessionTelemetryState | undefined;
  onOpenCounter: () => void;
  onClose: () => void;
}) {
  const { preview, marks } = usePreviewMode();
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const data = preview ? previewTokenUsage(zh) : telemetry ? liveTokenUsage(telemetry, zh) : null;
  const status = preview ? (marks ? (zh ? "演示" : "Demo") : null)
    : !telemetry ? t(view?.status === "loading" ? "common.loading" : "common.unavailable")
    : t(view?.source === "persisted" ? "shell.lastRecorded" : view?.source === "archive-recomputed" ? "shell.currentEnvRecomputed" : "shell.realtime");
  const labels = { input: t("shell.inputTokens"), output: t("shell.outputTokens"), cache: t("shell.cacheTokens") };
  return <section className="usage-panel">
    <header className="usage-header">
      <Icon name="zap" extra="sm" /><h2>{t("shell.tokenUsage")}</h2>
      {status ? <span className="usage-status">{status}</span> : null}
      <button type="button" className="icon-btn usage-close" aria-label={zh ? "关闭用量详情" : "Close usage details"} onClick={onClose}><Icon name="x" extra="sm" /></button>
    </header>
    <div className="usage-scroll">
      {data ? <>
        <div className="usage-totals">
          <div><span className="usage-label">{t("shell.totalTokens")}</span><strong>{data.total}</strong><span className="usage-sub">{zh ? "本轮" : "This turn"} <b>{data.turn}</b></span></div>
          <div><span className="usage-label">{t("shell.cost")}</span><strong>{data.cost}</strong><span className="usage-sub">{zh ? "缓存命中" : "Cache hit"} <b className="usage-cache-hit">{data.cacheHit}</b></span></div>
        </div>
        <section className="usage-composition" aria-label={t("shell.composition")}>
          <div className="usage-section-label">{zh ? "用量构成" : "Token breakdown"}</div>
          <div className="usage-bar" aria-hidden="true">{data.parts.filter(part => part.weight > 0).map(part => <i key={part.kind} className={`usage-${part.kind}`} style={{ flexGrow: part.weight }} />)}</div>
          <dl className="usage-legend">{data.parts.map(part => <div key={part.kind}>
            <dt><i className={`usage-${part.kind}`} />{labels[part.kind]}</dt><dd>{part.value}</dd>
          </div>)}</dl>
        </section>
        <div className="usage-round"><UsageRows rows={data.rows} /></div>
        <details className="usage-disclosure">
          <summary><Icon name="chart" extra="sm" /><span>{zh ? "更多用量明细" : "More usage details"}</span><Icon name="chevron-r" extra="sm usage-chevron" /></summary>
          <div className="usage-disclosure-body"><UsageRows rows={data.details} /></div>
        </details>
      </> : <div className="usage-empty" role="status"><Icon name="chart" /><strong>{view?.status === "loading" ? (zh ? "正在读取用量…" : "Loading usage…") : (zh ? "暂无用量记录" : "No usage recorded")}</strong><p>{zh ? "会话用量可用后，将在这里显示。" : "Session usage will appear here when available."}</p></div>}
    </div>
    <footer className="telemetry-footer"><button type="button" onClick={onOpenCounter}><Icon name="code" extra="sm" /><span>{zh ? "离线 Token 计数" : "Offline token counter"}</span><Icon name="external" extra="sm" /></button></footer>
  </section>;
}
