import { useEffect, useState } from "react";
import type { FeatureSettingValue, PoolAccountOption } from "@omp-studio/studio-protocol";
import { useFeatureSettings, type FeatureSettingsProps } from "../settings/useFeatureSettings";
import { PREVIEW_POOL_ACCOUNTS } from "../preview/featureSettingsPreview";
import { createPreviewAgentDefinitions } from "../preview/subagentsPreview";
import { useI18n } from "../i18n";
import { hostErrorMessage } from "../hostError";
import "../settings/featureSettings.css";

type Pools = Record<string, Record<string, string[]> | null>;
function pools(value: FeatureSettingValue | undefined): Pools {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Pools : {};
}
export function AgentPoolsPane(props: FeatureSettingsProps) {
  const state = useFeatureSettings(props), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [accounts, setAccounts] = useState<PoolAccountOption[]>([]), [agents, setAgents] = useState<string[]>([]);
  const [agent, setAgent] = useState(""), [provider, setProvider] = useState("");
  const [mode, setMode] = useState("unrestricted"), [selected, setSelected] = useState<string[]>([]), [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const row = state.rows.find(row => row.key === "task.agentAccountPools"), saved = pools(row?.value);
  useEffect(() => {
    let current = true; setError(""); setAccounts([]); setAgents([]); setAgent(""); setProvider("");
    if (state.preview) {
      setAccounts(structuredClone(PREVIEW_POOL_ACCOUNTS));
      const names = createPreviewAgentDefinitions().agents.map(item => item.name);
      setAgents(names); setAgent(names[0] ?? ""); setProvider(PREVIEW_POOL_ACCOUNTS[0]!.provider);
    } else if (state.enabled && props.visible && props.client && props.context?.sessionId) {
      void Promise.all([
        state.invoke("accounts.pool.options", { sessionId: props.context.sessionId }),
        props.client.query("agents.definitions.get", {}),
      ]).then(([result, definitions]) => {
        if (!current) return;
        setAccounts(result.accounts); setTruncated(result.truncated);
        setAgents(definitions.agents.map(item => item.name)); setAgent(definitions.agents[0]?.name ?? ""); setProvider(result.accounts[0]?.provider ?? "");
      }).catch(cause => { if (current) setError(hostErrorMessage(cause, "Cannot read account pools")); });
    }
    return () => { current = false; };
  }, [props.client, props.context?.sessionId, props.visible, state.preview, state.enabled, state.invoke]);
  const providers = [...new Set([...accounts.map(row => row.provider), ...Object.keys(saved[agent] ?? {})])];
  useEffect(() => {
    const keys = saved[agent]?.[provider];
    setMode(keys === undefined ? "unrestricted" : keys.length ? "selected" : "blocked"); setSelected(keys ?? []);
  }, [row?.value, agent, provider]);
  const available = accounts.filter(item => item.provider === provider);
  const missing = selected.filter(key => !available.some(item => item.identityKey === key));
  const canSave = state.enabled && !!row && !!agent && !!provider && !state.busy && (mode !== "selected" || selected.length > 0);
  function save() {
    const next = structuredClone(saved), agentPools = { ...(next[agent] ?? {}) };
    if (mode === "unrestricted") delete agentPools[provider];
    else agentPools[provider] = mode === "blocked" ? [] : selected;
    next[agent] = Object.keys(agentPools).length ? agentPools : null;
    void state.save("task.agentAccountPools", next, "global");
  }
  return <section className="feature-settings" aria-label={zh ? "代理账号池" : "Agent account pools"}>
    <header className="feature-settings-head"><div><span className="feature-eyebrow">{zh ? "账号使用范围" : "ACCOUNT SCOPE"}{state.preview ? " · DEMO" : ""}</span><h3>{zh ? "代理账号池" : "Agent account pools"}</h3></div></header>
    <p className="feature-status">{zh ? "按代理限制 OAuth 账号；限制内的任务、Advisor 与后续子代理由原生引擎执行账号规则，不回退到范围外账号或 API Key。保存后用于新启动的代理。" : "Restrict OAuth accounts per agent. Native restrictions cover associated work and never fall back to outside accounts or API keys. Changes apply to newly started agents."}</p>
    {!state.enabled ? <p className="feature-status">{zh ? "连接支持账号池的 Runtime 后可配置。" : "Connect a Runtime with account pool support."}</p> : null}
    <div className="feature-split"><nav className="feature-list" aria-label={zh ? "选择代理账号配置" : "Agent account configuration"}>{agents.map(name => <button key={name} type="button" aria-pressed={name === agent} onClick={() => setAgent(name)}><strong>{name}</strong><span className="small">{Object.keys(saved[name] ?? {}).length || "—"}</span></button>)}</nav>
      <div className="feature-detail" key={agent}><h4>{agent || (zh ? "暂无代理定义" : "No agent definitions")}</h4>
        <div className="feature-actions"><select className="select" aria-label={zh ? "账号提供商" : "Account provider"} value={provider} disabled={!state.enabled || state.busy || !providers.length} onChange={event => setProvider(event.target.value)}>{providers.map(name => <option key={name} value={name}>{name}</option>)}</select>
          <select className="select" aria-label={zh ? "账号池策略" : "Account pool policy"} disabled={!state.enabled || state.busy || !provider} value={mode} onChange={event => setMode(event.target.value)}><option value="unrestricted">{zh ? "不限制" : "Unrestricted"}</option><option value="selected">{zh ? "仅所选账号" : "Selected accounts only"}</option><option value="blocked">{zh ? "禁止此提供商" : "Block this provider"}</option></select></div>
        {mode === "selected" ? [...available, ...missing.map(identityKey => ({ provider, identityKey, label: zh ? "已配置，但当前不可用" : "Configured but unavailable" }))].map(item => <label className="feature-check" key={item.identityKey}><input type="checkbox" checked={selected.includes(item.identityKey)} disabled={state.busy} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.identityKey] : previous.filter(key => key !== item.identityKey))} /><span><strong>{item.label}</strong><small className="muted mono">{item.identityKey}</small></span></label>) : <p className="feature-status">{mode === "blocked" ? zh ? "空账号池将拒绝此代理使用该提供商。" : "An empty pool refuses this provider for the agent." : zh ? "使用原生账号选择策略。" : "Use native account selection."}</p>}
        {!accounts.length && state.enabled && !state.loading ? <p className="feature-status">{zh ? "暂无可选 OAuth 账号。请先在账号页登录。" : "No OAuth accounts available. Sign in from Accounts first."}</p> : null}
        {truncated ? <p className="feature-status">{zh ? "账号列表达到显示上限；已保存的限制仍保留。" : "Account display limit reached; existing restrictions are preserved."}</p> : null}
        <div className="feature-actions"><button className="btn primary" disabled={!canSave} onClick={save}>{state.busy ? zh ? "保存中…" : "Saving…" : zh ? "保存账号范围" : "Save account scope"}</button>{row?.source === "runtime" ? <button className="btn outline" disabled={state.busy} onClick={() => void state.clear("task.agentAccountPools")}>{zh ? "清除会话覆盖" : "Clear session override"}</button> : null}</div>
        {state.notice ? <p role="status" className="feature-status">{zh ? "已保存，当前显示生效配置。" : "Saved. Effective settings are shown."}</p> : null}
      </div></div>
    {error || state.error ? <p role="alert" className="feature-error">{error || state.error}</p> : null}
  </section>;
}
