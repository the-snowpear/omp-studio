import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { ClientBootstrap, StudioClient } from "@omp-studio/client-contract";
import type { StudioRuntimeSettingsGetResult, StudioRuntimeSettingsSetResult } from "@omp-studio/studio-protocol";
import { useI18n } from "../../i18n";
import { waitReceipt } from "../../hostError";
import { PREVIEW_PROVIDER_LIMITS } from "../../preview/modelConfigFixtures";

const key = "providers.maxInFlightRequests";
type Limits = Record<string, number>;

export function useProviderLimits(client: StudioClient, sessionId: string | undefined, workspaceId: string | undefined,
  available: boolean, capabilities: ClientBootstrap["capabilityManifest"] | undefined, preview: boolean) {
  const [limits, setLimits] = useState<{ configured: Limits; effective: Limits }>();
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const supported = Boolean(available && sessionId && ["runtime.settings.get", "runtime.settings.set"].every(id =>
    capabilities?.capabilities.some(row => row.id === id && row.grade !== "unavailable")));
  useEffect(() => {
    const generation = ++epoch.current;
    setLimits(preview ? { configured: PREVIEW_PROVIDER_LIMITS, effective: PREVIEW_PROVIDER_LIMITS } : undefined);
    if (!preview && supported) void (async () => {
      const handle = await client.command("runtime.settings.get", { keys: [key] });
      const result = await waitReceipt<StudioRuntimeSettingsGetResult>(client, handle.requestId);
      const effective = result.values[key];
      if (epoch.current === generation && effective) setLimits({ configured: result.activation?.configured[key] ?? effective, effective });
    })().catch(() => { /* Older runtimes do not expose this native setting. */ });
    return () => { epoch.current++; };
  }, [client, sessionId, workspaceId, supported, preview, reload]);
  async function save(providerId: string, limit: number | undefined) {
    if (!limits) return;
    if (preview) {
      setLimits(previous => {
        const next = { ...previous?.configured };
        if (limit === undefined) delete next[providerId]; else next[providerId] = limit;
        return { configured: next, effective: next };
      });
      return;
    }
    const generation = epoch.current;
    const handle = await client.command("runtime.settings.set", { key, providerId, value: limit === undefined ? {} : { [providerId]: limit }, persist: true });
    const result = await waitReceipt<StudioRuntimeSettingsSetResult>(client, handle.requestId);
    if (generation === epoch.current) setLimits({ configured: result.value as Limits, effective: (result.effectiveValue ?? result.value) as Limits });
  }
  return { values: limits?.effective, configured: limits?.configured, save, retry: () => setReload(value => value + 1), supported };
}

export type ProviderLimitEdit = { dirty: boolean; save: () => Promise<boolean> };
export function ProviderLimitField({ providerId, limits, onDirtyChange, ref }: {
  providerId: string; limits: ReturnType<typeof useProviderLimits>; onDirtyChange: (dirty: boolean) => void; ref: Ref<ProviderLimitEdit>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const stored = limits.configured?.[providerId]?.toString() ?? "";
  const current = draft ?? stored;
  const dirty = current !== stored;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const invalid = current !== "" && (!Number.isSafeInteger(Number(current)) || Number(current) < 1);
  const pending = useRef(false);
  async function save() {
    if (invalid || pending.current || !limits.values) return false;
    pending.current = true;
    setBusy(true); setFailed(false);
    try { await limits.save(providerId, current === "" ? undefined : Number(current)); setDraft(undefined); return true; }
    catch { setFailed(true); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  useImperativeHandle(ref, () => ({ dirty, save }));
  return <div className="field provider-limit-field">
    <label htmlFor="f-inflight">{t("modelConfig.inFlightCapsLabel")}</label>
    <div className="provider-limit-controls">
      <input id="f-inflight" className="input" type="number" min={1} step={1} inputMode="numeric" disabled={!limits.values || busy}
        value={current} aria-invalid={invalid} aria-describedby="provider-limit-help" placeholder={limits.values ? t("modelConfig.inFlightCapsUnlimited") : "—"}
        onChange={event => { setDraft(event.target.value); setFailed(false); }} />
      {limits.values ? <button type="button" className="btn small" disabled={busy || invalid || !dirty} onClick={() => void save()}>{t("modelConfig.applyLimit")}</button>
        : limits.supported && <button type="button" className="btn small" onClick={limits.retry}>{t("common.retry")}</button>}
    </div>
    <span className="desc" id="provider-limit-help" role={failed || invalid ? "alert" : undefined}>{t(failed ? "modelConfig.inFlightCapsSaveFailed" : invalid ? "modelConfig.inFlightCapsInvalid" : limits.values ? "modelConfig.inFlightCapsDesc" : "modelConfig.inFlightCapsUnavailable")}</span>
  </div>;
}
