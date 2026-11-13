import { useEffect, useRef, useState } from "react";
import type { ModelProviderRoster } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewProviderRoster } from "../preview/modelServicesPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { modelServiceAvailable, type ModelAuthController, type ModelServiceContext } from "./useModelAuth";
import { ModelSystemTemplateInspector } from "./ModelSystemTemplates";
import "./modelServices.css";

/** A focused native-provider workflow, not a static catalog pretending to be an authorized workspace roster. */
export function NativeModelAccessPane({ context, auth, visible, onChanged, accounts = false }: {
  context: ModelServiceContext; auth: ModelAuthController; visible: boolean; onChanged?: () => void; accounts?: boolean;
}) {
  const { preview, marks } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [selected, setSelected] = useState("");
  const [roster, setRoster] = useState<ModelProviderRoster>();
  const [inspected, setInspected] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [risk, setRisk] = useState(false), [riskAnswer, setRiskAnswer] = useState("");
  const epoch = useRef(0), lock = useRef(false);
  const provider = auth.providers?.find(row => row.id === selected);
  useEffect(() => {
    if (!selected && auth.providers?.length) setSelected(auth.providers[0]!.id);
  }, [auth.providers, selected]);
  useEffect(() => {
    epoch.current++; setRoster(undefined); setInspected(""); setError(""); setBusy(false); lock.current = false; setRisk(false); setRiskAnswer("");
    return () => { epoch.current++; };
  }, [visible, context.client, context.sessionId, preview, selected]);
  const canRefresh = preview || modelServiceAvailable(context, "models.provider.roster.refresh");
  const refresh = async () => {
    if (!visible || !selected || !canRefresh || lock.current) return;
    const generation = epoch.current; lock.current = true; setBusy(true); setError(""); setInspected("");
    try {
      let next: ModelProviderRoster;
      if (preview) next = previewProviderRoster(selected);
      else {
        const handle = await context.client!.command("models.provider.roster.refresh", { sessionId: context.sessionId!, providerId: selected });
        next = await waitReceipt<ModelProviderRoster>(context.client!, handle.requestId, 45000);
      }
      if (generation === epoch.current) { setRoster(next); onChanged?.(); }
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "无法读取原生目录" : "Native roster unavailable")); }
    finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  };
  const login = async () => {
    if (!provider || !visible) return;
    if (preview && provider.warning && !risk) { setRisk(true); setRiskAnswer(""); return; }
    if (risk && riskAnswer.trim().toLowerCase() !== "yes") return;
    setRisk(false);
    if (await auth.login(selected)) onChanged?.();
  };
  if (!visible) return null;
  return <section className="model-native-access mp-sec">
    <h3>{accounts ? zh ? "原生登录与凭据" : "Native sign-in and credentials" : zh ? "原生供应商目录" : "Native provider roster"}{preview && marks ? zh ? " · 演示" : " · Demo" : ""}</h3>
    <p className="sec-desc">{zh ? "登录、风险确认与模型发现沿用当前 Runtime。Otari 等授权目录只显示该凭据实际获得的模型，不导入其他工作区的缓存。" : "Sign-in, risk challenges and discovery use this Runtime. Authorized rosters such as Otari show only models granted to this credential, never another workspace's cache."}</p>
    <div className="model-native-toolbar">
      <AppSelect className="select" aria-label={zh ? "原生供应商" : "Native provider"} value={selected} disabled={!auth.providers?.length || busy || !!auth.busyProvider} onChange={event => setSelected(event.target.value)}>
        {!auth.providers?.length ? <option value="">{auth.supported ? zh ? "正在读取…" : "Loading…" : zh ? "原生授权不可用" : "Native auth unavailable"}</option> : null}
        {auth.providers?.map(row => <option key={row.id} value={row.id}>{row.name} · {row.id}</option>)}
      </AppSelect>
      <span className="small muted">{provider ? provider.authenticated ? zh ? "凭据已配置" : "Credential configured" : zh ? "未配置凭据" : "No credential configured" : zh ? "状态未知" : "Status unknown"}</span>
      <button className="btn small outline" disabled={!auth.canLogin || !provider?.available || !!auth.busyProvider || busy} onClick={() => void login()}><Icon name="key" extra="sm" />{zh ? "原生登录" : "Native sign-in"}</button>
      {!accounts ? <button className="btn small outline" disabled={!provider || !canRefresh || busy || !!auth.busyProvider} onClick={() => void refresh()}><Icon name="refresh" extra="sm" />{zh ? "刷新授权目录" : "Refresh authorized roster"}</button> : null}
      {auth.busyProvider ? <button className="btn small outline" onClick={() => void auth.cancel()}>{zh ? "取消登录" : "Cancel sign-in"}</button> : null}
    </div>
    {provider?.warning ? <p className="model-native-warning"><Icon name="alert" extra="sm" /><span>{provider.warning}</span></p> : null}
    {!auth.supported ? <p className="small muted">{zh ? "连接支持原生 GUI challenge 的 Runtime 后可操作；没有读取模型时保持空态。" : "Connect a Runtime with the native GUI challenge channel to continue. No read model is substituted."}</p> : null}
    {auth.error || error ? <p role="alert">{error || auth.error}</p> : null}
    {roster ? <div className="model-native-roster">
      <p className="small muted">{roster.providerId} · {roster.authoritative ? zh ? "凭据授权的原生目录" : "Native authoritative roster" : zh ? "当前原生目录" : "Current native roster"}{roster.error ? ` · ${roster.error}` : ""}</p>
      {roster.models.map(model => <div className="model-native-model" key={model.selector}>
        <span><b>{model.name}</b><code>{model.selector}</code></span><span className="chip gray xs">{model.kind}</span><code>{model.api}</code>
        <span className="small muted">{model.contextWindow === undefined ? zh ? "上下文未知" : "Context unknown" : `${model.contextWindow.toLocaleString()} tokens`}</span>
        {model.kind === "chat" ? <button className="btn small outline" onClick={() => setInspected(model.selector)}>{zh ? "系统提示详情" : "System prompt details"}</button> : <span className="small muted">{zh ? "用于对应原生角色，不作为聊天参数" : "Native role runner, not chat parameters"}</span>}
      </div>)}
      {roster.truncated ? <p className="small muted">{zh ? `当前显示前 ${roster.models.length} / ${roster.total ?? "未知"} 个授权模型；角色选择器仍读取完整的有界分页目录。` : `Showing the first ${roster.models.length} / ${roster.total ?? "unknown"} authorized models. Role pickers still read the bounded paginated catalog.`}</p> : null}
      {!roster.models.length ? <p className="small muted">{roster.authenticated ? zh ? "当前授权未报告模型。该供应商也可能只提供凭据或搜索服务。" : "This credential reported no models. The provider may supply credentials or search services only." : zh ? "没有该供应商的原生授权目录。" : "No authorized native roster for this provider."}</p> : null}
    </div> : null}
    {inspected ? <ModelSystemTemplateInspector context={context} selector={inspected} visible={visible} /> : null}
    {risk ? <div className="session-options-confirm" role="dialog" aria-label={zh ? "原生登录风险确认" : "Native login risk confirmation"}>
      <strong>{provider?.name}</strong><p>{provider?.warning}</p><label>{zh ? "输入 yes 接受风险" : "Type yes to accept the risk"}<input className="input" autoFocus value={riskAnswer} onChange={event => setRiskAnswer(event.target.value)} /></label>
      <button className="btn danger" disabled={riskAnswer.trim().toLowerCase() !== "yes"} onClick={() => void login()}>{zh ? "继续登录" : "Continue sign-in"}</button><button className="btn outline" onClick={() => setRisk(false)}>{zh ? "取消" : "Cancel"}</button>
    </div> : null}
  </section>;
}
