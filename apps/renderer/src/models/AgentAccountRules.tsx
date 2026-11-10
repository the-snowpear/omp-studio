import { useId, useState } from "react";
import type { ModelConfigReadModel } from "@omp-studio/client-contract";
import type { ProviderAccountPools } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";
import { Brand, hasBrand } from "../brands";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { sameAccountPools, type AccountPolicy, type AgentAccountPoolsController } from "./useAgentAccountPools";
import "./agentAccountPools.css";

function policyLabel(keys: string[] | undefined, zh: boolean): string {
  return keys === undefined ? (zh ? "默认账号规则" : "Default account rules")
    : keys.length === 0 ? (zh ? "已停用" : "Blocked")
      : zh ? `限定 ${keys.length} 个账号` : `${keys.length} selected account${keys.length === 1 ? "" : "s"}`;
}

export function AgentPoolSummary({ pools, dirty }: { pools?: ProviderAccountPools | null | undefined; dirty: boolean }) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const entries = Object.entries(pools ?? {});
  const title = entries.map(([provider, keys]) => `${provider} · ${policyLabel(keys, zh)}`).join("\n");
  return <span className={`sa-account-summary${dirty ? " is-dirty" : ""}`} data-tip={title || undefined}>
    <Icon name="key" extra="sm" />
    {dirty ? (zh ? "账号规则未保存" : "Unsaved account rules")
      : entries.length ? (zh ? `${entries.length} 个提供商有账号规则` : `Account rules · ${entries.length} provider${entries.length === 1 ? "" : "s"}`)
        : (zh ? "默认账号规则" : "Default account rules")}
  </span>;
}

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", "openai-codex": "OpenAI Codex", "google-gemini-cli": "Gemini CLI", "google-antigravity": "Google Antigravity" };

export function AgentAccountRules({ agent, state, models, disabled = false, onManageAccounts }: {
  agent: string;
  state: AgentAccountPoolsController;
  models: ModelConfigReadModel | null;
  disabled?: boolean;
  onManageAccounts?: (() => void) | undefined;
}) {
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const id = useId();
  const pools = state.value(agent), effective = state.settings?.effective[agent];
  const [addedProviders, setAddedProviders] = useState<string[]>([]);
  const providers = [...new Set([...Object.keys(pools), ...Object.keys(effective ?? {}), ...state.accounts.map(item => item.provider), ...addedProviders])];
  const otherProviders = (models?.providers ?? []).filter(item => !providers.includes(item.id));
  const [expanded, setExpanded] = useState<string | null>(null);
  const open = expanded ?? providers[0];
  const locked = disabled || state.busy || !state.available || !state.settings;
  const differs = state.settings && !sameAccountPools(state.settings.global[agent], effective);

  return <section className="mp-sec sa-accounts" aria-labelledby={`${id}-title`}>
    <div className="sa-accounts-heading">
      <div><h3 id={`${id}-title`}><Icon name="key" />{zh ? "账号使用策略" : "Account rules"}</h3>
        <p>{zh ? "为这个子代理指定可用账号，模型选择保持独立。" : "Choose which accounts this agent can use, independently of its model."}</p></div>
      {onManageAccounts ? <button type="button" className="btn small ghost" onClick={onManageAccounts}>{zh ? "管理账号" : "Manage accounts"}<Icon name="arrow-r" extra="sm" /></button> : null}
    </div>
    <div className="sa-accounts-scope"><span><Icon name="globe" extra="sm" />{zh ? "全局规则" : "Global rules"}</span><span>{zh ? "用于新启动或恢复的子代理" : "Applies when an agent starts or revives"}</span>
      {state.dirty(agent) ? <span className="sa-accounts-unsaved">{zh ? "未保存" : "Unsaved"}</span> : null}</div>
    {!state.available ? <div className="sa-accounts-empty"><Icon name="plug" /><div><strong>{zh ? "连接 Runtime 后配置账号" : "Connect a Runtime to configure accounts"}</strong><p>{zh ? "需要支持账号规则的 Runtime，代理定义仍可编辑。" : "A Runtime with account rule support is required. Agent definitions remain editable."}</p></div></div>
      : state.loading && !state.settings ? <p className="sa-accounts-message" role="status">{zh ? "正在读取账号与规则…" : "Loading accounts and rules…"}</p>
        : providers.length === 0 ? <div className="sa-accounts-empty"><Icon name="user" /><div><strong>{zh ? "尚未登录 OAuth 账号" : "No OAuth accounts connected"}</strong><p>{zh ? "登录后可为不同子代理分配账号。默认规则也支持已配置的 API Key。" : "Sign in to assign accounts to agents. Default rules also support configured API keys."}</p></div></div>
          : <div className="sa-account-providers">{providers.map((provider, index) => {
            const keys = pools[provider], isOpen = open === provider, mode = state.policy(agent, provider);
            const available = state.accounts.filter(item => item.provider === provider);
            const missing = (keys ?? []).filter(key => !available.some(item => item.identityKey === key));
            const name = models?.providers.find(item => item.id === provider)?.name ?? PROVIDER_NAMES[provider] ?? provider;
            const regionId = `${id}-${index}`;
            const description = mode === "selected" ? (zh ? "仅使用勾选的 OAuth 账号；不可用时不会借用其他账号或 API Key。" : "Only checked OAuth accounts may be used. Other accounts and API keys are excluded.")
              : mode === "blocked" ? (zh ? "此子代理不能使用该提供商的账号或 API Key。其他提供商仍按各自规则执行。" : "This agent cannot use this provider's accounts or API keys. Other providers keep their own rules.")
                : (zh ? "由 OMP 按默认或继承的账号规则选择，也可使用已配置的 API Key。" : "OMP follows its default or inherited account rules, including configured API keys.");
            return <div className={`sa-account-provider${isOpen ? " is-open" : ""}`} key={provider}>
              <button type="button" className="sa-account-provider-head" aria-expanded={isOpen} aria-controls={regionId} onClick={() => setExpanded(isOpen ? "" : provider)}>
                <span className="sa-provider-symbol">{hasBrand(provider) ? <Brand id={provider} /> : <Icon name="server" />}</span>
                <span className="sa-provider-name"><strong>{name}</strong><small>{zh ? `${available.length} 个已登录账号` : `${available.length} connected account${available.length === 1 ? "" : "s"}`}</small></span>
                <span className={`sa-provider-policy${keys !== undefined ? " is-custom" : ""}`}>{mode === "selected" && !keys?.length ? (zh ? "待选择账号" : "Choose accounts") : policyLabel(keys, zh)}</span>
                <Icon name="chevron-d" extra="sm" />
              </button>
              {isOpen ? <div id={regionId} className="sa-account-provider-body">
                <fieldset className="sa-account-policy" disabled={locked}>
                  <legend className="sr-only">{name} {zh ? "账号策略" : "account policy"}</legend>
                  {[["default", zh ? "默认规则" : "Default"], ["selected", zh ? "指定账号" : "Selected accounts"], ["blocked", zh ? "停用提供商" : "Block provider"]].map(([value, label]) => <label key={value} className={mode === value ? "is-selected" : ""}>
                    <input type="radio" name={`${id}-${provider}`} value={value} checked={mode === value} onChange={() => state.setPolicy(agent, provider, value as AccountPolicy)} /><span>{label}</span>
                  </label>)}
                </fieldset>
                <p className="sa-account-policy-hint">{description}</p>
                {mode === "selected" ? <div className="sa-account-choices">
                  {available.map(account => {
                    const identity = account.identityKey, email = identity.match(/^email:([^|]+)/)?.[1];
                    const label = account.label === identity ? (email ?? identity.replace(/^account:/, "")) : account.label.startsWith(`${identity} · `) ? account.label.slice(identity.length + 3) : account.label;
                    return <label className={`sa-account-choice${keys?.includes(identity) ? " is-checked" : ""}`} key={identity}>
                      <input type="checkbox" checked={keys?.includes(identity) ?? false} disabled={locked} onChange={event => state.selectAccounts(agent, provider, event.target.checked ? [...(keys ?? []), identity] : (keys ?? []).filter(key => key !== identity))} />
                      <span className="sa-account-avatar"><Icon name="user" extra="sm" /></span>
                      <span className="sa-account-identity"><strong>{label}</strong><small>{email && email !== label ? email : identity}</small></span>
                      <span className="sa-account-auth">OAuth</span>
                    </label>;
                  })}
                  {missing.map(identity => <label className="sa-account-choice is-missing" key={identity}><input type="checkbox" checked disabled={locked} onChange={() => state.selectAccounts(agent, provider, (keys ?? []).filter(key => key !== identity))} /><span className="sa-account-avatar"><Icon name="alert" extra="sm" /></span><span className="sa-account-identity"><strong>{identity}</strong><small>{zh ? "已保存的账号，当前未登录或不可用" : "Saved account, currently signed out or unavailable"}</small></span></label>)}
                  {!available.length && !missing.length ? <p className="sa-accounts-message">{zh ? "此提供商暂无可选 OAuth 账号，请先登录。" : "Sign in to an OAuth account for this provider first."}</p> : null}
                  {!keys?.length ? <p className="sa-account-validation" role="status">{zh ? "请选择至少一个账号，或切换为默认规则／停用提供商。" : "Choose at least one account, or use Default / Block provider."}</p> : null}
                </div> : null}
              </div> : null}
            </div>;
          })}</div>}
    {state.available && otherProviders.length > 0 ? <div className="sa-account-add"><AppSelect aria-label={zh ? "添加提供商规则" : "Add provider rules"} className="select" value="" disabled={locked} onChange={event => { setAddedProviders(previous => [...previous, event.target.value]); setExpanded(event.target.value); }}>
      <option value="">{zh ? "+ 添加提供商规则" : "+ Add provider rules"}</option>
      {otherProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
    </AppSelect></div> : null}
    {differs ? <div className="sa-account-effective" role="note"><Icon name="info" extra="sm" /><div><strong>{zh ? "当前会话另有生效规则" : "This session has additional effective rules"}</strong><p>{zh ? "项目或会话配置优先于全局。保存不会移除这些覆盖。" : "Project or session settings take precedence. Saving preserves those overrides."}</p><div>{Object.entries(effective ?? {}).map(([provider, keys]) => <span key={provider}>{PROVIDER_NAMES[provider] ?? provider} · {policyLabel(keys, zh)}</span>)}{!Object.keys(effective ?? {}).length ? <span>{zh ? "当前使用默认账号规则" : "Currently using default account rules"}</span> : null}</div></div></div> : null}
    {state.error ? <p className="sa-account-validation" role="alert">{state.error}</p> : null}
    {state.truncated ? <p className="sa-accounts-message">{zh ? "账号列表达到显示上限，已有规则仍保留。" : "The account display limit was reached. Existing rules are preserved."}</p> : null}
    <div className="sa-accounts-foot"><p><Icon name="branch" extra="sm" />{zh ? "Advisor 与无独立规则的后续子代理沿用此策略。" : "Advisors and nested agents without their own rules follow this policy."}</p>
      {state.dirty(agent) ? <button type="button" className="btn small ghost" disabled={disabled || state.busy} onClick={() => state.discard(agent)}>{zh ? "撤销账号修改" : "Discard account changes"}</button> : null}</div>
  </section>;
}
