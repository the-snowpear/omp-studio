import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandInput, StudioClient, WebSearchProviderRecord } from "@omp-studio/client-contract";
import type { SearchCredentialStatus, SearchCredentialsResultMap } from "@omp-studio/studio-protocol";
import { useUpgradeAvailable } from "../runtimeUpgrade";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { previewSearchCredentials } from "../preview/modelConfigFixtures";

export function credentialProviders(provider: WebSearchProviderRecord): readonly string[] {
  return provider.credentialProviders ?? [...new Set([provider.apiKeyId, provider.loginId].filter((id): id is string => Boolean(id)))];
}

export function useSearchCredentials(client: StudioClient, preview: boolean, sessionId: string | undefined, visible: boolean, providers: readonly WebSearchProviderRecord[]) {
  const supported = useUpgradeAvailable(client, preview, "search.credentials.list");
  const available = preview || (supported && Boolean(sessionId));
  const [statuses, setStatuses] = useState<SearchCredentialStatus[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const readVersion = useRef(0);
  const previewCredentialId = useRef(-1);
  const providerKey = JSON.stringify([...new Set(providers.flatMap(provider => [...credentialProviders(provider)]))].sort());
  const invoke = useCallback(async <K extends keyof SearchCredentialsResultMap>(kind: K, input: CommandInput<K>) => {
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: SearchCredentialsResultMap[K] }>(client, handle.requestId)).result;
  }, [client]);
  const reload = useCallback(async () => {
    const current = generation.current;
    if (!available || preview) return;
    const request = ++readVersion.current;
    try {
      const result = await invoke("search.credentials.list", { sessionId: sessionId!, providers: JSON.parse(providerKey) as string[] });
      if (current === generation.current && request === readVersion.current) { setStatuses(result.providers); setError(""); }
    } catch (cause) {
      if (current === generation.current && request === readVersion.current) { setStatuses(undefined); setError(hostErrorMessage(cause, "Credential status unavailable")); }
    }
  }, [available, preview, sessionId, providerKey, invoke]);
  useEffect(() => {
    generation.current++;
    setStatuses(preview ? previewSearchCredentials(providers) : undefined);
    setError(""); setBusy(false);
    return () => { generation.current++; };
  }, [preview, sessionId, available, client, providerKey]);
  useEffect(() => {
    if (!preview && visible) void reload();
    const focus = () => { if (visible) void reload(); };
    window.addEventListener("focus", focus);
    return () => { window.removeEventListener("focus", focus); };
  }, [preview, visible, reload]);
  const update = async (provider: string, apiKey?: string, credentialId?: number) => {
    const current = generation.current;
    readVersion.current++;
    setBusy(true); setError("");
    try {
      let next: SearchCredentialStatus;
      if (preview) {
        const previous = statuses!.find(row => row.provider === provider)!;
        const credentials = apiKey !== undefined
          ? [...previous.credentials, { id: previewCredentialId.current--, label: "API key", type: "api_key" as const }]
          : previous.credentials.filter(row => row.id !== credentialId);
        next = { ...previous, credentials, configured: credentials.length > 0 || Boolean(previous.envVar),
          source: credentials.some(row => row.type === "oauth") ? "oauth" : credentials.length ? "api_key" : previous.envVar ? "env" : null };
      } else {
        next = apiKey !== undefined
          ? await invoke("search.credentials.set", { sessionId: sessionId!, provider, apiKey })
          : await invoke("search.credentials.remove", { sessionId: sessionId!, provider, credentialId: credentialId! });
      }
      if (current === generation.current) setStatuses(rows => rows?.map(row => row.provider === provider ? next : row));
      return current === generation.current;
    } catch (cause) {
      if (current === generation.current) setError(hostErrorMessage(cause, "Credential update failed"));
      return false;
    } finally { if (current === generation.current) setBusy(false); }
  };
  return { statuses: useMemo(() => new Map(statuses?.map(row => [row.provider, row])), [statuses]), loaded: statuses !== undefined, available, error, busy, reload,
    save: (provider: string, apiKey: string) => update(provider, apiKey),
    remove: (provider: string, credentialId: number) => update(provider, undefined, credentialId) };
}
