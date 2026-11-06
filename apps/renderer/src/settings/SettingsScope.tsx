import { createContext, useContext, useState, type ReactNode } from "react";

export type SettingsScope = "global" | "session";
type ScopeState = [SettingsScope, (scope: SettingsScope) => void];
const ScopeContext = createContext<ScopeState | null>(null);

/** Settings pages share one choice; standalone session tools retain their own default. */
export function SettingsScopeProvider({ children }: { children: ReactNode }) {
  const state = useState<SettingsScope>("global");
  return <ScopeContext.Provider value={state}>{children}</ScopeContext.Provider>;
}

export function useSettingsScope(fallback: SettingsScope = "global"): ScopeState {
  const shared = useContext(ScopeContext);
  const local = useState<SettingsScope>(fallback);
  return shared ?? local;
}

export function useHasSettingsScope(): boolean {
  return useContext(ScopeContext) !== null;
}
