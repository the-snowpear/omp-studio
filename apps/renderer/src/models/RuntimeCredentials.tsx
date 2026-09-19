import { useEffect, useState } from "react";
import type { StudioClient, RuntimeAuthProvider } from "@omp-studio/client-contract";
import { invokeUpgrade, useUpgradeAvailable } from "../runtimeUpgrade";
import { useI18n } from "../i18n";
import { hostErrorMessage } from "../hostError";
export function RuntimeCredentials({ client, preview, providers = ["typesafe"] }: {
 client: StudioClient | null; preview: boolean; providers?: readonly RuntimeAuthProvider[];
}) {
 const { t } = useI18n();
 return <section className="runtime-credentials"><h3>{t("runtimeUpgrade.authTitle")}</h3><p className="sec-desc">{t("runtimeUpgrade.authHint")}</p>
 {providers.map(provider => <CredentialRow key={provider} provider={provider} client={client} preview={preview} />)}
 </section>;
}
function CredentialRow({ client, preview, provider }: { client: StudioClient | null; preview: boolean; provider: RuntimeAuthProvider }) {
 const { t } = useI18n();
 const available = useUpgradeAvailable(client, preview, "runtime.auth.set");
 const [configured, setConfigured] = useState<boolean | null>(null);
 const [key, setKey] = useState("");
 const [lastJudgment, setLastJudgment] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState("");
 useEffect(() => {
  let disposed = false;
  setKey(""); setConfigured(null); setError("");
  if (preview) { setConfigured(provider === "typesafe"); return; }
  if (client && available) void invokeUpgrade(client, "runtime.auth.get", {provider}).then(result => { if (!disposed) { setConfigured(result.configured); setLastJudgment(result.lastJudgment ? result.lastJudgment.provider + "/" + result.lastJudgment.model : null); } }).catch(cause => { if (!disposed) setError(hostErrorMessage(cause,"Credential status unavailable")); });
  return () => { disposed = true; };
 }, [client, available, preview, provider]);
 const save = async (remove: boolean) => {
  if (!available || busy) return;
  setBusy(true); setError("");
  const secret = key; setKey("");
  try {
   if (preview) setConfigured(!remove);
   else if (client) { const result = remove ? await invokeUpgrade(client,"runtime.auth.remove",{provider}) : await invokeUpgrade(client,"runtime.auth.set",{provider,apiKey:secret}); setConfigured(result.configured); }
  } catch(cause) { setError(hostErrorMessage(cause,"Credential update failed")); }
  finally { setBusy(false); }
 };
 return <div className="runtime-credential-row">
  <strong>{provider === "typesafe" ? "TypeSafe" : provider === "exa" ? "Exa" : "Ollama Cloud"}</strong>
  <span className="small muted">{!available ? t("runtimeUpgrade.unavailable") : configured === null ? t("common.loading") : configured ? t("runtimeUpgrade.authConfigured") : t("runtimeUpgrade.authMissing")}</span>
  {lastJudgment ? <span className="small muted">{t("runtimeUpgrade.lastJudgment")} {lastJudgment}</span> : null}
  {preview ? <span className="chip gray xs">{t("common.demo")}</span> : null}
  <input className="input" type="password" autoComplete="new-password" aria-label={provider + " " + t("runtimeUpgrade.authKey")} value={key} disabled={!available || busy} onChange={event => setKey(event.target.value)} />
  <button className="btn small" disabled={!available || busy || !key.trim()} onClick={() => void save(false)}>{t("common.save")}</button>
  <button className="btn small" disabled={!available || busy || !configured} onClick={() => void save(true)}>{t("common.delete")}</button>
  {provider === "exa" ? <button className="btn small" onClick={() => { if (!preview) void window.ompStudioChrome?.openUrl({ url: "https://dashboard.exa.ai/api-keys" }); }}>{t("runtimeUpgrade.authWebsite")}</button> : null}
  {error ? <p role="alert">{error}</p> : null}
 </div>;
}
export function VisionModelStatus({client,preview}:{client:StudioClient|null;preview:boolean}) {
 const {t}=useI18n();
 const available=useUpgradeAvailable(client,preview,"session.models.mentions");
 const [image,setImage]=useState<boolean|null>(null);
 useEffect(()=>{let closed=false;setImage(null);if(preview){setImage(true);return;}if(client&&available)void invokeUpgrade(client,"session.models.mentions",{}).then(result=>{if(!closed)setImage(result.activeModelImage);}).catch(()=>{});return()=>{closed=true;};},[client,preview,available]);
 return <p className="small muted">{image===null?t("runtimeUpgrade.unavailable"):image?t("runtimeUpgrade.visionNative"):t("runtimeUpgrade.visionText")}{preview?" · "+t("common.demo"):""}</p>;
}
