import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { BenchmarkAccounts, BenchmarkAccountSelection } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { previewBenchmarkAccounts } from "../preview/benchmarksPreview";
import "./benchmarkAccount.css";

/** Values the native `--service-tier` flag accepts; empty keeps the configured `tier.*` settings. */
export const NATIVE_SERVICE_TIERS = ["none", "auto", "default", "flex", "scale", "priority", "ultrafast"] as const;

/** Provider prefix of a native selector, or undefined for aliases the Runtime resolves. */
export function selectorProvider(selector: string): string | undefined {
  const slash = selector.indexOf("/");
  return slash > 0 ? selector.slice(0, slash) : undefined;
}

/**
 * Native `--account N` choice for a benchmark. Each provider in the run must
 * have an Nth OAuth account; the selection carries the stable credential IDs
 * so the Runtime refuses (rather than silently re-routes) a changed roster.
 */
export function BenchmarkAccountPicker({ client, sessionId, preview, zh, providers, value, onChange, disabled }: {
  client: StudioClient;
  sessionId?: string | undefined;
  preview: boolean;
  zh: boolean;
  providers: readonly string[];
  value: BenchmarkAccountSelection | undefined;
  onChange(value: BenchmarkAccountSelection | undefined): void;
  disabled?: boolean;
}) {
  const t = (cn: string, en: string) => zh ? cn : en;
  const key = [...new Set(providers)].sort().join("\n");
  const unique = useMemo(() => key ? key.split("\n") : [], [key]);
  const [rosters, setRosters] = useState<BenchmarkAccounts[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [reload, setReload] = useState(0);
  const valueRef = useRef(value);
  valueRef.current = value;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    let active = true;
    setRosters(undefined); setError("");
    if (!unique.length || (!preview && !sessionId)) return;
    setLoading(true);
    const read = (providerId: string) => preview ? Promise.resolve(previewBenchmarkAccounts(providerId))
      : client.command("benchmarks.accounts.read", { sessionId: sessionId!, providerId })
        .then(handle => waitReceipt<{ result: BenchmarkAccounts }>(client, handle.requestId)).then(receipt => receipt.result);
    void Promise.all(unique.map(read)).then(next => {
      if (!active) return;
      setRosters(next);
      // A selection is only valid for the exact providers and credential rows it was made for.
      const current = valueRef.current;
      if (current) {
        const same = Object.keys(current.credentialIds).sort().join("\n") === unique.join("\n")
          && next.every(roster => roster.accounts.find(option => option.account === current.account)?.credentialId === current.credentialIds[roster.providerId]);
        if (!same) { setStale(true); changeRef.current(undefined); }
      }
    }).catch(cause => { if (active) setError(hostErrorMessage(cause, t("无法读取 OAuth 账户", "Could not read OAuth accounts"))); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, sessionId, preview, unique, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const shared = rosters ? Math.min(...rosters.map(roster => roster.accounts.length)) : 0;
  const missing = rosters?.filter(roster => roster.accounts.length === 0).map(roster => roster.providerId) ?? [];
  const options = Array.from({ length: shared }, (_, index) => index + 1);
  const describe = (account: number) => rosters!.map(roster => `${roster.providerId}: ${roster.accounts.find(option => option.account === account)?.label ?? "—"}`).join(" · ");
  const pick = (raw: string) => {
    setStale(false);
    if (!raw || !rosters) { onChange(undefined); return; }
    const account = Number(raw);
    onChange({ account, credentialIds: Object.fromEntries(rosters.map(roster => [roster.providerId, roster.accounts.find(option => option.account === account)!.credentialId])) });
  };

  if (!unique.length) return null;
  return <div className="bench-account">
    <div className="bench-account-row">
      <label>
        <span>{t("OAuth 账户", "OAuth account")}</span>
        <AppSelect className="select" aria-label={t("基准使用的 OAuth 账户", "Benchmark OAuth account")} value={value ? String(value.account) : ""} disabled={disabled || loading || !rosters || options.length === 0} onChange={event => pick(event.target.value)}>
          <option value="">{t("原生默认凭证", "Native default credential")}</option>
          {options.map(account => <option key={account} value={String(account)}>{t(`账户 ${account}`, `Account ${account}`)} · {describe(account)}</option>)}
        </AppSelect>
      </label>
      <button type="button" className="icon-btn" aria-label={t("重新读取账户", "Reload accounts")} data-tip={t("重新读取账户", "Reload accounts")} disabled={disabled || loading} onClick={() => setReload(count => count + 1)}><Icon name="refresh" extra="sm" /></button>
    </div>
    {loading ? <p className="bench-account-note" role="status">{t("正在读取账户…", "Reading accounts…")}</p>
      : error ? <p className="bench-account-note is-warn" role="alert">{error}</p>
      : stale ? <p className="bench-account-note is-warn" role="status">{t("账户名单或模型已变化，原选择已清除，请重新选择。", "The account roster or models changed; the earlier choice was cleared. Choose again.")}</p>
      : missing.length ? <p className="bench-account-note">{t(`${missing.join("、")} 没有 OAuth 账户，只能使用原生默认凭证。`, `${missing.join(", ")} has no OAuth account, so only the native default credential applies.`)}</p>
      : rosters && unique.length > 1 ? <p className="bench-account-note">{t("同一序号会用于每个 Provider；只列出所有 Provider 都有的账户。", "The same number applies to every provider; only numbers every provider has are listed.")}</p>
      : null}
  </div>;
}
