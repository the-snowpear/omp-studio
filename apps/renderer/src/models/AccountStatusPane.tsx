import "./accounts.css";
import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { AccountQuotaWindow, AccountStatusResult } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_ACCOUNT_STATUS } from "../preview/accountsPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";

export function AccountStatusPane({ client }: { client: StudioClient }) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [open, setOpen] = useState(false); const [status, setStatus] = useState<AccountStatusResult>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const generation = useRef(0);
  const load = async (refresh: boolean) => {
    const epoch = ++generation.current; setBusy(true); setError("");
    try {
      if (preview) { setStatus(PREVIEW_ACCOUNT_STATUS); return; }
      const handle = await client.command("accounts.status", { refresh });
      const result = await waitReceipt<{ result: AccountStatusResult }>(client, handle.requestId, 45000);
      if (epoch === generation.current) setStatus(result.result);
    } catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, zh ? "账户状态不可用" : "Account status unavailable")); }
    finally { if (epoch === generation.current) setBusy(false); }
  };
  useEffect(() => {
    setStatus(undefined); if (open) void load(false);
    return () => { generation.current++; };
  }, [client, preview, open]);
  const quotas = (limits: AccountQuotaWindow[]) => <div className="account-quotas">{limits.length ? limits.map(limit => <div key={limit.id} className="account-quota">
    <span>{limit.label}{limit.model ? ` · ${limit.model}` : ""}</span>
    <span className="mono">{limit.usedFraction === undefined ? zh ? "未知" : "Unknown" : `${(limit.usedFraction * 100).toFixed(1)}%`}</span>
    {limit.usedFraction === undefined ? null : <progress aria-label={limit.label} value={Math.min(1, limit.usedFraction)} max={1} />}
    <span className="small muted">{limit.status}{limit.resetsAt === undefined ? "" : ` · ${zh ? "重置于" : "resets"} ${new Date(limit.resetsAt).toLocaleString()}`}</span>
  </div>) : <p className="small muted">{zh ? "尚无可归属到此账户的额度数据" : "No quota data attributed to this account"}</p>}</div>;
  return <details className="runtime-credentials account-status" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{zh ? "账户、额度与重置券" : "Accounts, quotas and saved resets"}{preview ? zh ? " · 演示" : " · Demo" : ""}</summary>
    {open ? <>
      <div className="account-status-toolbar"><p className="small muted">{zh ? "刷新只读取额度和券状态；此面板不会消费重置券。自动消费策略在设置中调整。" : "Refresh only reads quotas and saved resets. This panel never redeems credits. Change automatic redemption in Settings."}</p><button className="btn small outline" disabled={busy} onClick={() => void load(true)}>{busy ? "…" : zh ? "刷新额度" : "Refresh quotas"}</button></div>
      {error ? <p role="alert">{error}</p> : null}
      {status?.usageUnavailable ? <p role="status">{zh ? "额度读取失败，以下配置身份不代表账户可用性。" : "Quota lookup failed. Configured identities do not establish account health."}</p> : null}
      {status?.refreshedAt ? <p className="small muted">{zh ? "上次读取" : "Last fetched"} · {new Date(status.refreshedAt).toLocaleString()}</p> : <p className="small muted">{zh ? "点击刷新读取服务商状态" : "Refresh to read provider status"}</p>}
      {status?.accounts.map(account => <section className="account-status-row" key={account.id}>
        <div className="account-status-toolbar"><b>{account.provider}</b><span>{account.label}</span>{account.organization ? <span className="small muted">{account.organization}</span> : null}<span className="chip gray xs">{account.source}</span>{account.active ? <span className="chip blue xs">{zh ? "当前会话" : "Current session"}</span> : null}</div>
        {quotas(account.limits)}
        {account.source === "oauth" ? <div className="account-resets"><p className="small">{zh ? "重置券" : "Saved resets"} · {account.resets.state === "available" ? `${account.resets.availableCount ?? 0} ${zh ? "张；可用" : "saved; usable"} ${account.resets.redeemableCount ?? "—"}` : account.resets.state === "unfetched" ? zh ? "尚未读取" : "Not fetched" : zh ? "不可读取或此服务商不支持" : "Unavailable or unsupported"}</p>
          {account.resets.credits.map((credit, index) => <div className="small muted" key={index}>{credit.title} · {credit.remainingCount ?? "—"} · {credit.usable === undefined ? "—" : credit.usable ? zh ? "可用" : "Usable" : zh ? "暂不可用" : "Not usable"}{credit.requiresLimit ? ` · ${zh ? "需额度耗尽" : "Requires an exhausted quota"}` : ""}{credit.clears.length ? ` · ${credit.clears.join(", ")}` : ""}{credit.expiresAt ? ` · ${zh ? "到期" : "expires"} ${credit.expiresAt}` : ""}</div>)}
        </div> : null}
      </section>)}
      {status?.unassigned.map((report, index) => <section className="account-status-row" key={index}><b>{report.provider} · {zh ? "未归属到账户的额度报告" : "Quota report without an account match"}</b>{quotas(report.limits)}</section>)}
      {status && !status.accounts.length && !status.unassigned.length ? <p className="small muted">{zh ? "没有账户状态记录" : "No account status records"}</p> : null}
      {status?.truncated ? <p className="small muted">{zh ? "记录过多，仅显示有界摘要。" : "This bounded summary omits additional records."}</p> : null}
    </> : null}
  </details>;
}
