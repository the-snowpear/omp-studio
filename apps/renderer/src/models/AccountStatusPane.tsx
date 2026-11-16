import { WorkspaceSection } from "../workspaces/Workspace";
import { AppSelect } from "../AppSelect";
import { AccountBudgetTable } from "./AccountBudgetTable";
import { Icon } from "../icons";
import "./accounts.css";
import { useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  StudioClient,
} from "@omp-studio/client-contract";
import type {
  AccountQuotaWindow,
  AccountResetPolicy,
  AccountStatusResult,
} from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_ACCOUNT_STATUS } from "../preview/accountsPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";

export function AccountStatusPane({
  client,
  standalone = false,
  visible = true,
  available = true,
  capabilities,
  sessionId,
}: {
  client: StudioClient;
  sessionId?: string | undefined;
  standalone?: boolean;
  visible?: boolean;
  available?: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
}) {
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [open, setOpen] = useState(standalone);
  const [status, setStatus] = useState<AccountStatusResult>();
  const [logoutTarget, setLogoutTarget] = useState<{
    id: string;
    label: string;
  }>();
  const logoutLock = useRef(false);
  const policyLock = useRef(false);
  const [policyTarget, setPolicyTarget] = useState<AccountResetPolicy>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    setStatus(undefined);
    setBusy(false);
    setError("");
    setLogoutTarget(undefined);
    setPolicyTarget(undefined);
    logoutLock.current = false;
    policyLock.current = false;
  }, [client, preview, sessionId]);
  const load = async (refresh: boolean) => {
    if (
      !preview &&
      (!available ||
        capabilities?.capabilities.some(
          (item) =>
            item.id === "accounts.status" && item.grade !== "unavailable",
        ) !== true)
    ) {
      setError(
        zh
          ? "此 Runtime 尚不支持账户状态。"
          : "This Runtime does not support account status.",
      );
      return;
    }
    const epoch = ++generation.current;
    setBusy(true);
    setError("");
    try {
      if (preview) {
        setStatus(PREVIEW_ACCOUNT_STATUS);
        return;
      }
      const handle = await client.command(
        capabilities?.capabilities.some(
          (row) =>
            row.id === "accounts.status.details" && row.grade !== "unavailable",
        )
          ? "accounts.status.details"
          : "accounts.status",
        { refresh },
      );
      const result = await waitReceipt<{ result: AccountStatusResult }>(
        client,
        handle.requestId,
        45000,
      );
      if (epoch === generation.current) setStatus(result.result);
    } catch (cause) {
      if (epoch === generation.current)
        setError(
          hostErrorMessage(
            cause,
            zh ? "账户状态不可用" : "Account status unavailable",
          ),
        );
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (visible && open) void load(false);
    return () => {
      generation.current++;
    };
  }, [client, preview, open, visible, available, capabilities, sessionId]);
  const canLogout =
    preview ||
    (!!sessionId &&
      available &&
      capabilities?.capabilities.some(
        (item) => item.id === "accounts.logout" && item.grade !== "unavailable",
      ) === true);
  const logout = async () => {
    if (!logoutTarget || logoutLock.current || busy || !canLogout) return;
    logoutLock.current = true;
    setBusy(true);
    setError("");
    const epoch = generation.current;
    try {
      if (preview)
        setStatus((current) =>
          current
            ? {
                ...current,
                accounts: current.accounts.filter(
                  (row) => row.id !== logoutTarget.id,
                ),
              }
            : current,
        );
      else {
        const handle = await client.command("accounts.logout", {
          sessionId: sessionId!,
          accountId: logoutTarget.id,
        });
        await waitReceipt(client, handle.requestId);
      }
      if (epoch === generation.current) {
        setLogoutTarget(undefined);
        logoutLock.current = false;
        if (!preview) await load(false);
      }
    } catch (cause) {
      if (epoch === generation.current)
        setError(
          hostErrorMessage(
            cause,
            zh
              ? "账户退出失败，请刷新后检查。"
              : "Sign-out failed. Refresh to check account status.",
          ),
        );
    } finally {
      if (epoch === generation.current) {
        logoutLock.current = false;
        setBusy(false);
      }
    }
  };
  const windowLabel = (window: AccountResetPolicy["window"]) => ({ "5h": zh ? "5 小时" : "5 Hour", weekly: zh ? "每周" : "Weekly", fable: "Fable" }[window]);
  const canSetPolicy = preview || !!sessionId && available && capabilities?.capabilities.some(row => row.id === "models.accounts.resetPolicy.set" && row.grade !== "unavailable") === true;
  const savePolicy = async (policy: AccountResetPolicy, mode: AccountResetPolicy["mode"]) => {
    if (busy || policyLock.current || !canSetPolicy) return;
    policyLock.current = true;
    setBusy(true); setError("");
    const epoch = generation.current;
    try {
      let next: AccountResetPolicy;
      if (preview) next = { ...policy, mode, source: "global" };
      else {
        const accepted = await client.command("models.accounts.resetPolicy.set", { sessionId: sessionId!, key: policy.key, mode });
        next = await waitReceipt<AccountResetPolicy>(client, accepted.requestId);
      }
      if (epoch === generation.current) {
        setStatus(current => current ? { ...current, accounts: current.accounts.map(account => ({ ...account, ...(account.resetPolicies ? { resetPolicies: account.resetPolicies.map(row => row.key === next.key ? next : row) } : {}) })) } : current);
        setPolicyTarget(undefined);
      }
    } catch (cause) {
      if (epoch === generation.current) setError(hostErrorMessage(cause, zh ? "窗口策略保存失败" : "Window policy could not be saved"));
    } finally {
      if (epoch === generation.current) { setBusy(false); policyLock.current = false; }
    }
  };
  const statusLabel = (status: AccountQuotaWindow["status"]) => ({
    ok: zh ? "额度正常" : "Available",
    warning: zh ? "接近额度上限" : "Near quota limit",
    exhausted: zh ? "额度已用尽" : "Quota exhausted",
    unknown: zh ? "状态未知" : "Unknown",
  })[status];
  const scopeLabel = (key: string) => ({
    provider: zh ? "服务商" : "Provider",
    accountId: zh ? "账户" : "Account",
    projectId: zh ? "项目" : "Project",
    orgId: zh ? "组织" : "Organization",
    modelId: zh ? "模型" : "Model",
    tier: zh ? "档位" : "Tier",
    windowId: zh ? "周期" : "Window",
    sharedGroup: zh ? "共享组" : "Shared group",
    shared: zh ? "共享" : "Shared",
  } as Record<string, string>)[key] ?? key;
  const quotas = (limits: AccountQuotaWindow[]) => {
    const windows = limits.filter(limit => limit.amount?.unit !== "usd");
    return <div className="account-quotas">
      {windows.length ? <div className="account-quota-grid">{windows.map(limit => {
        const used = limit.usedFraction;
        const tone = limit.status === "exhausted" || (used ?? 0) >= 0.95 ? "danger" : limit.status === "warning" || (used ?? 0) >= 0.8 ? "warn" : "";
        return <div key={limit.id} className={`account-quota is-${limit.status}`}>
          <div className="account-quota-head">
            <span className="account-quota-label">{limit.label}{limit.model ? <span className="muted"> · {limit.model}</span> : null}</span>
            <span className="account-quota-value mono">{used === undefined ? (zh ? "未知" : "Unknown") : `${(used * 100).toFixed(1)}%`}</span>
          </div>
          {used === undefined ? <span className="meter is-unknown" aria-hidden />
            : <span className={`meter${tone ? ` ${tone}` : ""}`} role="meter" aria-label={limit.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, used) * 100)}><i style={{ width: `${Math.min(1, used) * 100}%` }} /></span>}
          <span className="account-quota-status">
            <span className={`account-quota-dot is-${limit.status}`} aria-hidden />
            {statusLabel(limit.status)}
            {limit.resetsAt === undefined ? "" : ` · ${limit.resetLabel ?? (zh ? "恢复时间" : "Recovers")} ${new Date(limit.resetsAt).toLocaleString()}`}
          </span>
          {limit.scope ? <details className="account-quota-scope">
            <summary>{zh ? "额度作用域" : "Quota scope"}{limit.scope.shared ? (zh ? " · 共享额度" : " · Shared quota") : ""}{limit.scope.tier ? " · " + limit.scope.tier : ""}</summary>
            <dl>{Object.entries(limit.scope).filter(([key]) => key !== "shared").map(([key, value]) => <div key={key}><dt>{scopeLabel(key)}</dt><dd>{String(value)}</dd></div>)}</dl>
          </details> : null}
          {limit.notes?.map((note, index) => <p key={index} className="small muted">{note}</p>)}
        </div>;
      })}</div> : null}
      <AccountBudgetTable limits={limits} />
      {!limits.length ? <p className="small muted">{zh ? "尚无可归属到此账户的额度数据" : "No quota data attributed to this account"}</p> : null}
    </div>;
  };
  const policyModes: { value: AccountResetPolicy["mode"]; zh: string; en: string }[] = [
    { value: "unset", zh: "使用前询问", en: "Ask before spending" },
    { value: "no", zh: "不自动使用", en: "Never automatically spend" },
    { value: "yes", zh: "允许自动使用", en: "Allow automatic spending" },
  ];
  const resetsSummary = (account: AccountStatusResult["accounts"][number]) => account.resets.state === "available"
    ? zh ? `${account.resets.availableCount ?? "未知"} 张 · 可用 ${account.resets.redeemableCount ?? "未知"}` : `${account.resets.availableCount ?? "Unknown"} saved · ${account.resets.redeemableCount ?? "Unknown"} usable`
    : account.resets.state === "unfetched" ? zh ? "尚未读取" : "Not fetched" : zh ? "不可读取或此服务商不支持" : "Unavailable or unsupported";
  return (
    <WorkspaceSection
      className="runtime-credentials account-status"
      standalone={standalone}
      onOpenChange={setOpen}
      title={
        <>
          {zh ? "账户、额度与重置券" : "Accounts, quotas and saved resets"}
          {preview && marks ? (zh ? " · 演示" : " · Demo") : ""}
        </>
      }
    >
      {open ? (
        <>
          <div className="account-status-bar">
            <p className="small muted">
              {zh
                ? "刷新只读取额度和券状态，不消费重置券。"
                : "Refresh only reads quotas and resets; it never redeems them."}
              <span className="account-status-time">
                {status?.refreshedAt
                  ? `${zh ? "上次读取" : "Last fetched"} · ${new Date(status.refreshedAt).toLocaleString()}`
                  : zh ? "点击刷新读取服务商状态" : "Refresh to read provider status"}
              </span>
            </p>
            <button className="btn small outline" disabled={busy} onClick={() => void load(true)}>
              <Icon name="refresh" extra="sm" />{busy ? "…" : zh ? "刷新额度" : "Refresh quotas"}
            </button>
          </div>
          {error ? <p className="account-status-alert" role="alert">{error}</p> : null}
          {status?.usageUnavailable ? (
            <p className="account-status-alert is-warn" role="status">
              {zh
                ? "额度读取失败，以下配置身份不代表账户可用性。"
                : "Quota lookup failed. Configured identities do not establish account health."}
            </p>
          ) : null}
          <div className="account-cards">
          {status?.accounts.map((account) => (
            <section className={`account-status-row account-card${account.active ? " is-active" : ""}`} key={account.id} aria-label={`${account.provider} · ${account.label}`}>
              <div className="account-status-toolbar account-card-head">
                <span className="account-avatar" aria-hidden>{account.provider.slice(0, 1).toUpperCase()}</span>
                <b>{account.provider}</b>
                <span>{account.label}</span>
                {account.organization ? <span className="small muted">{account.organization}</span> : null}
                <span className="chip gray xs">{account.source}</span>
                {account.active ? <span className="chip blue xs">{zh ? "当前会话" : "Current session"}</span> : null}
                {account.source === "oauth" ? (
                  <button className="btn small ghost danger account-signout" disabled={busy || !canLogout} onClick={() => setLogoutTarget({ id: account.id, label: account.label })}>
                    {zh ? "退出登录" : "Sign out"}
                  </button>
                ) : null}
              </div>
              {account.policy ? <p className="account-policy-line small muted">Priority {account.policy.priority} · Reserve {account.policy.reservePct}% ({account.policy.reserveSource}) · {account.policy.state}{account.policy.remainingPct === undefined ? "" : ` · ${account.policy.remainingPct}% left`}</p> : null}
              {quotas(account.limits)}
              {account.resetPolicies?.length || account.source === "oauth" ? <div className="account-resets-block">
                <div className="account-resets-head">
                  <h4>{zh ? "重置券" : "Saved resets"}</h4>
                  {account.source === "oauth" ? <span className={`chip xs ${account.resets.state === "available" ? "purple" : "gray"}`}>{resetsSummary(account)}</span> : null}
                </div>
                {account.resetPolicies?.length ? <div className="account-window-policies">
                  {account.resetPolicies.map(policy => <div className="account-reset-window" key={policy.key}>
                    <span className="account-reset-label"><b>{windowLabel(policy.window)}</b><span className="tiny muted" data-tip={policy.key}>{zh ? "自动使用" : "Auto-spend"} · {policy.source}</span></span>
                    <AppSelect className="select" aria-label={`${account.provider} ${windowLabel(policy.window)} ${zh ? "重置策略" : "reset policy"}`} value={policy.mode} disabled={busy || !canSetPolicy} onChange={event => {
                      const mode = event.target.value as AccountResetPolicy["mode"];
                      if (mode === "yes") setPolicyTarget(policy); else void savePolicy(policy, mode);
                    }}>
                      {policyModes.map(mode => <option key={mode.value} value={mode.value}>{zh ? mode.zh : mode.en}</option>)}
                    </AppSelect>
                  </div>)}
                </div> : null}
                {account.resets.credits.length ? <ul className="account-credits">{account.resets.credits.map((credit, index) => <li key={index}>
                  <span className="account-credit-title">{credit.title}<span className="mono"> × {credit.remainingCount ?? "—"}</span></span>
                  <span className={`chip xs ${credit.usable === undefined ? "gray" : credit.usable ? "green" : "amber"}`}>{credit.usable === undefined ? "—" : credit.usable ? (zh ? "可用" : "Usable") : (zh ? "暂不可用" : "Not usable")}</span>
                  <span className="tiny muted">
                    {[credit.requiresLimit ? (zh ? "需额度耗尽" : "Requires an exhausted quota") : "", credit.clears.length ? credit.clears.join(", ") : "", credit.expiresAt ? `${zh ? "到期" : "expires"} ${Number.isFinite(Date.parse(credit.expiresAt)) ? new Date(credit.expiresAt).toLocaleString() : credit.expiresAt}` : ""].filter(Boolean).join(" · ")}
                  </span>
                </li>)}</ul> : null}
                {account.resetPolicies?.length ? <details className="account-policy-help">
                  <summary><Icon name="info" extra="sm" />{zh ? "自动使用规则" : "How auto-spend is decided"}</summary>
                  <p>{zh ? "原生按真正阻塞或将到期券的 governing window 判断，同一服务商的账户共享该策略。未知 Codex 窗口须同时遵循 5 小时和每周授权；Fable 单独授权，旧单项 autoRedeem 不授予 Fable。" : "Native policy follows the governing window of the block or expiring credit and applies across accounts on the same provider. An unknown Codex window needs both 5h and weekly consent. Fable has separate consent; legacy autoRedeem does not grant it."}</p>
                  {!canSetPolicy ? <p>{zh ? "此 Runtime 未提供窗口策略写入能力。" : "This Runtime cannot update saved-reset window policies."}</p> : null}
                </details> : null}
              </div> : null}
            </section>
          ))}
          {status?.unassigned.map((report, index) => (
            <section className="account-status-row account-card is-unassigned" key={index}>
              <div className="account-status-toolbar account-card-head">
                <span className="account-avatar" aria-hidden>?</span>
                <b>{report.provider}</b>
                <span className="small muted">{zh ? "未归属到账户的额度报告" : "Quota report without an account match"}</span>
              </div>
              {quotas(report.limits)}
            </section>
          ))}
          </div>
          {status && !status.accounts.length && !status.unassigned.length ? (
            <p className="small muted">
              {zh ? "没有账户状态记录" : "No account status records"}
            </p>
          ) : null}
          {policyTarget ? <div className="session-options-confirm" role="dialog" aria-label={zh ? "确认自动使用重置券" : "Confirm automatic reset spending"}>
            <strong>{windowLabel(policyTarget.window)} · {policyTarget.key}</strong>
            <p>{zh ? "允许原生在此窗口符合资格时自动消耗重置券。这是该服务商的全局窗口策略，不代表立即兑换，也不会授权其他窗口。" : "Allow native automatic spending when this window is eligible. This is a provider-wide policy, not an immediate redemption or consent for another window."}</p>
            <button className="btn danger" disabled={busy} onClick={() => void savePolicy(policyTarget, "yes")}>{zh ? "允许此窗口" : "Allow this window"}</button>
            <button className="btn outline" disabled={busy} onClick={() => setPolicyTarget(undefined)}>{zh ? "取消" : "Cancel"}</button>
          </div> : null}
          {logoutTarget ? (
            <div
              className="session-options-confirm"
              role="dialog"
              aria-label={zh ? "确认退出账户" : "Confirm account sign-out"}
            >
              <strong>{logoutTarget.label}</strong>
              <p>
                {zh
                  ? "移除此账户的原生登录凭据，会影响使用同一凭据的其他 OMP 会话。其他账户和 API 密钥保留。"
                  : "Remove the native login credential for this account. Other OMP sessions using it are affected; other accounts and API keys remain."}
              </p>
              <button
                className="btn danger"
                disabled={busy}
                onClick={() => void logout()}
              >
                {zh ? "确认退出" : "Sign out"}
              </button>
              <button
                className="btn outline"
                disabled={busy}
                onClick={() => setLogoutTarget(undefined)}
              >
                {zh ? "取消" : "Cancel"}
              </button>
            </div>
          ) : null}
          {status?.truncated ? (
            <p className="small muted">
              {zh
                ? "记录过多，仅显示有界摘要。"
                : "This bounded summary omits additional records."}
            </p>
          ) : null}
        </>
      ) : null}
    </WorkspaceSection>
  );
}
