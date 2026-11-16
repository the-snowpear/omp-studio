import { useEffect, useState } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import { invokeUpgrade, useUpgradeAvailable } from "../runtimeUpgrade";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { useModelAuth, type ModelAuthController } from "./useModelAuth";

/** Credentials for native Judge runners. Liquid never becomes a chat-parameter form. */
export function RuntimeCredentials({ client, preview, providers = ["typesafe", "liquid"], visible = true, sessionId, available = false, capabilities, controller, onChanged }: {
  client: StudioClient | null; preview: boolean; providers?: readonly string[]; visible?: boolean;
  sessionId?: string | undefined; available?: boolean; capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
  controller?: ModelAuthController;
  onChanged?: () => void;
}) {
  const { t, resolvedLanguage } = useI18n(), { marks } = usePreviewMode();
  const own = useModelAuth({ client, sessionId, available, capabilities }, preview, visible && !controller);
  const auth = controller ?? own;
  const zh = resolvedLanguage === "zh";
  if (!visible) return null;
  return <section className="runtime-credentials">
    <h3>{zh ? "Judge 供应商凭据" : "Judge provider credentials"}{preview && marks ? ` · ${t("common.demo")}` : ""}</h3>
    <p className="sec-desc">{zh ? "凭据存入原生 AuthStorage。模型用于 Judge 角色及既有评测；Liquid SystemOne 接收 state/questions，不是聊天接口。" : "Credentials use native AuthStorage for the Judge role and existing evaluations. Liquid SystemOne accepts state/questions, not chat requests."}</p>
    {providers.map(provider => <CredentialRow key={provider} id={provider} auth={auth} onChanged={onChanged} />)}
    {auth.error ? <p role="alert">{auth.error}</p> : null}
  </section>;
}
function CredentialRow({ id, auth, onChanged }: { id: string; auth: ModelAuthController; onChanged?: (() => void) | undefined }) {
  const { t } = useI18n();
  const [key, setKey] = useState("");
  const provider = auth.providers?.find(row => row.id === id);
  const disabled = !auth.canEdit || !!auth.busyProvider || !provider?.available;
  useEffect(() => setKey(""), [id, auth.supported]);
  return <div className="runtime-credential-row">
    <strong>{provider?.name ?? id}</strong>
    <span className="small muted">{!auth.supported ? t("runtimeUpgrade.unavailable") : !provider ? t("common.loading") : provider.authenticated ? t("runtimeUpgrade.authConfigured") : t("runtimeUpgrade.authMissing")}</span>
    <input className="input" type="password" autoComplete="new-password" aria-label={`${provider?.name ?? id} ${t("runtimeUpgrade.authKey")}`} value={key} disabled={disabled} onChange={event => setKey(event.target.value)} />
    <button className="btn small" disabled={disabled || !key.trim()} onClick={() => { const secret = key; setKey(""); void auth.key(id, secret).then(saved => { if (saved) onChanged?.(); }); }}>{t("common.save")}</button>
    {provider?.credentials.filter(row => row.type === "api_key").map(row => <button className="btn small outline" key={row.id} disabled={disabled} aria-label={`${t("common.delete")} ${provider.name} ${row.label}`} onClick={() => void auth.key(id, undefined, row.id)}>{t("common.delete")} · {row.label}</button>)}
  </div>;
}
export function VisionModelStatus({ client, preview, visible = true }: { client: StudioClient | null; preview: boolean; visible?: boolean }) {
  const { t } = useI18n(), { marks } = usePreviewMode();
  const available = useUpgradeAvailable(visible ? client : null, preview, "session.models.mentions");
  const [image, setImage] = useState<boolean | null>(null);
  useEffect(() => {
    let closed = false; setImage(null);
    if (!visible) return;
    if (preview) { setImage(true); return; }
    if (client && available) void invokeUpgrade(client, "session.models.mentions", {}).then(result => { if (!closed) setImage(result.activeModelImage); }).catch(() => {});
    return () => { closed = true; };
  }, [client, preview, available, visible]);
  return <p className="small muted">{image === null ? t("runtimeUpgrade.unavailable") : image ? t("runtimeUpgrade.visionNative") : t("runtimeUpgrade.visionText")}{preview && marks ? " · " + t("common.demo") : ""}</p>;
}
