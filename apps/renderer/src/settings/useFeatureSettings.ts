import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput, StudioClient } from "@omp-studio/client-contract";
import type { FeatureSettingKey, FeatureSettingRow, FeatureSettingsResultMap, FeatureSettingValue } from "@omp-studio/studio-protocol";
import type { NativePreferencesContext } from "./NativePreferencesPane";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_FEATURE_SETTINGS } from "../preview/featureSettingsPreview";
import { hostErrorMessage, waitReceipt } from "../hostError";

export interface FeatureSettingsProps {
  client?: StudioClient | undefined;
  context?: NativePreferencesContext | undefined;
  visible: boolean;
}
export function useFeatureSettings({ client, context, visible }: FeatureSettingsProps) {
  const { preview } = usePreviewMode();
  const [rows, setRows] = useState<FeatureSettingRow[]>([]);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const epoch = useRef(0), lock = useRef(false);
  const supports = (kind: string) => preview || context?.capabilities?.capabilities.some(row => row.id === kind && row.grade !== "unavailable") === true;
  const enabled = preview || !!(client && context?.available && context.sessionId && supports("preferences.features.get"));
  const invoke = useCallback(async <K extends keyof FeatureSettingsResultMap>(kind: K, input: CommandInput<K>): Promise<FeatureSettingsResultMap[K]> => {
    if (!client) throw Error("Runtime unavailable");
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: FeatureSettingsResultMap[K] }>(client, handle.requestId)).result;
  }, [client]);
  useEffect(() => {
    const generation = ++epoch.current;
    lock.current = false; setBusy(false); setError(""); setNotice(""); setLoading(false);
    setRows(preview ? structuredClone(PREVIEW_FEATURE_SETTINGS) : []);
    if (!preview && enabled && visible && context?.sessionId) {
      setLoading(true);
      void invoke("preferences.features.get", { sessionId: context.sessionId }).then(result => {
        if (generation === epoch.current) setRows(result.settings);
      }).catch(cause => { if (generation === epoch.current) setError(hostErrorMessage(cause, "Cannot read settings")); })
        .finally(() => { if (generation === epoch.current) setLoading(false); });
    }
    return () => { epoch.current++; };
  }, [preview, enabled, visible, context?.sessionId, invoke]);
  async function save(key: FeatureSettingKey, value: FeatureSettingValue, scope: "session" | "global") {
    if (lock.current || !enabled || !supports("preferences.features.set")) return;
    const generation = epoch.current;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result: FeatureSettingRow = preview ? { key, value, source: scope === "session" ? "runtime" : "global" }
        : await invoke("preferences.features.set", { sessionId: context!.sessionId!, key, value, scope });
      if (generation === epoch.current) { setRows(current => current.map(row => row.key === key ? result : row)); setNotice("saved"); }
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, "Cannot save settings")); }
    finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  }
  async function clear(key: FeatureSettingKey) {
    if (lock.current || !enabled || !supports("preferences.features.clearOverride")) return;
    const generation = epoch.current; lock.current = true; setBusy(true); setError("");
    try {
      const result = preview ? structuredClone(PREVIEW_FEATURE_SETTINGS.find(row => row.key === key)!)
        : await invoke("preferences.features.clearOverride", { sessionId: context!.sessionId!, key });
      if (generation === epoch.current) setRows(current => current.map(row => row.key === key ? result : row));
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, "Cannot clear override")); }
    finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  }
  return { rows, enabled, preview, supports, busy, loading, error, notice, save, clear, invoke };
}
