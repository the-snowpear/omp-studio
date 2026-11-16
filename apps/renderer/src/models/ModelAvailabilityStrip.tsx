import type { ModelAvailability } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import "./modelServices.css";

/**
 * Says where `availableModels` came from. Static recommendations and saved
 * credentials never make a model verified; only the current Runtime registry does.
 */
export function ModelAvailabilityStrip({ availability, refreshing, canRefresh, runtimeRefresh, demo, onRefresh }: {
  availability: ModelAvailability | undefined;
  refreshing: boolean;
  canRefresh: boolean;
  /** True when the refresh goes to the current Runtime registry, false for the CLI cache only. */
  runtimeRefresh: boolean;
  demo: boolean;
  onRefresh(): void;
}) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const tr = (zhText: string, enText: string) => zh ? zhText : enText;
  const verified = availability?.status === "verified" && availability.source === "runtime";
  const total = availability?.total;
  const title = verified
    ? tr("可用模型来自当前 Runtime", "Available models come from the current Runtime")
    : tr("未经 Runtime 验证", "Not verified by a Runtime");
  const detail = verified
    ? [
        total === undefined ? undefined : tr(`${total.toLocaleString()} 个已授权模型`, `${total.toLocaleString()} authorized models`),
        availability?.truncated ? tr("目录较大，已分页读取", "large registry, read in pages") : undefined,
        availability?.version ? `${tr("代次", "generation")} ${availability.version.slice(0, 8)}` : undefined,
      ].filter(Boolean).join(" · ")
    : availability?.reason ?? tr("下面是本地配置与静态推荐目录，可以照常编辑，但不代表已授权或可调用。", "Below are local configuration and static recommendations. You can edit them, but they do not mean a model is authorized or callable.");
  const refreshTip = runtimeRefresh
    ? tr("让当前 Runtime 重新拉取在线目录与凭据授权，完成后重读", "Ask the current Runtime to re-fetch online catalogs and credential grants, then reload")
    : tr("没有运行中的 Runtime：只更新留给之后会话的 CLI 缓存，本页仍为未验证", "No running Runtime: only refreshes the CLI cache for later sessions; this page stays unverified");
  return <div className={`mc-availability ${verified ? "is-verified" : "is-unverified"}`} role="status">
    <span className="mc-availability-mark"><Icon name={verified ? "shield" : "info"} extra="sm" /></span>
    <span className="mc-availability-text">
      <b>{title}{demo ? <span className="chip gray xs">{tr("演示", "Demo")}</span> : null}</b>
      <span>{detail}</span>
    </span>
    <button type="button" className="btn small outline" disabled={!canRefresh || refreshing} data-tip={refreshTip} onClick={onRefresh}>
      {refreshing ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" extra="sm" />}
      {runtimeRefresh ? tr("刷新授权目录", "Refresh authorized models") : tr("刷新本地缓存", "Refresh CLI cache")}
    </button>
  </div>;
}
