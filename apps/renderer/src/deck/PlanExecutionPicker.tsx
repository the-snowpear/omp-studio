import { AppSelect } from "../AppSelect";
import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { NativePlanReview } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import "./planExecution.css";
export function useNativePlanReview(client: StudioClient, sessionId: string | undefined, enabled: boolean, active: boolean, stateVersion: number | undefined) {
  const [details, setDetails] = useState<NativePlanReview>(), [role, setRole] = useState("");
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const previousReview = useRef("");
  useEffect(() => {
    let current = true;
    if (!enabled || !active || !sessionId) { setDetails(undefined); setRole(""); setLoading(false); setError(""); previousReview.current = ""; return; }
    setLoading(true); setError("");
    void (async () => {
      const handle = await client.command("mode.plan.review.details", { sessionId });
      const result = (await waitReceipt<{ result: NativePlanReview }>(client, handle.requestId)).result;
      if (!current) return;
      setDetails(result);
      const sameReview = previousReview.current === result.reviewId;
      setRole(value => sameReview && result.tiers.some(tier => tier.role === value) ? value : result.selectedRole ?? "");
      previousReview.current = result.reviewId ?? "";
    })().catch(cause => { if (current) { setDetails(undefined); setError(hostErrorMessage(cause, "Cannot read plan execution tiers")); } }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client, sessionId, enabled, active, stateVersion]);
  return { details, role, setRole, loading, error };
}
export function PlanExecutionPicker({ details, role, onChange, disabled, loading, error }: {
  details?: NativePlanReview | undefined; role: string; onChange(role: string): void; disabled?: boolean | undefined; loading?: boolean | undefined; error?: string | undefined;
}) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const tier = details?.tiers.find(tier => tier.role === role);
  return <div className="plan-execution"><label><span>{zh ? "执行档位" : "Execution tier"}</span><AppSelect className="select" aria-label={zh ? "计划执行档位" : "Plan execution tier"} value={role} disabled={disabled || loading || !details?.available || !details.tiers.length} onChange={event => onChange(event.target.value)}>{!details?.tiers.length ? <option value="">{loading ? zh ? "读取中…" : "Loading…" : zh ? "使用原有模型" : "Use the existing model"}</option> : details.tiers.map(item => <option key={item.role} value={item.role}>{item.role} · {item.name}</option>)}</AppSelect></label>{tier ? <span className="plan-execution-detail">{tier.provider}/{tier.model}{tier.thinkingLevel ? " · " + tier.thinkingLevel : ""}</span> : null}{error ? <span role="alert" className="feature-error">{error}</span> : null}</div>;
}
