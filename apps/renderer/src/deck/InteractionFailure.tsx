import { hostErrorMessage } from "../hostError";
import { useI18n } from "../i18n";

export type InteractionFailureDetail = { readonly cause?: unknown };

export function InteractionFailure({ failure, onRefresh, refreshing }: {
  failure: InteractionFailureDetail;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean;
}) {
  const zh = useI18n().resolvedLanguage === "zh";
  const cause = failure.cause;
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined;
  const message = hostErrorMessage(cause, zh ? "Host 未确认此次响应，请检查连接后重试。" : "The Host did not confirm this response. Check the connection and retry.");
  return <div className="ask-error interaction-failure" role="alert">
    <strong>{zh ? "提交失败，卡片与输入已保留。" : "Submission failed. Your card and entries have been kept."}</strong>
    <p>{message}{code ? <> <code>{code}</code></> : null}</p>
    {onRefresh ? <div className="interaction-recovery">
      <span>{zh ? "重新同步以确认是否仍待处理；同步不会自动提交审批。" : "Sync to check whether this is still pending. Syncing does not submit an approval."}</span>
      <button type="button" className="btn small outline" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? zh ? "同步中…" : "Syncing…" : zh ? "重新同步" : "Sync again"}
      </button>
    </div> : null}
  </div>;
}
