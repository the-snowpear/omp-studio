import { WorkspaceSection } from "../workspaces/Workspace";
import "./accounts.css";
import { useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  StudioClient,
} from "@omp-studio/client-contract";
import type {
  AccountQuotaWindow,
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
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [open, setOpen] = useState(standalone);
  const [status, setStatus] = useState<AccountStatusResult>();
  const [logoutTarget, setLogoutTarget] = useState<{
    id: string;
    label: string;
  }>();
  const logoutLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    setStatus(undefined);
    setBusy(false);
    setError("");
    setLogoutTarget(undefined);
    logoutLock.current = false;
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
  const quotas = (limits: AccountQuotaWindow[]) => (
    <div className="account-quotas">
      {limits.length ? (
        limits.map((limit) => (
          <div key={limit.id} className="account-quota">
            <span>
              {limit.label}
              {limit.model ? ` · ${limit.model}` : ""}
            </span>
            <span className="mono">
              {limit.usedFraction === undefined
                ? zh
                  ? "未知"
                  : "Unknown"
                : `${(limit.usedFraction * 100).toFixed(1)}%`}
            </span>
            {limit.usedFraction === undefined ? null : (
              <progress
                aria-label={limit.label}
                value={Math.min(1, limit.usedFraction)}
                max={1}
              />
            )}
            <span className="small muted">
              {
                {
                  ok: zh ? "额度正常" : "Available",
                  warning: zh ? "接近额度上限" : "Near quota limit",
                  exhausted: zh ? "额度已用尽" : "Quota exhausted",
                  unknown: zh ? "状态未知" : "Unknown",
                }[limit.status]
              }
              {limit.resetsAt === undefined
                ? ""
                : ` · ${limit.resetLabel ?? (zh ? "恢复时间" : "Recovers")} ${new Date(limit.resetsAt).toLocaleString()}`}
            </span>
            {limit.scope ? (
              <details className="small muted">
                <summary>
                  {zh ? "额度作用域" : "Quota scope"}
                  {limit.scope.shared
                    ? zh
                      ? " · 共享额度"
                      : " · Shared quota"
                    : ""}
                  {limit.scope.tier ? " · " + limit.scope.tier : ""}
                </summary>
                <dl>
                  {Object.entries(limit.scope)
                    .filter(([key]) => key !== "shared")
                    .map(([key, value]) => (
                      <div key={key}>
                        <dt>
                          {{
                            provider: zh ? "服务商" : "Provider",
                            accountId: zh ? "账户" : "Account",
                            projectId: zh ? "项目" : "Project",
                            orgId: zh ? "组织" : "Organization",
                            modelId: zh ? "模型" : "Model",
                            tier: zh ? "档位" : "Tier",
                            windowId: zh ? "周期" : "Window",
                            sharedGroup: zh ? "共享组" : "Shared group",
                            shared: zh ? "共享" : "Shared",
                          }[
                            key as keyof NonNullable<
                              AccountQuotaWindow["scope"]
                            >
                          ] ?? key}
                        </dt>
                        <dd>{String(value)}</dd>
                      </div>
                    ))}
                </dl>
              </details>
            ) : null}
            {limit.notes?.map((note, index) => (
              <p key={index} className="small muted">
                {note}
              </p>
            ))}
          </div>
        ))
      ) : (
        <p className="small muted">
          {zh
            ? "尚无可归属到此账户的额度数据"
            : "No quota data attributed to this account"}
        </p>
      )}
    </div>
  );
  return (
    <WorkspaceSection
      className="runtime-credentials account-status"
      standalone={standalone}
      onOpenChange={setOpen}
      title={
        <>
          {zh ? "账户、额度与重置券" : "Accounts, quotas and saved resets"}
          {preview ? (zh ? " · 演示" : " · Demo") : ""}
        </>
      }
    >
      {open ? (
        <>
          <div className="account-status-toolbar">
            <p className="small muted">
              {zh
                ? "刷新只读取额度和券状态；此面板不会消费重置券。自动消费策略在设置中调整。"
                : "Refresh only reads quotas and saved resets. This panel never redeems credits. Change automatic redemption in Settings."}
            </p>
            <button
              className="btn small outline"
              disabled={busy}
              onClick={() => void load(true)}
            >
              {busy ? "…" : zh ? "刷新额度" : "Refresh quotas"}
            </button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
          {status?.usageUnavailable ? (
            <p role="status">
              {zh
                ? "额度读取失败，以下配置身份不代表账户可用性。"
                : "Quota lookup failed. Configured identities do not establish account health."}
            </p>
          ) : null}
          {status?.refreshedAt ? (
            <p className="small muted">
              {zh ? "上次读取" : "Last fetched"} ·{" "}
              {new Date(status.refreshedAt).toLocaleString()}
            </p>
          ) : (
            <p className="small muted">
              {zh
                ? "点击刷新读取服务商状态"
                : "Refresh to read provider status"}
            </p>
          )}
          {status?.accounts.map((account) => (
            <section className="account-status-row" key={account.id}>
              <div className="account-status-toolbar">
                <b>{account.provider}</b>
                <span>{account.label}</span>
                {account.organization ? (
                  <span className="small muted">{account.organization}</span>
                ) : null}
                <span className="chip gray xs">{account.source}</span>
                {account.source === "oauth" ? (
                  <button
                    className="btn small outline danger"
                    disabled={busy || !canLogout}
                    onClick={() =>
                      setLogoutTarget({ id: account.id, label: account.label })
                    }
                  >
                    {zh ? "退出登录" : "Sign out"}
                  </button>
                ) : null}
                {account.active ? (
                  <span className="chip blue xs">
                    {zh ? "当前会话" : "Current session"}
                  </span>
                ) : null}
              </div>
              {quotas(account.limits)}
              {account.source === "oauth" ? (
                <div className="account-resets">
                  <p className="small">
                    {zh ? "重置券" : "Saved resets"} ·{" "}
                    {account.resets.state === "available"
                      ? `${account.resets.availableCount ?? 0} ${zh ? "张；可用" : "saved; usable"} ${account.resets.redeemableCount ?? "—"}`
                      : account.resets.state === "unfetched"
                        ? zh
                          ? "尚未读取"
                          : "Not fetched"
                        : zh
                          ? "不可读取或此服务商不支持"
                          : "Unavailable or unsupported"}
                  </p>
                  {account.resets.credits.map((credit, index) => (
                    <div className="small muted" key={index}>
                      {credit.title} · {credit.remainingCount ?? "—"} ·{" "}
                      {credit.usable === undefined
                        ? "—"
                        : credit.usable
                          ? zh
                            ? "可用"
                            : "Usable"
                          : zh
                            ? "暂不可用"
                            : "Not usable"}
                      {credit.requiresLimit
                        ? ` · ${zh ? "需额度耗尽" : "Requires an exhausted quota"}`
                        : ""}
                      {credit.clears.length
                        ? ` · ${credit.clears.join(", ")}`
                        : ""}
                      {credit.expiresAt
                        ? ` · ${zh ? "到期" : "expires"} ${Number.isFinite(Date.parse(credit.expiresAt)) ? new Date(credit.expiresAt).toLocaleString() : credit.expiresAt}`
                        : ""}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
          {status?.unassigned.map((report, index) => (
            <section className="account-status-row" key={index}>
              <b>
                {report.provider} ·{" "}
                {zh
                  ? "未归属到账户的额度报告"
                  : "Quota report without an account match"}
              </b>
              {quotas(report.limits)}
            </section>
          ))}
          {status && !status.accounts.length && !status.unassigned.length ? (
            <p className="small muted">
              {zh ? "没有账户状态记录" : "No account status records"}
            </p>
          ) : null}
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
