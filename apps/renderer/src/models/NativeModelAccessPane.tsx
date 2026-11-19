import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { ModelAntigravityReadiness, ModelProviderRoster } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_ANTIGRAVITY_READINESS, previewProviderRoster } from "../preview/modelServicesPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { modelServiceAvailable, NATIVE_LOGIN_WAIT_MS, type ModelAuthController, type ModelServiceContext } from "./useModelAuth";
import { ModelSystemTemplateInspector } from "./ModelSystemTemplates";
import "./modelServices.css";

const ANTIGRAVITY_CLI = "antigravity-cli";
const OPENCODE_CONSOLE = "https://opencode.ai/auth";

export function isOpenCodeProvider(id: string): boolean {
  return id === "opencode-go" || id === "opencode-zen";
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A focused native-provider workflow, not a static catalog pretending to be an authorized workspace roster. */
export function NativeModelAccessPane({ context, auth, visible, selected, onSelect, onChanged, accounts = false }: {
  context: ModelServiceContext; auth: ModelAuthController; visible: boolean; onChanged?: () => void; accounts?: boolean;
  selected: string; onSelect: (id: string) => void;
}) {
  const { preview, marks } = usePreviewMode(), { resolvedLanguage, t } = useI18n(), zh = resolvedLanguage === "zh";
  const tr = (zhText: string, enText: string) => zh ? zhText : enText;
  const [roster, setRoster] = useState<ModelProviderRoster>();
  const [inspected, setInspected] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"draft" | "saving" | "saved" | "unconfirmed">("draft");
  const keyField = useId();
  const [risk, setRisk] = useState(false), [riskAnswer, setRiskAnswer] = useState("");
  const [resume, setResume] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const epoch = useRef(0), lock = useRef(false);
  const provider = auth.providers?.find(row => row.id === selected);
  const openCode = isOpenCodeProvider(selected);
  useEffect(() => {
    if (visible && !selected && auth.providers?.length) onSelect(auth.providers[0]!.id);
  }, [auth.providers, onSelect, selected, visible]);
  useEffect(() => {
    epoch.current++; setRoster(undefined); setInspected(""); setRefreshError(undefined); setBusy(false); lock.current = false; setRisk(false); setRiskAnswer(""); setResume(false);
    setApiKey(""); setKeyStatus("draft");
    return () => { epoch.current++; };
  }, [visible, context.client, context.sessionId, preview, selected]);
  /* The countdown mirrors the native 600 s wait; it never decides the outcome. */
  useEffect(() => {
    if (!auth.loginStartedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [auth.loginStartedAt]);
  const canRefresh = preview || modelServiceAvailable(context, "models.provider.roster.refresh");
  const keyAvailable = auth.canEdit && provider?.kind === "api-key" && provider.available;
  const canSaveKey = keyAvailable && !auth.busyProvider && !busy;
  const refresh = async (notify = true) => {
    if (!visible || !selected || !canRefresh || lock.current) return;
    const generation = epoch.current;
    lock.current = true;
    setBusy(true);
    setRefreshError(undefined);
    setInspected("");
    if (openCode) setRoster(undefined);
    try {
      let next: ModelProviderRoster;
      if (preview) next = previewProviderRoster(selected);
      else {
        const handle = await context.client!.command("models.provider.roster.refresh", { sessionId: context.sessionId!, providerId: selected });
        next = await waitReceipt<ModelProviderRoster>(context.client!, handle.requestId, 45000);
      }
      if (generation === epoch.current) {
        setRoster(next);
        if (notify && (!openCode || !preview)) onChanged?.();
      }
    } catch (cause) { if (generation === epoch.current) setRefreshError(hostErrorMessage(cause, "")); }
    finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  };
  const saveOpenCodeKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSaveKey || !apiKey.trim() || lock.current) return;
    const generation = epoch.current;
    lock.current = true;
    setKeyStatus("saving");
    setRefreshError(undefined);
    setRoster(undefined);
    setInspected("");
    const saved = await auth.key(selected, apiKey);
    if (generation !== epoch.current) return;
    lock.current = false;
    setKeyStatus(saved ? "saved" : "unconfirmed");
    if (!saved) return;
    setApiKey("");
    if (!preview) onChanged?.();
    await refresh(false);
  };
  const login = async () => {
    if (!provider || !visible) return;
    if (preview && provider.warning && !risk) { setRisk(true); setRiskAnswer(""); return; }
    if (risk && riskAnswer.trim().toLowerCase() !== "yes") return;
    setRisk(false);
    if (await auth.login(selected)) onChanged?.();
  };
  const unpause = async () => {
    if (!provider || !auth.unpause) return;
    setResume(false);
    if (await auth.unpause(provider.id)) onChanged?.();
  };
  if (!visible) return null;
  const waiting = auth.loginPending && auth.busyProvider === selected && auth.loginStartedAt !== undefined;
  const left = waiting ? NATIVE_LOGIN_WAIT_MS - (now - auth.loginStartedAt!) : 0;
  const catalogFailed = refreshError !== undefined || roster?.status === "error";
  const catalogDetail = refreshError || roster?.error;
  const canCheckOpenCode = canRefresh && (provider?.authenticated || keyStatus === "saved");
  const panelError = !openCode && refreshError !== undefined ? refreshError || tr("无法读取原生目录", "Native roster unavailable") : auth.error;
  return <section className="model-native-access mp-sec">
    <h3>{accounts ? tr("原生登录与凭据", "Native sign-in and credentials") : tr("原生供应商目录", "Native provider roster")}{preview && marks ? tr(" · 演示", " · Demo") : ""}</h3>
    {!openCode ? <p className="sec-desc">{tr("登录、风险确认与模型发现沿用当前 Runtime。Otari 等授权目录只显示该凭据实际获得的模型，不导入其他工作区的缓存。", "Sign-in, risk challenges and discovery use this Runtime. Authorized rosters such as Otari show only models granted to this credential, never another workspace's cache.")}</p> : null}
    <div className="model-native-toolbar">
      <AppSelect className={openCode ? "model-native-key-picker" : ""} aria-label={tr("原生供应商", "Native provider")} value={selected} disabled={!auth.providers?.length || busy || !!auth.busyProvider} onChange={event => onSelect(event.target.value)}>
        {!auth.providers?.length ? <option value="">{auth.supported ? tr("正在读取…", "Loading…") : tr("原生授权不可用", "Native auth unavailable")}</option> : null}
        {auth.providers?.map(row => <option key={row.id} value={row.id}>{row.name} · {row.id}{row.paused ? tr(" · 已暂停", " · paused") : ""}</option>)}
      </AppSelect>
      {provider ? <span className="model-native-status">
        <span className={`chip xs ${provider.authenticated ? "green" : "gray"}`}>{provider.authenticated ? tr("凭据已配置", "Credential configured") : tr("未配置凭据", "No credential")}</span>
        {provider.paused ? <span className="chip xs amber"><Icon name="pause" extra="sm" />{tr("已暂停", "Paused")}</span> : null}
      </span> : <span className="small muted">{tr("状态未知", "Status unknown")}</span>}
      {!openCode ? <button className="btn small outline" disabled={!auth.canLogin || !provider?.available || !!auth.busyProvider || busy} onClick={() => void login()}><Icon name="key" extra="sm" />{tr("原生登录", "Native sign-in")}</button> : null}
      {!openCode && !accounts ? <button className="btn small outline" disabled={!provider || !canRefresh || busy || !!auth.busyProvider} onClick={() => void refresh()}><Icon name="refresh" extra="sm" />{tr("刷新授权目录", "Refresh authorized roster")}</button> : null}
    </div>
    {openCode && provider ? <form className="model-native-key" onSubmit={event => void saveOpenCodeKey(event)}>
      <div className="model-native-key-heading">
        <div>
          <h4>{t("modelConfig.openCode.configure")}</h4>
          <p>{t("modelConfig.openCode.instructions", { provider: provider.name })}</p>
        </div>
        <a className="btn outline" href={OPENCODE_CONSOLE} target="_blank" rel="noopener noreferrer">
          {t("modelConfig.openCode.console")}<Icon name="external" extra="sm" />
        </a>
      </div>
      <div className="model-native-key-controls">
        <div className="field">
          <label htmlFor={keyField}>API Key</label>
          <input id={keyField} className="input mono" type="password" autoComplete="new-password" spellCheck={false}
            value={apiKey} disabled={!canSaveKey} onChange={event => { setApiKey(event.target.value); setKeyStatus("draft"); }} />
        </div>
        <button className="btn lg primary" type="submit" disabled={!canSaveKey || !apiKey.trim()}>{t("modelConfig.openCode.save")}</button>
      </div>
      {!keyAvailable && !provider.paused ? <p className="small muted">{t("modelConfig.openCode.unavailable")}</p> : null}
      {keyStatus === "unconfirmed" ? <p className="model-native-key-error" role="alert">
        {t("modelConfig.openCode.unconfirmed")}{auth.error ? <small>{auth.error}</small> : null}
      </p> : null}
      <div className="model-native-key-feedback" role="status">
        {keyStatus === "saving" ? <p><span className="spinner" aria-hidden="true" />{t("modelConfig.openCode.saving")}</p> : null}
        {keyStatus === "saved" ? <p className="model-native-key-saved"><Icon name="check" extra="sm" />{t("modelConfig.openCode.saved")}</p> : null}
        {busy ? <p>{t("modelConfig.openCode.catalogLoading")}</p> : null}
        {keyStatus === "saved" && !canRefresh ? <p>{t("modelConfig.openCode.catalogUnavailable")}</p> : null}
        {roster && !catalogFailed ? <p>{roster.models.length > 0
          ? t("modelConfig.openCode.catalogReady", { count: roster.total ?? roster.models.length })
          : t("modelConfig.openCode.catalogEmpty")}</p> : null}
      </div>
      {catalogFailed ? <p className="model-native-key-error" role="alert">
        {t("modelConfig.openCode.catalogError")}{catalogDetail ? <small>{catalogDetail}</small> : null}
      </p> : null}
      {canCheckOpenCode ? <button className="btn small outline model-native-key-check" type="button" disabled={busy || !!auth.busyProvider} onClick={() => void refresh()}>
        <Icon name="refresh" extra="sm" />{t("modelConfig.openCode.catalogCheck")}
      </button> : null}
    </form> : null}
    {openCode && !provider && auth.providers?.length ? <p className="small muted">{t("modelConfig.openCode.unavailable")}</p> : null}
    {waiting ? <div className="model-native-login" role="status">
      <span className="spinner" aria-hidden="true" />
      <span><b>{tr("等待在浏览器中完成登录", "Waiting for sign-in in your browser")}</b><small>{tr(`Runtime 最多等待 10 分钟，剩余 ${clock(left)}。关闭本页或取消会同时结束后台登录。`, `The Runtime waits up to 10 minutes; ${clock(left)} left. Closing this page or cancelling ends the background sign-in too.`)}</small></span>
      <i className="model-native-login-bar" style={{ "--left": String(Math.max(0, Math.min(1, left / NATIVE_LOGIN_WAIT_MS))) } as CSSProperties} aria-hidden="true" />
      <button className="btn small outline" onClick={() => void auth.cancel()}>{tr("取消登录", "Cancel sign-in")}</button>
    </div> : null}
    {provider?.paused ? <div className="model-native-paused" role="note">
      <Icon name="pause" extra="sm" />
      <span><b>{tr("该供应商已被 Runtime 暂停", "The Runtime paused this provider")}</b>
        <small>{provider.pauseReason ?? tr("未提供原因。", "No reason given.")}</small>
        <small>{tr("暂停与凭据是两回事：重新登录或读取状态都不会解除暂停。", "A pause is separate from credentials: signing in again or refreshing does not lift it.")}</small></span>
      <button className="btn small outline" disabled={!auth.canUnpause || !!auth.busyProvider} onClick={() => setResume(true)}>{tr("恢复使用…", "Resume…")}</button>
    </div> : null}
    {provider?.id === ANTIGRAVITY_CLI ? <AntigravityReadiness context={context} visible={visible} zh={zh} /> : null}
    {provider?.warning ? <p className="model-native-warning"><Icon name="alert" extra="sm" /><span>{provider.warning}</span></p> : null}
    {!auth.supported ? <p className="small muted">{tr("连接支持原生 GUI challenge 的 Runtime 后可操作；没有读取模型时保持空态。", "Connect a Runtime with the native GUI challenge channel to continue. No read model is substituted.")}</p> : null}
    {panelError && keyStatus !== "unconfirmed" ? <p role="alert">{panelError}</p> : null}
    {roster && (!openCode || (!catalogFailed && roster.models.length > 0)) ? <div className="model-native-roster">
      {!openCode ? <p className="small muted">{roster.providerId} · {roster.authoritative ? tr("凭据授权的原生目录", "Native authoritative roster") : tr("当前原生目录", "Current native roster")}{roster.error ? ` · ${roster.error}` : ""}</p> : null}
      {roster.models.map(model => <div className="model-native-model" key={model.selector}>
        <span><b>{model.name}</b><code>{model.selector}</code></span><span className="chip gray xs">{model.kind}</span><code>{model.api}</code>
        <span className="small muted">{model.contextWindow === undefined ? tr("上下文未知", "Context unknown") : `${model.contextWindow.toLocaleString()} tokens`}</span>
        {model.kind === "chat" ? <button className="btn small outline" onClick={() => setInspected(model.selector)}>{tr("系统提示详情", "System prompt details")}</button> : <span className="small muted">{tr("用于对应原生角色，不作为聊天参数", "Native role runner, not chat parameters")}</span>}
      </div>)}
      {roster.truncated ? <p className="small muted">{tr(`当前显示前 ${roster.models.length} / ${roster.total ?? "未知"} 个授权模型；角色选择器仍读取完整的有界分页目录。`, `Showing the first ${roster.models.length} / ${roster.total ?? "unknown"} authorized models. Role pickers still read the bounded paginated catalog.`)}</p> : null}
      {!roster.models.length ? <p className="small muted">{roster.authenticated ? tr("当前授权未报告模型。该供应商也可能只提供凭据或搜索服务。", "This credential reported no models. The provider may supply credentials or search services only.") : tr("没有该供应商的原生授权目录。", "No authorized native roster for this provider.")}</p> : null}
    </div> : null}
    {inspected ? <ModelSystemTemplateInspector context={context} selector={inspected} visible={visible} /> : null}
    {risk ? <div className="session-options-confirm" role="dialog" aria-label={tr("原生登录风险确认", "Native login risk confirmation")}>
      <strong>{provider?.name}</strong><p>{provider?.warning}</p><label>{tr("输入 yes 接受风险", "Type yes to accept the risk")}<input className="input" autoFocus value={riskAnswer} onChange={event => setRiskAnswer(event.target.value)} /></label>
      <button className="btn danger" disabled={riskAnswer.trim().toLowerCase() !== "yes"} onClick={() => void login()}>{tr("继续登录", "Continue sign-in")}</button><button className="btn outline" onClick={() => setRisk(false)}>{tr("取消", "Cancel")}</button>
    </div> : null}
    {resume && provider ? <div className="session-options-confirm" role="dialog" aria-label={tr("恢复已暂停的供应商", "Resume a paused provider")}>
      <strong>{tr(`恢复 ${provider.name}？`, `Resume ${provider.name}?`)}</strong>
      <p>{provider.pauseReason ?? tr("Runtime 暂停了这个供应商。", "The Runtime paused this provider.")}</p>
      <p className="small muted">{tr("恢复对本机所有会话生效（全局），之后的请求可能产生费用或再次触发限额。", "Resuming applies to every session on this machine (global). Later requests may cost money or hit the limit again.")}</p>
      <button className="btn primary" disabled={!!auth.busyProvider} onClick={() => void unpause()}>{tr("我已了解，恢复使用", "I understand, resume")}</button><button className="btn outline" onClick={() => setResume(false)}>{tr("取消", "Cancel")}</button>
    </div> : null}
  </section>;
}

/** Read-only checklist: never installs, signs in, refreshes OAuth or accepts a risk notice. */
function AntigravityReadiness({ context, visible, zh }: { context: ModelServiceContext; visible: boolean; zh: boolean }) {
  const { preview } = usePreviewMode();
  const tr = (zhText: string, enText: string) => zh ? zhText : enText;
  const [state, setState] = useState<ModelAntigravityReadiness>();
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const epoch = useRef(0);
  const supported = preview || modelServiceAvailable(context, "models.antigravity.readiness");
  const read = async () => {
    if (!visible || !supported) return;
    const generation = ++epoch.current;
    setLoading(true); setError("");
    try {
      const next = preview ? PREVIEW_ANTIGRAVITY_READINESS : await context.client!.query("models.antigravity.readiness", { sessionId: context.sessionId! });
      if (generation === epoch.current) setState(next);
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, tr("无法读取 Antigravity 状态", "Antigravity status unavailable"))); }
    finally { if (generation === epoch.current) setLoading(false); }
  };
  useEffect(() => { setState(undefined); void read(); return () => { epoch.current++; }; }, [visible, preview, context.client, context.sessionId, supported]);
  const steps: Array<{ ok: boolean | undefined; label: string; detail?: string | undefined }> = [
    { ok: state?.installed, label: tr("已安装 Antigravity CLI", "Antigravity CLI installed"), detail: state?.installed ? [state.version, state.source === "override" ? tr("自定义路径", "custom path") : state.source === "managed" ? tr("托管安装", "managed install") : undefined].filter(Boolean).join(" · ") : undefined },
    { ok: state?.authenticated, label: tr("已有登录凭据", "Signed-in credential found") },
    { ok: state?.bridgeReady, label: tr("工具桥接就绪", "Tool bridge ready"), detail: tr("Runtime 内置私有中继，无需安装 nc 或修改 PATH", "Uses the Runtime's private relay; no nc or PATH changes needed") },
  ];
  const statusText = !state ? undefined : ({
    ready: tr("本机条件已具备", "Ready on this machine"),
    "not-installed": tr("未安装", "Not installed"),
    "not-authenticated": tr("尚未登录", "Not signed in"),
    "bridge-unavailable": tr("桥接不可用", "Bridge unavailable"),
    error: tr("检查出错", "Check failed"),
  })[state.status];
  return <div className={`antigravity-ready is-${state?.status ?? "unknown"}`} aria-live="polite">
    <div className="antigravity-ready-head">
      <Icon name="plug" extra="sm" /><b>{tr("Antigravity ACP 就绪检查", "Antigravity ACP readiness")}</b>
      {statusText ? <span className={`chip xs ${state?.status === "ready" ? "green" : state?.status === "error" ? "red" : "amber"}`}>{statusText}</span> : null}
      <span className="spacer" />
      <button type="button" className="icon-btn small" aria-label={tr("重新检查", "Check again")} data-tip={tr("重新检查（只读，不会安装或登录）", "Check again (read-only; never installs or signs in)")} disabled={!supported || loading} onClick={() => void read()}>
        {loading ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" extra="sm" />}
      </button>
    </div>
    {!supported ? <p className="small muted">{tr("当前 Runtime 不提供 Antigravity 就绪检查。", "This Runtime does not report Antigravity readiness.")}</p> : <ol className="antigravity-steps">
      {steps.map(step => <li key={step.label} className={step.ok === undefined ? "is-unknown" : step.ok ? "is-ok" : "is-missing"}>
        <span className="antigravity-step-mark">{step.ok ? <Icon name="check" extra="sm" /> : step.ok === false ? <Icon name="x" extra="sm" /> : null}</span>
        <span><span>{step.label}</span>{step.detail ? <small>{step.detail}</small> : null}</span>
      </li>)}
    </ol>}
    {state?.error || error ? <p className="small antigravity-error" role="alert">{state?.error ?? error}</p> : null}
    <p className="tiny muted">{tr("这是 antigravity-acp 托管传输，不是可填写 base URL 的 HTTP 供应商。“就绪”只说明本机安装、凭据与桥接条件具备，不代表付费推理或额度已经验证。", "This is the managed antigravity-acp transport, not an HTTP provider with a base URL. “Ready” only means install, credential and bridge are in place; it does not mean paid inference or quota were verified.")}</p>
  </div>;
}
