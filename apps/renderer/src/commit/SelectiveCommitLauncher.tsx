import { createContext, useContext, type ReactNode } from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";

/** Lets Git and Changes open the session's selective-commit panel without owning it. */
export interface SelectiveCommitLauncher {
  readonly open: () => void;
  /** Disabled reason; undefined when a draft can be prepared now. */
  readonly blocked?: string | undefined;
}

const LauncherContext = createContext<SelectiveCommitLauncher | null>(null);

export function SelectiveCommitLauncherProvider({ value, children }: { value: SelectiveCommitLauncher | null; children: ReactNode }) {
  return <LauncherContext.Provider value={value}>{children}</LauncherContext.Provider>;
}

export function useSelectiveCommitLauncher(): SelectiveCommitLauncher | null {
  return useContext(LauncherContext);
}

/** Compact entry shared by the Git commit box and the Changes header. */
export function SelectiveCommitButton({ variant = "button" }: { variant?: "button" | "icon" }) {
  const launcher = useSelectiveCommitLauncher();
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  if (!launcher) return null;
  const label = zh ? "按归属挑选提交" : "Pick by ownership";
  const tip = launcher.blocked ?? (zh ? "打开选择性提交：Runtime 预选本会话的改动，确认前冻结预览" : "Open selective commit: the Runtime preselects this session's edits and freezes a preview first");
  if (variant === "icon") {
    return <button type="button" className="icon-btn small scm-launch" aria-label={label} data-tip={tip} aria-disabled={launcher.blocked ? true : undefined}
      onClick={() => { if (!launcher.blocked) launcher.open(); }}><Icon name="commit" extra="sm" /></button>;
  }
  return <button type="button" className="btn small outline scm-launch" data-tip={tip} aria-disabled={launcher.blocked ? true : undefined}
    onClick={() => { if (!launcher.blocked) launcher.open(); }}><Icon name="commit" extra="sm" />{label}</button>;
}
