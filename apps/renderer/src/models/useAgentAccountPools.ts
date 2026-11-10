import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput, StudioClient } from "@omp-studio/client-contract";
import type { AgentAccountPoolState, FeatureSettingsResultMap, PoolAccountOption, ProviderAccountPools } from "@omp-studio/studio-protocol";
import type { NativePreferencesContext } from "../settings/NativePreferencesPane";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { createPreviewAccountPools, createPreviewPoolAccounts } from "../preview/agentAccountPoolsPreview";

type PoolCommand = "accounts.pool.get" | "accounts.pool.options" | "accounts.pool.set";
export type AccountPolicy = "default" | "selected" | "blocked";
export function sameAccountPools(a: ProviderAccountPools | null | undefined, b: ProviderAccountPools | null | undefined): boolean {
  const keys = Object.keys(a ?? {});
  return keys.length === Object.keys(b ?? {}).length && keys.every(key => {
    const left = a![key]!, right = b?.[key];
    return right !== undefined && left.length === right.length && left.every(value => right.includes(value));
  });
}

export function useAgentAccountPools({ client, context, preview, visible }: {
  client: StudioClient;
  context?: NativePreferencesContext | undefined;
  preview: boolean;
  visible: boolean;
}) {
  const [settings, setSettings] = useState<AgentAccountPoolState | null>(() => preview ? createPreviewAccountPools() : null);
  const [accounts, setAccounts] = useState<PoolAccountOption[]>(() => preview ? createPreviewPoolAccounts() : []);
  const [drafts, setDrafts] = useState<Record<string, ProviderAccountPools>>({});
  const [policies, setPolicies] = useState<Record<string, Record<string, AccountPolicy>>>({});
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const owner = useRef(0);
  const available = preview || !!(context?.available && context.sessionId && ["accounts.pool.get", "accounts.pool.set", "accounts.pool.options"].every(kind =>
    context.capabilities?.capabilities.some(item => item.id === kind && item.grade !== "unavailable")));
  const invoke = useCallback(async <K extends PoolCommand>(kind: K, input: CommandInput<K>): Promise<FeatureSettingsResultMap[K]> => {
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: FeatureSettingsResultMap[K] }>(client, handle.requestId)).result;
  }, [client]);

  useEffect(() => {
    owner.current++;
    setSettings(preview ? createPreviewAccountPools() : null);
    setAccounts(preview ? createPreviewPoolAccounts() : []);
    setDrafts({}); setPolicies({}); setError(""); setBusy(false); setTruncated(false);
    return () => { owner.current++; };
  }, [client, context?.sessionId, preview]);

  useEffect(() => {
    if (preview || !available || !visible) { setLoading(false); return; }
    let current = true;
    setLoading(true); setError("");
    void Promise.all([
      invoke("accounts.pool.get", { sessionId: context!.sessionId! }),
      invoke("accounts.pool.options", { sessionId: context!.sessionId! }),
    ]).then(([next, options]) => {
      if (!current) return;
      setSettings(next); setAccounts(options.accounts); setTruncated(options.truncated);
    }).catch(cause => { if (current) setError(hostErrorMessage(cause, "Cannot read account rules")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [available, visible, preview, invoke, context?.sessionId]);

  function value(agent: string): ProviderAccountPools { return drafts[agent] ?? settings?.global[agent] ?? {}; }
  function policy(agent: string, provider: string): AccountPolicy {
    const keys = value(agent)[provider];
    return policies[agent]?.[provider] ?? (keys === undefined ? "default" : keys.length ? "selected" : "blocked");
  }
  function invalid(agent: string): boolean {
    return Object.entries(policies[agent] ?? {}).some(([provider, mode]) => mode === "selected" && !value(agent)[provider]?.length);
  }
  function dirty(agent: string): boolean { return invalid(agent) || (drafts[agent] !== undefined && !sameAccountPools(drafts[agent], settings?.global[agent])); }
  function change(agent: string, provider: string, keys: string[] | undefined) {
    setDrafts(previous => {
      const next = { ...(previous[agent] ?? settings?.global[agent] ?? {}) };
      if (keys === undefined) delete next[provider]; else next[provider] = keys;
      return { ...previous, [agent]: next };
    });
  }
  function setPolicy(agent: string, provider: string, mode: AccountPolicy) {
    setPolicies(previous => ({ ...previous, [agent]: { ...previous[agent], [provider]: mode } }));
    change(agent, provider, mode === "default" ? undefined : mode === "blocked" ? [] : value(agent)[provider] ?? []);
  }
  function selectAccounts(agent: string, provider: string, keys: string[]) {
    setPolicies(previous => ({ ...previous, [agent]: { ...previous[agent], [provider]: "selected" } }));
    change(agent, provider, keys);
  }
  function discard(agent: string) {
    setDrafts(previous => { const next = { ...previous }; delete next[agent]; return next; });
    setPolicies(previous => { const next = { ...previous }; delete next[agent]; return next; });
  }
  async function save(agent: string): Promise<boolean> {
    if (!dirty(agent)) return false;
    const generation = owner.current, pools = value(agent);
    setBusy(true); setError("");
    try {
      let result: AgentAccountPoolState;
      if (preview) {
        const global = { ...settings!.global }, effective = { ...settings!.effective };
        if (Object.keys(pools).length) { global[agent] = pools; effective[agent] = pools; }
        else { delete global[agent]; delete effective[agent]; }
        result = { global, effective };
      } else {
        result = await invoke("accounts.pool.set", { sessionId: context!.sessionId!, agent, pools: Object.keys(pools).length ? pools : null });
      }
      if (generation !== owner.current) return false;
      setSettings(result); discard(agent);
      return !sameAccountPools(result.global[agent], result.effective[agent]);
    } catch (cause) {
      if (generation === owner.current) setError(hostErrorMessage(cause, "Cannot save account rules"));
      throw cause;
    } finally { if (generation === owner.current) setBusy(false); }
  }
  return { settings, accounts, loading, busy, error, available, truncated, value, policy, invalid, dirty, selectAccounts, setPolicy, discard, save,
    hasChanges: Object.keys(drafts).some(dirty) };
}

export type AgentAccountPoolsController = ReturnType<typeof useAgentAccountPools>;
