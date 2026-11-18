import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
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

const inFlightReads = new WeakMap<StudioClient, Map<string, Promise<{ settings: FeatureSettingRow[] }>>>();

function readFeatureSettingsOnce(
  client: StudioClient,
  sessionId: string,
  invoke: <K extends keyof FeatureSettingsResultMap>(kind: K, input: CommandInput<K>) => Promise<FeatureSettingsResultMap[K]>,
): Promise<{ settings: FeatureSettingRow[] }> {
  let bySession = inFlightReads.get(client);
  if (!bySession) {
    bySession = new Map();
    inFlightReads.set(client, bySession);
  }
  const existing = bySession.get(sessionId);
  if (existing) return existing;
  const pending = invoke("preferences.features.get", { sessionId }).finally(() => {
    if (bySession?.get(sessionId) === pending) bySession.delete(sessionId);
  });
  bySession.set(sessionId, pending);
  return pending;
}

interface FeatureSettingsSharedState {
  readonly client: StudioClient | undefined;
  readonly sessionId: string | undefined;
  readonly preview: boolean;
  readonly rows: FeatureSettingRow[];
  readonly setRows: Dispatch<SetStateAction<FeatureSettingRow[]>>;
  readonly loading: boolean;
  readonly loadError: string;
  readonly busy: boolean;
  readonly setBusy: Dispatch<SetStateAction<boolean>>;
  readonly epochRef: MutableRefObject<number>;
  readonly lockRef: MutableRefObject<boolean>;
  readonly demoGlobalsRef: MutableRefObject<Partial<Record<FeatureSettingKey, FeatureSettingRow>>>;
  readonly refresh: () => Promise<void>;
  readonly invoke: <K extends keyof FeatureSettingsResultMap>(kind: K, input: CommandInput<K>) => Promise<FeatureSettingsResultMap[K]>;
}

const FeatureSettingsContext = createContext<FeatureSettingsSharedState | null>(null);

export function FeatureSettingsProvider({
  client,
  context,
  active,
  children,
}: {
  client?: StudioClient | undefined;
  context?: NativePreferencesContext | undefined;
  active: boolean;
  children: ReactNode;
}) {
  const { preview } = usePreviewMode();
  const [rows, setRows] = useState<FeatureSettingRow[]>(() => (preview ? structuredClone(PREVIEW_FEATURE_SETTINGS) : []));
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const epochRef = useRef(0);
  const lockRef = useRef(false);
  const loadedRef = useRef(preview);
  const demoGlobalsRef = useRef<Partial<Record<FeatureSettingKey, FeatureSettingRow>>>({});
  const ownerRef = useRef<{ client: StudioClient | undefined; sessionId: string | undefined; preview: boolean }>({
    client,
    sessionId: context?.sessionId,
    preview,
  });

  const supportsGet = preview || context?.capabilities?.capabilities.some(row => row.id === "preferences.features.get" && row.grade !== "unavailable") === true;
  const enabled = preview || !!(client && context?.available && context.sessionId && supportsGet);

  const invoke = useCallback(async <K extends keyof FeatureSettingsResultMap>(kind: K, input: CommandInput<K>): Promise<FeatureSettingsResultMap[K]> => {
    if (!client) throw Error("Runtime unavailable");
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: FeatureSettingsResultMap[K] }>(client, handle.requestId)).result;
  }, [client]);

  useEffect(() => {
    const sameOwner = ownerRef.current.client === client
      && ownerRef.current.sessionId === context?.sessionId
      && ownerRef.current.preview === preview;
    if (!sameOwner) {
      ownerRef.current = { client, sessionId: context?.sessionId, preview };
      epochRef.current += 1;
      lockRef.current = false;
      loadedRef.current = preview;
      demoGlobalsRef.current = {};
      setBusy(false);
      setLoading(false);
      setLoadError("");
      setRows(preview ? structuredClone(PREVIEW_FEATURE_SETTINGS) : []);
    }
    if (!preview && !enabled) {
      loadedRef.current = false;
      setLoading(false);
      setRows([]);
      return;
    }
    if (preview || !active || !enabled || !client || !context?.sessionId || loadedRef.current) return;
    const generation = ++epochRef.current;
    setLoading(true);
    setLoadError("");
    void readFeatureSettingsOnce(client, context.sessionId, invoke)
      .then((result) => {
        if (generation === epochRef.current) {
          loadedRef.current = true;
          setRows(result.settings);
        }
      })
      .catch((cause) => {
        if (generation === epochRef.current) setLoadError(hostErrorMessage(cause, "Cannot read settings"));
      })
      .finally(() => {
        if (generation === epochRef.current) setLoading(false);
      });
    return () => {
      if (!loadedRef.current) epochRef.current += 1;
    };
  }, [preview, enabled, active, client, context?.sessionId, invoke]);

  useEffect(() => () => {
    epochRef.current += 1;
  }, []);

  const refresh = useCallback(async () => {
    if (preview || !enabled || !context?.sessionId) return;
    const generation = epochRef.current;
    const result = await invoke("preferences.features.get", { sessionId: context.sessionId });
    if (generation === epochRef.current) {
      loadedRef.current = true;
      setRows(result.settings);
    }
  }, [preview, enabled, context?.sessionId, invoke]);

  const value = useMemo<FeatureSettingsSharedState>(() => ({
    client,
    sessionId: context?.sessionId,
    preview,
    rows,
    setRows,
    loading,
    loadError,
    busy,
    setBusy,
    epochRef,
    lockRef,
    demoGlobalsRef,
    refresh,
    invoke,
  }), [client, context?.sessionId, preview, rows, loading, loadError, busy, refresh, invoke]);

  return createElement(FeatureSettingsContext.Provider, { value }, children);
}

export function useFeatureSettings({ client, context, visible }: FeatureSettingsProps) {
  const { preview } = usePreviewMode();
  const shared = useContext(FeatureSettingsContext);
  const useShared = shared !== null
    && shared.client === client
    && shared.sessionId === context?.sessionId
    && shared.preview === preview;

  const [localRows, setLocalRows] = useState<FeatureSettingRow[]>(() => (preview ? structuredClone(PREVIEW_FEATURE_SETTINGS) : []));
  const [localBusy, setLocalBusy] = useState(false);
  const [localLoading, setLocalLoading] = useState(false);
  const [localLoadError, setLocalLoadError] = useState("");
  const [writeError, setWriteError] = useState("");
  const [notice, setNotice] = useState("");
  const localEpoch = useRef(0);
  const localLock = useRef(false);
  const localLoaded = useRef(preview);
  const localDemoGlobals = useRef<Partial<Record<FeatureSettingKey, FeatureSettingRow>>>({});
  const owner = useRef<{ client: StudioClient | undefined; sessionId: string | undefined; preview: boolean }>({
    client,
    sessionId: context?.sessionId,
    preview,
  });

  const supports = (kind: string) => preview || context?.capabilities?.capabilities.some(row => row.id === kind && row.grade !== "unavailable") === true;
  const enabled = preview || !!(client && context?.available && context.sessionId && supports("preferences.features.get"));

  const localInvoke = useCallback(async <K extends keyof FeatureSettingsResultMap>(kind: K, input: CommandInput<K>): Promise<FeatureSettingsResultMap[K]> => {
    if (!client) throw Error("Runtime unavailable");
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: FeatureSettingsResultMap[K] }>(client, handle.requestId)).result;
  }, [client]);

  useEffect(() => {
    setWriteError("");
    setNotice("");
  }, [client, context?.sessionId, preview, visible]);

  useEffect(() => {
    if (useShared) return;
    const sameOwner = owner.current.client === client
      && owner.current.sessionId === context?.sessionId
      && owner.current.preview === preview;
    if (!sameOwner) {
      owner.current = { client, sessionId: context?.sessionId, preview };
      localEpoch.current += 1;
      localLock.current = false;
      localLoaded.current = preview;
      localDemoGlobals.current = {};
      setLocalBusy(false);
      setLocalLoading(false);
      setLocalLoadError("");
      setLocalRows(preview ? structuredClone(PREVIEW_FEATURE_SETTINGS) : []);
    }
    if (!preview && !enabled) {
      localLoaded.current = false;
      setLocalLoading(false);
      setLocalRows([]);
      return;
    }
    if (preview || !enabled || !visible || !client || !context?.sessionId || localLoaded.current) return;
    const generation = ++localEpoch.current;
    setLocalLoading(true);
    setLocalLoadError("");
    void readFeatureSettingsOnce(client, context.sessionId, localInvoke)
      .then((result) => {
        if (generation === localEpoch.current) {
          localLoaded.current = true;
          setLocalRows(result.settings);
        }
      })
      .catch((cause) => {
        if (generation === localEpoch.current) setLocalLoadError(hostErrorMessage(cause, "Cannot read settings"));
      })
      .finally(() => {
        if (generation === localEpoch.current) setLocalLoading(false);
      });
    return () => {
      if (!localLoaded.current) localEpoch.current += 1;
    };
  }, [useShared, preview, enabled, visible, client, context?.sessionId, localInvoke]);

  useEffect(() => () => {
    localEpoch.current += 1;
  }, []);

  const localRefresh = useCallback(async () => {
    if (preview || !enabled || !context?.sessionId) return;
    const generation = localEpoch.current;
    const result = await localInvoke("preferences.features.get", { sessionId: context.sessionId });
    if (generation === localEpoch.current) {
      localLoaded.current = true;
      setLocalRows(result.settings);
    }
  }, [preview, enabled, context?.sessionId, localInvoke]);

  const rows = useShared ? shared.rows : localRows;
  const setRows = useShared ? shared.setRows : setLocalRows;
  const busy = useShared ? shared.busy : localBusy;
  const setBusy = useShared ? shared.setBusy : setLocalBusy;
  const loading = useShared ? shared.loading : localLoading;
  const error = writeError || (useShared ? shared.loadError : localLoadError);
  const epochRef = useShared ? shared.epochRef : localEpoch;
  const lockRef = useShared ? shared.lockRef : localLock;
  const demoGlobalsRef = useShared ? shared.demoGlobalsRef : localDemoGlobals;
  const invoke = useShared ? shared.invoke : localInvoke;
  const refresh = useShared ? shared.refresh : localRefresh;

  async function save(key: FeatureSettingKey, value: FeatureSettingValue, scope: "session" | "global") {
    if (lockRef.current || !enabled || !supports("preferences.features.set")) return;
    const generation = epochRef.current;
    lockRef.current = true;
    setBusy(true);
    setWriteError("");
    setNotice("");
    try {
      const previous = rows.find(row => row.key === key);
      let result: FeatureSettingRow;
      if (preview) {
        const keepSessionOverride = scope === "global" && previous?.source === "runtime";
        result = {
          key,
          value: keepSessionOverride ? previous.value : value,
          source: scope === "session" ? "runtime" : keepSessionOverride ? "runtime" : "global",
          ...(previous?.editableValues ? { editableValues: { ...previous.editableValues, [scope]: value } } : {}),
        };
        if (scope === "global") {
          demoGlobalsRef.current[key] = {
            key,
            value,
            source: "global",
            ...(previous?.editableValues ? { editableValues: { ...previous.editableValues, global: value } } : {}),
          };
        }
      } else {
        result = await invoke("preferences.features.set", { sessionId: context!.sessionId!, key, value, scope });
      }
      if (generation === epochRef.current) {
        setRows(current => current.map(row => row.key === key ? result : row));
        setNotice("saved");
      }
    } catch (cause) {
      if (generation === epochRef.current) setWriteError(hostErrorMessage(cause, "Cannot save settings"));
    } finally {
      if (generation === epochRef.current) {
        lockRef.current = false;
        setBusy(false);
      }
    }
  }

  async function clear(key: FeatureSettingKey) {
    if (lockRef.current || !enabled || !supports("preferences.features.clearOverride")) return;
    const generation = epochRef.current;
    lockRef.current = true;
    setBusy(true);
    setWriteError("");
    try {
      const previous = rows.find(row => row.key === key);
      const fallback = demoGlobalsRef.current[key] ?? structuredClone(PREVIEW_FEATURE_SETTINGS.find(row => row.key === key)!);
      const result: FeatureSettingRow = preview
        ? {
            ...fallback,
            ...(previous?.editableValues ? { editableValues: { ...previous.editableValues, session: null } } : {}),
          }
        : await invoke("preferences.features.clearOverride", { sessionId: context!.sessionId!, key });
      if (generation === epochRef.current) setRows(current => current.map(row => row.key === key ? result : row));
    } catch (cause) {
      if (generation === epochRef.current) setWriteError(hostErrorMessage(cause, "Cannot clear override"));
    } finally {
      if (generation === epochRef.current) {
        lockRef.current = false;
        setBusy(false);
      }
    }
  }

  return { rows, enabled, preview, supports, busy, loading, error, notice, save, clear, invoke, refresh };
}
